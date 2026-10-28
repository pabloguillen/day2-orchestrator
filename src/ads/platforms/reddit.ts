/**
 * Reddit — Reddit Ads API v3, https://ads-api.reddit.com/api/v3
 * Docs: https://ads-api.reddit.com/docs/v3/ (read via its public mirror
 * https://ads-api-reddit.netlify.app/docs/v3/ — the official host was not reachable
 * from the research environment).
 *
 * Auth: OAuth2 refresh token from a Reddit developer app (scopes adsread, adsedit,
 * adsconversions; duration=permanent) against https://www.reddit.com/api/v1/access_token
 * with HTTP Basic client credentials. Every call (token and API) sends a descriptive
 * User-Agent, as Reddit requires.
 *
 * Launch flow (all from the configured ad account; ads run as the app's profile):
 *   checks: account currency matches the spec and the account can spend; the profile
 *           is linked to the ad account; pixel + funding instrument resolved
 *   per creative: structured post job on the profile (Reddit fetches the media from
 *                 day2's public asset URL; destination = the creative's own link) →
 *                 poll the job until SUCCESS → post_id
 *   campaign (PAUSED; objective CLICKS = "Traffic", or CONVERSIONS for sign-ups) →
 *   ad group (daily budget in micro-currency, countries) → ads (post_id + click_url) →
 *   campaign ACTIVE.
 *
 * The campaign is the single on/off switch: it stays PAUSED until every child
 * exists. If anything fails after it was created it is ARCHIVED (Reddit only
 * allows DELETE three hours after the last change; ARCHIVED stops it for good)
 * and the error is rethrown as PlatformError.
 *
 * Conversions: Conversions API v3, POST /pixels/{pixel_id}/conversion_events with
 * {data:{events:[…]}}, event_at in epoch ms, click_id (rdt_cid), metadata.conversion_id
 * for dedup, user.external_id (SHA-256), user.ip_address / user.user_agent — per
 * https://ads-api-reddit.netlify.app/docs/v3/guides/programs/capi/direct-integration and
 * …/capi/migration. The API can list pixels but documents no "create pixel" call, so
 * ensureConversions finds the ad account's pixel and fails clearly when there is none.
 *
 * Not publicly documented in a machine-readable way (request/response schemas on
 * the v3 reference pages render client-side only): field-level shapes follow the
 * documented paths, the official setup/migration guides, and three open-source
 * clients on npm (@filippofinke/reddit-ads-mcp, mcp-server-reddit-ads,
 * @adport/provider-reddit) — not Reddit's own text. Where a shape is uncertain we
 * fail loudly instead of guessing:
 *   - age / language / interest targeting are not sent (no documented age field;
 *     interests need Reddit taxonomy ids);
 *   - text-only ads are refused (Reddit needs an image or video post for a link ad);
 *   - profiles cannot be created through the API, so identity is "app_account".
 */
import { createHash } from "node:crypto";
import { fit, poll, request, tokenCache, type RequestInit2 } from "../http";
import {
  PlatformError,
  type AdAccountInfo,
  type AdPlatform,
  type AdStats,
  type Asset,
  type CallToAction,
  type CampaignStatus,
  type Conversion,
  type ConversionSetup,
  type Identity,
  type Launched,
  type LaunchSpec,
  type PlatformDeps,
  type PlatformInfo,
} from "../types";

export const BASE = "https://ads-api.reddit.com/api/v3";
export const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
export const DEFAULT_USER_AGENT = "server:day2-ads:1.0 (by day2)";

const MICRO = 1_000_000;
const MIN_DAILY_USD = 5;
const HEADLINE_MAX = 300;
const AI_TAG = " (AI presenter)";
/** Conversions API: events must arrive within 7 days; at most 1,000 events per request. */
const CAPI_MAX_AGE_MS = 7 * 86_400_000;
const CAPI_BATCH = 1000;
export const CLICK_ID_PARAM = "rdt_cid";

export type RedditCreds = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Ads API ad account id, e.g. "a2_abc123" (or a legacy "t2_…"). */
  adAccountId: string;
  userAgent: string;
  /** Optional: which funding instrument new campaigns bill to (else the account's only/first servable one). */
  fundingInstrumentId?: string;
  /** Called when Reddit rotates the refresh token (day2's registry persists it encrypted). */
  onRefreshToken?: (token: string) => void | Promise<void>;
};

export const info: PlatformInfo = {
  id: "reddit",
  name: "Reddit",
  formats: [
    { kind: "image", ratio: "1:1", width: 1080, height: 1080, maxBytes: 3_000_000, mimes: ["image/jpeg", "image/png"] },
    { kind: "image", ratio: "4:5", width: 1080, height: 1350, maxBytes: 3_000_000, mimes: ["image/jpeg", "image/png"] },
    { kind: "image", ratio: "16:9", width: 1920, height: 1080, maxBytes: 3_000_000, mimes: ["image/jpeg", "image/png"] },
    { kind: "video", ratio: "1:1", width: 1080, height: 1080, minDurationSec: 5, maxDurationSec: 900, maxBytes: 1_000_000_000, mimes: ["video/mp4", "video/quicktime"] },
    { kind: "video", ratio: "4:5", width: 1080, height: 1350, minDurationSec: 5, maxDurationSec: 900, maxBytes: 1_000_000_000, mimes: ["video/mp4", "video/quicktime"] },
    { kind: "video", ratio: "16:9", width: 1920, height: 1080, minDurationSec: 5, maxDurationSec: 900, maxBytes: 1_000_000_000, mimes: ["video/mp4", "video/quicktime"] },
  ],
  textOnly: false,
  // The headline is the post title (300 chars). Image/video promoted posts have no
  // caption field, so `body` is not shown; an AI-presenter disclosure is carried in the headline.
  copyLimits: { headline: HEADLINE_MAX, body: HEADLINE_MAX },
  minDailyUsd: MIN_DAILY_USD,
  clickIdParam: CLICK_ID_PARAM,
  identity: "app_account",
  identityHelp:
    "The app's Reddit profile (a brand/business profile, id t2_…) must be added to day2's Reddit Ads business and linked to day2's ad account in Ads Manager; store its profile id as the identity ref.",
  audiences: ["consumer", "business"],
  env: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_REFRESH_TOKEN", "REDDIT_AD_ACCOUNT_ID", "REDDIT_USER_AGENT (optional)", "REDDIT_FUNDING_INSTRUMENT_ID (optional)"],
  apiVersion: "v3",
};

export function credentialsFromEnv(env: Record<string, string | undefined>): RedditCreds | null {
  const clientId = env.REDDIT_CLIENT_ID?.trim();
  const clientSecret = env.REDDIT_CLIENT_SECRET?.trim();
  const refreshToken = env.REDDIT_REFRESH_TOKEN?.trim();
  const adAccountId = env.REDDIT_AD_ACCOUNT_ID?.trim();
  if (!clientId || !clientSecret || !refreshToken || !adAccountId) return null;
  const fundingInstrumentId = env.REDDIT_FUNDING_INSTRUMENT_ID?.trim();
  return {
    clientId,
    clientSecret,
    refreshToken,
    adAccountId,
    userAgent: env.REDDIT_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    ...(fundingInstrumentId ? { fundingInstrumentId } : {}),
  };
}

/** Reddit's destination call_to_action takes display strings. It has no "Get Started"; "Learn More" is the neutral fit. */
export const CTA: Record<CallToAction, string> = {
  learn_more: "Learn More",
  sign_up: "Sign Up",
  download: "Download",
  get_started: "Learn More",
};

type Envelope<T> = { data?: T; pagination?: { next_url?: string | null } };
type Entity = { id: string; configured_status?: string; effective_status?: string; rejection_reason?: string | null; name?: string };
type Job = { id?: string; status?: string; post_id?: string; post?: { id?: string }; error_message?: string; message?: string; errors?: unknown; error?: unknown };
type RawAccount = { id?: string; name?: string; currency?: string; admin_approval?: string | null; suspension_reason?: string | null; status?: string | null };
type Metric = { ad_id?: string; spend?: number; impressions?: number; clicks?: number };

const err = (message: string, status?: number, retryable = false) => new PlatformError("reddit", message, status, retryable);

/**
 * Whether an ad account can run ads, from the fields Reddit returns on it
 * (admin_approval / suspension_reason — field names from the npm clients, enum
 * values not documented, so anything clearly negative blocks).
 */
export function accountState(a: RawAccount): { canSpend: boolean; problem?: string } {
  if (a.suspension_reason) return { canSpend: false, problem: `suspended by Reddit (${a.suspension_reason})` };
  const approval = String(a.admin_approval ?? "").toUpperCase();
  if (/REJECT|DISAPPROV|SUSPEND|BANNED|DENIED/.test(approval)) return { canSpend: false, problem: `not approved by Reddit (${approval})` };
  if (/PENDING|REVIEW/.test(approval)) return { canSpend: false, problem: "awaiting Reddit's approval" };
  const status = String(a.status ?? "").toUpperCase();
  if (/SUSPEND|CLOSED|DISABLED|INACTIVE/.test(status)) return { canSpend: false, problem: `account is ${status.toLowerCase()}` };
  return { canSpend: true };
}

/** Maps Reddit configured/effective statuses onto day2's. */
export function mapStatus(s: string | undefined | null): CampaignStatus {
  switch ((s ?? "").toUpperCase()) {
    case "ACTIVE":
    case "SERVING":
      return "active";
    case "PAUSED":
      return "paused";
    case "PENDING_APPROVAL":
    case "PENDING_REVIEW":
    case "IN_REVIEW":
    case "UNDER_REVIEW":
    case "PENDING":
      return "in_review";
    case "REJECTED":
    case "DISAPPROVED":
      return "rejected";
    case "COMPLETED":
    case "ENDED":
    case "ARCHIVED":
    case "DELETED":
      return "ended";
    default:
      return "unknown";
  }
}

/** Reddit timestamps: second precision with an explicit +00:00 offset. */
const isoSec = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
/** Reports are hourly: floor/ceil to the hour, "Z" form. */
const hourFloor = (d: Date) => new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000);
const hourCeil = (d: Date) => new Date(Math.ceil(d.getTime() / 3_600_000) * 3_600_000);
const hourIso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export function create(creds: RedditCreds, deps: PlatformDeps = {}): AdPlatform {
  const now = () => (deps.now ? deps.now() : new Date());
  const ua = creds.userAgent || DEFAULT_USER_AGENT;
  const acct = encodeURIComponent(creds.adAccountId);
  let refreshToken = creds.refreshToken;

  const token = tokenCache(async () => {
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
    const r = await request<{ access_token?: string; expires_in?: number; refresh_token?: string; error?: string }>("reddit", deps, TOKEN_URL, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "user-agent": ua },
      form: { grant_type: "refresh_token", refresh_token: refreshToken },
    });
    if (!r?.access_token) throw err(`OAuth refresh failed${r?.error ? ` (${r.error})` : ""}: no access_token returned`, 401);
    if (r.refresh_token && r.refresh_token !== refreshToken) {
      refreshToken = r.refresh_token;
      await Promise.resolve(creds.onRefreshToken?.(r.refresh_token)).catch(() => {});
    }
    return { accessToken: r.access_token, expiresInSec: r.expires_in ?? 3600 };
  }, () => now().getTime());

  async function api<T>(path: string, init: RequestInit2 = {}): Promise<Envelope<T>> {
    const url = path.startsWith("https://") ? path : `${BASE}${path}`;
    if (!url.startsWith(`${BASE}/`)) throw err(`refusing to call a non Ads API URL`);
    const res = await request<Envelope<T>>("reddit", deps, url, {
      ...init,
      headers: { authorization: `Bearer ${await token()}`, "user-agent": ua, accept: "application/json", ...(init.headers ?? {}) },
    });
    return res ?? {};
  }

  async function list<T>(path: string, query: RequestInit2["query"] = {}, maxPages = 10): Promise<T[]> {
    const out: T[] = [];
    let page = await api<T[]>(path, { query: { ...query, "page.size": 1000 } });
    for (let i = 0; ; i++) {
      out.push(...(Array.isArray(page.data) ? page.data : []));
      const next = page.pagination?.next_url;
      if (!next || i + 1 >= maxPages) return out;
      page = await api<T[]>(next);
    }
  }

  const need = <T extends { id?: string }>(res: Envelope<T>, what: string): T & { id: string } => {
    const d = res.data;
    if (!d?.id) throw err(`${what}: no id in response`);
    return d as T & { id: string };
  };

  let pixelId: string | undefined;
  async function pixel(): Promise<string> {
    if (pixelId) return pixelId;
    const pixels = await list<{ id?: string }>(`/ad_accounts/${acct}/pixels`, {}, 1);
    const id = pixels.find((p) => p.id)?.id;
    if (!id) throw err(`ad account ${creds.adAccountId} has no conversion pixel; Reddit requires conversion_pixel_id on every ad group (since 2026-07-13). Create one in Ads Manager → Events Manager.`);
    return (pixelId = id);
  }

  let fundingId: string | undefined = creds.fundingInstrumentId;
  async function funding(): Promise<string> {
    if (fundingId) return fundingId;
    const items = await list<{ id?: string; is_servable?: boolean; end_time?: string | null }>(`/ad_accounts/${acct}/funding_instruments`, {}, 1);
    const t = now().getTime();
    const usable = items.filter((f) => f.id && f.is_servable !== false && !(f.end_time && Date.parse(f.end_time) < t));
    if (!usable.length) throw err(`ad account ${creds.adAccountId} has no usable funding instrument; add a payment method in Reddit Ads Manager (or set REDDIT_FUNDING_INSTRUMENT_ID).`);
    return (fundingId = usable[0]!.id!);
  }

  async function profileProblem(profileId: string): Promise<string | undefined> {
    const profiles = await list<{ id?: string }>(`/ad_accounts/${acct}/profiles`, {}, 5);
    return profiles.some((p) => p.id === profileId) ? undefined : `profile ${profileId} is not linked to ad account ${creds.adAccountId}. ${info.identityHelp}`;
  }

  let account: AdAccountInfo | undefined;
  async function accountInfo(): Promise<AdAccountInfo> {
    const a = (await api<RawAccount>(`/ad_accounts/${acct}`)).data ?? {};
    const currency = String(a.currency ?? "").toUpperCase();
    if (!currency) throw err(`ad account ${creds.adAccountId}: no currency in response`);
    let state = accountState(a);
    if (state.canSpend) {
      try {
        await funding();
      } catch (e) {
        if (!(e instanceof PlatformError) || e.retryable) throw e;
        state = { canSpend: false, problem: "no usable payment method (funding instrument) on the ad account" };
      }
    }
    account = { id: a.id ?? creds.adAccountId, name: a.name ?? creds.adAccountId, currency, canSpend: state.canSpend, ...(state.problem ? { problem: state.problem } : {}) };
    return account;
  }
  const currency = async () => (account ?? (await accountInfo())).currency;

  function headlineFor(headline: string, asset: Asset): string {
    if (!asset.aiPerson || /\bAI\b/.test(headline)) return fit(headline, HEADLINE_MAX);
    return `${fit(headline, HEADLINE_MAX - AI_TAG.length)}${AI_TAG}`;
  }

  /** Creates the promoted post on the app's profile; Reddit fetches the media from day2's public URL. */
  async function createPost(spec: LaunchSpec, profileId: string, c: LaunchSpec["creatives"][number]): Promise<string> {
    const a = c.asset!;
    const link = c.link ?? spec.link;
    const destination = { type: "URL", url: link, display_url: new URL(link).hostname, call_to_action: CTA[c.copy.cta] };
    const headline = headlineFor(c.copy.headline, a);
    const creative =
      a.kind === "image"
        ? { type: "IMAGE", headline, image: { media: { type: "URL", url: a.url } }, destination }
        : { type: "VIDEO", headline, video: { media: { type: "URL", url: a.url } }, thumbnail: { media: { type: "URL", url: a.thumbnail!.url } }, destination };
    const job = need(await api<Job>(`/profiles/${encodeURIComponent(profileId)}/structured_posts/jobs`, { method: "POST", json: { data: { allow_comments: false, creative } } }), `post job for ${c.key}`);
    return poll(
      deps,
      async () => {
        const j = (await api<Job>(`/structured_posts/jobs/${encodeURIComponent(job.id)}`)).data ?? {};
        const status = String(j.status ?? "").toUpperCase();
        if (status === "SUCCESS") {
          const postId = j.post_id ?? j.post?.id;
          if (!postId) throw err(`post job ${job.id} succeeded without a post_id`);
          return postId;
        }
        if (status === "CLIENT_ERROR") throw err(`post for ${c.key} rejected: ${detail(j)}`, 400);
        if (status === "SERVER_ERROR") throw err(`post for ${c.key} failed on Reddit's side: ${detail(j)}`, 500, true);
        return undefined;
      },
      { platform: "reddit", what: `post for ${c.key}`, everyMs: 2000, timeoutMs: 10 * 60_000 },
    );
  }

  async function setCampaignStatus(campaignId: string, status: "ACTIVE" | "PAUSED" | "ARCHIVED"): Promise<void> {
    await api(`/campaigns/${encodeURIComponent(campaignId)}`, { method: "PATCH", json: { data: { configured_status: status } } });
  }

  function checkLink(link: string, key?: string): void {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw err(`invalid landing URL${key ? ` for ${key}` : ""}`);
    }
    if (url.protocol !== "https:") throw err(`Reddit needs an https landing URL${key ? ` (${key})` : ""}`);
  }

  /** Budgets are in the account's currency. The $5 floor is Reddit's USD minimum; other currencies are left to Reddit's own check. */
  function checkBudget(amount: number, cur: string): void {
    if (!Number.isFinite(amount) || amount <= 0) throw err(`daily budget ${amount} ${cur} is not a positive amount`);
    if (cur.toUpperCase() === "USD" && amount < MIN_DAILY_USD) throw err(`daily budget $${amount} is below Reddit's $${MIN_DAILY_USD} minimum`);
  }

  function validate(spec: LaunchSpec): void {
    if (!spec.identity?.ref) throw err(`launch needs the app's Reddit profile as identity. ${info.identityHelp}`);
    checkBudget(spec.dailyBudget, spec.currency);
    if (spec.optimizeFor === "signups" && !spec.conversion?.refs.pixelId) throw err("optimizing for sign-ups needs the conversion setup from ensureConversions (pixelId)");
    if (!spec.targeting.countries.length) throw err("at least one target country is required");
    const badCountry = spec.targeting.countries.find((c) => !/^[A-Za-z]{2}$/.test(c.trim()));
    if (badCountry !== undefined) throw err(`"${badCountry}" is not an ISO 3166-1 alpha-2 country code`);
    if (!spec.creatives.length) throw err("no creatives to launch");
    checkLink(spec.link);
    for (const c of spec.creatives) {
      if (c.link !== undefined) checkLink(c.link, c.key);
      const a = c.asset;
      if (!a) throw err(`creative ${c.key} has no image or video; Reddit link ads need one`);
      const f = info.formats.find((x) => x.kind === a.kind && x.ratio === a.ratio);
      if (!f) throw err(`creative ${c.key}: ${a.kind} ${a.ratio} is not accepted (Reddit takes ${info.formats.map((x) => `${x.kind} ${x.ratio}`).join(", ")})`);
      if (!f.mimes.includes(a.mime)) throw err(`creative ${c.key}: ${a.mime} is not accepted for ${a.kind}`);
      if (a.bytes > f.maxBytes) throw err(`creative ${c.key}: ${a.bytes} bytes exceeds Reddit's ${f.maxBytes}`);
      if (!/^https:\/\//.test(a.url)) throw err(`creative ${c.key}: asset URL must be public https (Reddit fetches it)`);
      if (a.kind === "video" && !a.thumbnail?.url) throw err(`creative ${c.key}: Reddit video posts need a thumbnail`);
    }
  }

  return {
    id: "reddit",

    async launch(spec: LaunchSpec): Promise<Launched> {
      validate(spec);
      const profileId = spec.identity!.ref;
      const acc = await accountInfo();
      if (acc.currency !== spec.currency.toUpperCase()) throw err(`ad account ${creds.adAccountId} bills in ${acc.currency}, but the budget is in ${spec.currency}`);
      if (!acc.canSpend) throw err(`ad account ${creds.adAccountId} cannot spend: ${acc.problem}`);
      const problem = await profileProblem(profileId);
      if (problem) throw err(problem);
      const signups = spec.optimizeFor === "signups";
      const pixelId = signups ? spec.conversion!.refs.pixelId! : await pixel();
      const fundingInstrumentId = await funding();

      // Posts first: they cost nothing on their own, so a failure here leaves nothing to clean up.
      const posts: Array<{ key: string; postId: string }> = [];
      for (const c of spec.creatives) posts.push({ key: c.key, postId: await createPost(spec, profileId, c) });

      const countries = [...new Set(spec.targeting.countries.map((c) => c.trim().toUpperCase()))];
      const startedAt = now();
      const campaign = need(
        await api<Entity>(`/ad_accounts/${acct}/campaigns`, {
          method: "POST",
          json: {
            data: {
              name: spec.campaignName,
              objective: signups ? "CONVERSIONS" : "CLICKS",
              configured_status: "PAUSED",
              funding_instrument_id: fundingInstrumentId,
              is_campaign_budget_optimization: false,
            },
          },
        }),
        "campaign",
      );

      try {
        const adGroup = need(
          await api<Entity>(`/ad_accounts/${acct}/ad_groups`, {
            method: "POST",
            json: {
              data: {
                campaign_id: campaign.id,
                name: `${spec.campaignName} · ${countries.join(",")}`.slice(0, 200),
                configured_status: "ACTIVE",
                bid_strategy: "MAXIMIZE_VOLUME",
                ...(signups
                  ? { bid_type: "CPM", optimization_goal: "SIGN_UP", view_through_conversion_type: "SEVEN_DAY_CLICKS" }
                  : { bid_type: "CPC", optimization_goal: "CLICKS" }),
                goal_type: "DAILY_SPEND",
                goal_value: Math.round(spec.dailyBudget * MICRO),
                conversion_pixel_id: pixelId,
                start_time: isoSec(startedAt),
                targeting: { geolocations: countries },
              },
            },
          }),
          "ad group",
        );

        const ads: Record<string, string> = {};
        for (const p of posts) {
          const link = spec.creatives.find((c) => c.key === p.key)?.link ?? spec.link;
          const ad = need(
            await api<Entity>(`/ad_accounts/${acct}/ads`, {
              method: "POST",
              json: { data: { ad_group_id: adGroup.id, name: `${spec.campaignName} ${p.key}`.slice(0, 200), configured_status: "ACTIVE", post_id: p.postId, click_url: link } },
            }),
            `ad ${p.key}`,
          );
          ads[p.key] = ad.id;
        }

        await setCampaignStatus(campaign.id, "ACTIVE");
        return { platform: "reddit", campaignId: campaign.id, refs: { adGroupId: adGroup.id, profileId, startedAt: startedAt.toISOString() }, ads };
      } catch (e) {
        await setCampaignStatus(campaign.id, "ARCHIVED").catch(() => {});
        if (e instanceof PlatformError) throw e;
        throw err(`launch failed: ${(e as Error).message}`);
      }
    },

    async stats(c: Launched): Promise<AdStats> {
      const cur = await currency();
      const campaign = (await api<Entity>(`/campaigns/${encodeURIComponent(c.campaignId)}`)).data;
      const adList = await list<Entity & { campaign_id?: string }>(`/ad_accounts/${acct}/ads`, { campaign_id: c.campaignId });
      const end = hourCeil(now());
      const startRaw = c.refs.startedAt ? new Date(c.refs.startedAt) : new Date(end.getTime() - 30 * 86_400_000);
      const start = hourFloor(startRaw.getTime() < end.getTime() ? startRaw : new Date(end.getTime() - 3_600_000));
      const body = {
        data: {
          starts_at: hourIso(start),
          ends_at: hourIso(end),
          time_zone_id: "UTC",
          fields: ["SPEND", "IMPRESSIONS", "CLICKS"],
          breakdowns: ["AD_ID"],
          filter: `campaign:id==${c.campaignId}`,
        },
      };
      const metrics: Metric[] = [];
      let page = await api<{ metrics?: Metric[] }>(`/ad_accounts/${acct}/reports`, { method: "POST", json: body, query: { "page.size": 1000 } });
      for (let i = 0; ; i++) {
        metrics.push(...(page.data?.metrics ?? []));
        const next = page.pagination?.next_url;
        if (!next || i >= 9) break;
        page = await api<{ metrics?: Metric[] }>(next, { method: "POST", json: body });
      }

      const keyByAd = new Map(Object.entries(c.ads).map(([k, id]) => [id, k]));
      const adStatus = new Map(adList.map((a) => [a.id, a]));
      const byCreative: NonNullable<AdStats["byCreative"]> = {};
      for (const [key, id] of Object.entries(c.ads)) byCreative[key] = { spend: 0, impressions: 0, clicks: 0, status: mapStatus(adStatus.get(id)?.effective_status ?? adStatus.get(id)?.configured_status) };
      let spendMicro = 0;
      let impressions = 0;
      let clicks = 0;
      for (const m of metrics) {
        const s = Number(m.spend ?? 0);
        const i = Number(m.impressions ?? 0);
        const k = Number(m.clicks ?? 0);
        spendMicro += s;
        impressions += i;
        clicks += k;
        const key = m.ad_id ? keyByAd.get(m.ad_id) : undefined;
        if (key) {
          const b = byCreative[key]!;
          b.spend = Math.round((b.spend + s / MICRO) * 100) / 100;
          b.impressions += i;
          b.clicks += k;
        }
      }

      const ours = adList.filter((a) => keyByAd.has(a.id));
      const statuses = ours.map((a) => mapStatus(a.effective_status ?? a.configured_status));
      const rejected = ours.filter((a) => mapStatus(a.effective_status) === "rejected");
      const rejection = rejected.map((a) => `${keyByAd.get(a.id)}: ${a.rejection_reason || "rejected"}`).join("; ") || undefined;
      const configured = mapStatus(campaign?.configured_status);
      let status: CampaignStatus;
      if (configured === "paused" || configured === "ended") status = configured;
      else if (statuses.includes("active")) status = mapStatus(campaign?.effective_status) === "ended" ? "ended" : "active";
      else if (statuses.includes("in_review")) status = "in_review";
      else if (statuses.length && statuses.every((s) => s === "rejected")) status = "rejected";
      else status = mapStatus(campaign?.effective_status ?? campaign?.configured_status);

      return {
        spend: Math.round((spendMicro / MICRO) * 100) / 100,
        currency: cur,
        impressions,
        clicks,
        status,
        ...(rejection ? { rejection } : {}),
        byCreative,
      };
    },

    async pause(c: Launched): Promise<void> {
      await setCampaignStatus(c.campaignId, "PAUSED");
    },

    async resume(c: Launched): Promise<void> {
      await setCampaignStatus(c.campaignId, "ACTIVE");
    },

    async setDailyBudget(c: Launched, amount: number): Promise<void> {
      checkBudget(amount, await currency());
      const adGroupId = c.refs.adGroupId;
      if (!adGroupId) throw err(`campaign ${c.campaignId} has no ad group ref`);
      await api(`/ad_groups/${encodeURIComponent(adGroupId)}`, { method: "PATCH", json: { data: { goal_value: Math.round(amount * MICRO) } } });
    },

    async setAdActive(c: Launched, key: string, active: boolean): Promise<void> {
      const adId = c.ads[key];
      if (!adId) throw err(`campaign ${c.campaignId} has no ad for creative ${key}`);
      await api(`/ads/${encodeURIComponent(adId)}`, { method: "PATCH", json: { data: { configured_status: active ? "ACTIVE" : "PAUSED" } } });
    },

    accountInfo,

    async checkIdentity(identity: Identity): Promise<{ ok: true } | { ok: false; problem: string }> {
      if (!identity.ref) return { ok: false, problem: `no profile id. ${info.identityHelp}` };
      const problem = await profileProblem(identity.ref);
      return problem ? { ok: false, problem } : { ok: true };
    },

    /** Finds the ad account's Reddit Pixel (the v3 API lists pixels but has no documented create call). */
    async ensureConversions(): Promise<ConversionSetup> {
      return { platform: "reddit", refs: { pixelId: await pixel() } };
    },

    async sendConversions(setup: ConversionSetup, events: Conversion[]): Promise<{ sent: number; rejected: Array<{ eventId: string; why: string }> }> {
      const pixelId = setup.refs.pixelId;
      if (setup.platform !== "reddit" || !pixelId) throw err("conversion setup has no Reddit pixelId; run ensureConversions first");
      const rejected: Array<{ eventId: string; why: string }> = [];
      const ready: Array<{ eventId: string; body: Record<string, unknown> }> = [];
      const t = now().getTime();
      for (const e of events) {
        const at = Date.parse(e.at);
        if (e.click.param !== CLICK_ID_PARAM || !e.click.value) rejected.push({ eventId: e.eventId, why: `not a Reddit click (${e.click.param})` });
        else if (!Number.isFinite(at)) rejected.push({ eventId: e.eventId, why: "invalid timestamp" });
        else if (t - at > CAPI_MAX_AGE_MS) rejected.push({ eventId: e.eventId, why: "older than Reddit's 7-day window" });
        else
          ready.push({
            eventId: e.eventId,
            body: {
              event_at: Math.min(at, t),
              action_source: "WEBSITE",
              type: e.name === "signup" ? { tracking_type: "SIGN_UP" } : { tracking_type: "CUSTOM", custom_event_name: "Activated" },
              click_id: e.click.value,
              event_source_url: e.pageUrl,
              metadata: { conversion_id: e.eventId },
              ...userFields(e),
            },
          });
      }
      let sent = 0;
      for (let i = 0; i < ready.length; i += CAPI_BATCH) {
        const batch = ready.slice(i, i + CAPI_BATCH);
        try {
          await api(`/pixels/${encodeURIComponent(pixelId)}/conversion_events`, { method: "POST", json: { data: { events: batch.map((b) => b.body) } } });
          sent += batch.length;
        } catch (e) {
          // Rate limits and outages are worth retrying as a whole; a 4xx means Reddit refused this batch.
          if (!(e instanceof PlatformError) || e.retryable) throw e;
          for (const b of batch) rejected.push({ eventId: b.eventId, why: e.message });
        }
      }
      return { sent, rejected };
    },
  };
}

/** day2 passes an already-hashed id; Reddit wants SHA-256 hex, so hash anything that isn't one already. */
function sha256Hex(v: string): string {
  const t = v.trim();
  return /^[a-f0-9]{64}$/.test(t) ? t : createHash("sha256").update(t).digest("hex");
}

/**
 * Conversions API match keys (user object): hashed external_id, plus the visitor's IP
 * and browser user agent captured at the ad-click landing. Reddit lists ip_address /
 * user_agent as optional match keys that may be sent unhashed; they are sent as captured.
 */
function userFields(e: Conversion): { user?: Record<string, string> } {
  const user: Record<string, string> = {};
  if (e.externalId) user.external_id = sha256Hex(e.externalId);
  const ip = e.clientIp?.trim();
  if (ip) user.ip_address = ip;
  const agent = e.userAgent?.trim();
  if (agent) user.user_agent = agent.slice(0, 1024);
  return Object.keys(user).length ? { user } : {};
}

function detail(j: Job): string {
  const raw = j.error_message ?? j.message ?? j.errors ?? j.error ?? "no details";
  return (typeof raw === "string" ? raw : JSON.stringify(raw)).slice(0, 300);
}
