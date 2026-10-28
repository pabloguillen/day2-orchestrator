/**
 * Reddit — Reddit Ads API v3, https://ads-api.reddit.com/api/v3
 * Docs: https://ads-api.reddit.com/docs/v3/ (mirror: https://ads-api-reddit.netlify.app/docs/v3/)
 *
 * Auth: OAuth2 refresh token from a Reddit developer app (scopes adsread,adsedit;
 * duration=permanent) against https://www.reddit.com/api/v1/access_token with
 * HTTP Basic client credentials. Reddit rejects/throttles generic User-Agents,
 * so every call (token and API) sends a descriptive one.
 *
 * Launch flow (all from day2's own ad account; ads run as the app's profile):
 *   checks: the identity profile belongs to the ad account; pixel + funding instrument resolved
 *   per creative: structured post job on the profile (Reddit fetches the media from
 *                 day2's public asset URL) → poll job until SUCCESS → post_id
 *   campaign (PAUSED, objective CLICKS = "Traffic") → ad group (daily budget in
 *   micro, countries, auto-bid CPC) → ads (post_id + click_url) → campaign ACTIVE.
 *
 * The campaign is the single on/off switch: it stays PAUSED until every child
 * exists. If anything fails after it was created it is ARCHIVED (Reddit only
 * allows DELETE three hours after the last change; ARCHIVED stops it for good)
 * and the error is rethrown as PlatformError.
 *
 * Not publicly documented in a machine-readable way (request/response schemas on
 * the v3 reference pages render client-side only): the field-level shapes below
 * follow the documented paths, the official setup guide's examples, and Reddit's
 * enums. Where a field's shape is uncertain we fail loudly instead of guessing:
 *   - age / language / interest targeting are not sent (Reddit's v3 ad-group
 *     targeting has no age field; interests need Reddit taxonomy ids);
 *   - text-only ads are refused (Reddit needs an image or video post for a link ad);
 *   - profiles cannot be created through the API, so identity is "app_account".
 */
import { fit, poll, request, tokenCache, type RequestInit2 } from "../http";
import {
  PlatformError,
  type AdPlatform,
  type AdStats,
  type Asset,
  type CallToAction,
  type CampaignStatus,
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
type Metric = { ad_id?: string; spend?: number; impressions?: number; clicks?: number };

const err = (message: string, status?: number, retryable = false) => new PlatformError("reddit", message, status, retryable);

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

  async function assertProfile(profileId: string): Promise<void> {
    const profiles = await list<{ id?: string }>(`/ad_accounts/${acct}/profiles`, {}, 5);
    if (!profiles.some((p) => p.id === profileId)) throw err(`profile ${profileId} is not linked to ad account ${creds.adAccountId}. ${info.identityHelp}`);
  }

  function headlineFor(headline: string, asset: Asset): string {
    if (!asset.aiPerson || /\bAI\b/.test(headline)) return fit(headline, HEADLINE_MAX);
    return `${fit(headline, HEADLINE_MAX - AI_TAG.length)}${AI_TAG}`;
  }

  /** Creates the promoted post on the app's profile; Reddit fetches the media from day2's public URL. */
  async function createPost(spec: LaunchSpec, profileId: string, c: LaunchSpec["creatives"][number]): Promise<string> {
    const a = c.asset!;
    const destination = { type: "URL", url: spec.link, display_url: new URL(spec.link).hostname, call_to_action: CTA[c.copy.cta] };
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

  function validate(spec: LaunchSpec): void {
    if (!spec.identity?.ref) throw err(`launch needs the app's Reddit profile as identity. ${info.identityHelp}`);
    if (!(spec.dailyBudgetUsd >= MIN_DAILY_USD)) throw err(`daily budget $${spec.dailyBudgetUsd} is below Reddit's $${MIN_DAILY_USD} minimum`);
    if (!spec.targeting.countries.length) throw err("at least one target country is required");
    const badCountry = spec.targeting.countries.find((c) => !/^[A-Za-z]{2}$/.test(c.trim()));
    if (badCountry !== undefined) throw err(`"${badCountry}" is not an ISO 3166-1 alpha-2 country code`);
    if (!spec.creatives.length) throw err("no creatives to launch");
    let url: URL;
    try {
      url = new URL(spec.link);
    } catch {
      throw err(`invalid landing URL`);
    }
    if (url.protocol !== "https:") throw err("Reddit needs an https landing URL");
    for (const c of spec.creatives) {
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
      await assertProfile(profileId);
      const pixelId = await pixel();
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
              objective: "CLICKS",
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
                bid_type: "CPC",
                optimization_goal: "CLICKS",
                goal_type: "DAILY_SPEND",
                goal_value: Math.round(spec.dailyBudgetUsd * MICRO),
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
          const ad = need(
            await api<Entity>(`/ad_accounts/${acct}/ads`, {
              method: "POST",
              json: { data: { ad_group_id: adGroup.id, name: `${spec.campaignName} ${p.key}`.slice(0, 200), configured_status: "ACTIVE", post_id: p.postId, click_url: spec.link } },
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
      for (const [key, id] of Object.entries(c.ads)) byCreative[key] = { spendUsd: 0, impressions: 0, clicks: 0, status: mapStatus(adStatus.get(id)?.effective_status ?? adStatus.get(id)?.configured_status) };
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
          b.spendUsd = Math.round((b.spendUsd + s / MICRO) * 100) / 100;
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
        spendUsd: Math.round((spendMicro / MICRO) * 100) / 100,
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

    async setDailyBudget(c: Launched, usd: number): Promise<void> {
      if (!(usd >= MIN_DAILY_USD)) throw err(`daily budget $${usd} is below Reddit's $${MIN_DAILY_USD} minimum`);
      const adGroupId = c.refs.adGroupId;
      if (!adGroupId) throw err(`campaign ${c.campaignId} has no ad group ref`);
      await api(`/ad_groups/${encodeURIComponent(adGroupId)}`, { method: "PATCH", json: { data: { goal_value: Math.round(usd * MICRO) } } });
    },
  };
}

function detail(j: Job): string {
  const raw = j.error_message ?? j.message ?? j.errors ?? j.error ?? "no details";
  return (typeof raw === "string" ? raw : JSON.stringify(raw)).slice(0, 300);
}
