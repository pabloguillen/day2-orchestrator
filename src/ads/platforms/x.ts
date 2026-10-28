import { createHmac, randomBytes } from "node:crypto";
import { assetBytes, fit, poll, request, type RequestInit2 } from "../http";
import {
  PlatformError,
  type AdPlatform,
  type AdStats,
  type Asset,
  type AssetSpec,
  type CampaignStatus,
  type Launched,
  type LaunchSpec,
  type PlatformDeps,
  type PlatformInfo,
} from "../types";

/**
 * X (Twitter) Ads API adapter, v12.
 *
 * Docs: https://docs.x.com/x-ads-api — campaign management reference
 * (https://docs.x.com/x-ads-api/campaign-management/reference), creatives
 * (https://docs.x.com/x-ads-api/creatives/reference), analytics
 * (https://docs.x.com/x-ads-api/analytics), media upload v2
 * (https://docs.x.com/x-api/media/quickstart/media-upload-chunked).
 *
 * Auth: OAuth 1.0a user context (HMAC-SHA1) of the X user that has access to
 * day2's ads account. Every request (and every retry) is signed afresh.
 *
 * Launch, per creative: chunked media upload on api.x.com/2/media/upload
 * (amplify_video / tweet_image) → account media library → website card
 * (MEDIA + DETAILS with a WEBSITE destination) → promoted-only post
 * (nullcast) as the app's own X account (Identity.ref = its numeric user id,
 * which must be a promotable user of day2's ads account). Then a PAUSED
 * campaign (daily budget, funding instrument) → PAUSED line item
 * (WEBSITE_CLICKS, PROMOTED_TWEETS, ALL_ON_TWITTER, AUTO bid) → country
 * targeting → promoted tweets → activate line item, then campaign. Any
 * failure after the campaign exists deletes it (or at least pauses it).
 *
 * CallToAction: X website cards only take a DETAILS component (title +
 * WEBSITE destination); BUTTON labels exist only for app destinations, so
 * the CTA is not representable for link ads and is ignored.
 */

export const API_VERSION = "12";
const ADS = `https://ads-api.x.com/${API_VERSION}`;
const MEDIA = "https://api.x.com/2/media/upload";
/** X recommends ≤ 5 MB per APPEND segment. */
const CHUNK = 4 * 1024 * 1024;
/** X's line items require an end_time; day2 pauses/stops campaigns itself. */
const FLIGHT_DAYS = 365;
/** t.co wraps every link to 23 characters; text-only posts append " " + link. */
const POST_MAX = 280;
const LINK_LEN = 23;

const MB = 1024 * 1024;
const videoMimes = ["video/mp4", "video/quicktime"];
const imageMimes = ["image/jpeg", "image/png"];

export const info: PlatformInfo = {
  id: "x",
  name: "X (Twitter)",
  formats: [
    { kind: "video", ratio: "16:9", width: 1920, height: 1080, minDurationSec: 1, maxDurationSec: 140, maxBytes: 1024 * MB, mimes: videoMimes },
    { kind: "video", ratio: "1:1", width: 1080, height: 1080, minDurationSec: 1, maxDurationSec: 140, maxBytes: 1024 * MB, mimes: videoMimes },
    { kind: "image", ratio: "1:1", width: 1080, height: 1080, maxBytes: 5 * MB, mimes: imageMimes },
    { kind: "image", ratio: "16:9", width: 1200, height: 675, maxBytes: 5 * MB, mimes: imageMimes },
  ],
  textOnly: true,
  // headline = website card title; body = post text, leaving room for a t.co link (280 incl. link).
  copyLimits: { headline: 70, body: POST_MAX - LINK_LEN - 1 },
  // X documents no minimum; below ~$10/day delivery and learning are poor.
  minDailyUsd: 10,
  identity: "app_account",
  identityHelp:
    "The app's own X account (its numeric user id is Identity.ref) must be a promotable user of day2's X ads account, and must grant day2's X user post-composer (promoted-only post) access to it in ads.x.com.",
  audiences: ["consumer", "business"],
  env: ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET", "X_ADS_ACCOUNT_ID", "X_FUNDING_INSTRUMENT_ID (optional)"],
  apiVersion: API_VERSION,
};

export type XCreds = {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
  adsAccountId: string;
  fundingInstrumentId?: string;
};

export function credentialsFromEnv(env: Record<string, string | undefined>): XCreds | null {
  const get = (k: string) => env[k]?.trim() || undefined;
  const consumerKey = get("X_CONSUMER_KEY");
  const consumerSecret = get("X_CONSUMER_SECRET");
  const accessToken = get("X_ACCESS_TOKEN");
  const accessTokenSecret = get("X_ACCESS_TOKEN_SECRET");
  const adsAccountId = get("X_ADS_ACCOUNT_ID");
  if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret || !adsAccountId) return null;
  const fundingInstrumentId = get("X_FUNDING_INSTRUMENT_ID");
  return { consumerKey, consumerSecret, accessToken, accessTokenSecret, adsAccountId, ...(fundingInstrumentId ? { fundingInstrumentId } : {}) };
}

// ---------------------------------------------------------------- OAuth 1.0a

/** RFC 3986 percent-encoding, as OAuth 1.0a requires. */
export function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * HMAC-SHA1 signature over method, base URL (no query) and all parameters
 * (query + form body + oauth_*). https://docs.x.com/resources/fundamentals/authentication/oauth-1-0a/creating-a-signature
 */
export function oauthSignature(method: string, url: string, params: Array<[string, string]>, consumerSecret: string, tokenSecret: string): string {
  const u = new URL(url);
  const baseUrl = `${u.protocol}//${u.host.toLowerCase()}${u.pathname}`;
  const all = [...u.searchParams.entries(), ...params].map(([k, v]) => [percentEncode(k), percentEncode(v)] as const);
  all.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const paramString = all.map(([k, v]) => `${k}=${v}`).join("&");
  const base = `${method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(paramString)}`;
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac("sha1", key).update(base).digest("base64");
}

/** Builds the `Authorization: OAuth …` header value. */
export function oauthHeader(
  creds: Pick<XCreds, "consumerKey" | "consumerSecret" | "accessToken" | "accessTokenSecret">,
  method: string,
  url: string,
  bodyParams: Array<[string, string]>,
  nonce: string,
  timestamp: number,
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  oauth.oauth_signature = oauthSignature(method, url, [...Object.entries(oauth), ...bodyParams], creds.consumerSecret, creds.accessTokenSecret);
  return `OAuth ${Object.keys(oauth)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauth[k]!)}"`)
    .join(", ")}`;
}

const encodePairs = (pairs: Array<[string, string]>) => pairs.map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`).join("&");

/**
 * A fetch that signs each attempt (fresh nonce/timestamp, so request()'s
 * retries are not rejected as replays), re-encodes query and form bodies per
 * RFC 3986 so the wire matches the signature, and turns X's
 * x-(account-)rate-limit-reset (epoch seconds) into a Retry-After for
 * request()'s retry loop.
 */
function signedFetch(creds: XCreds, deps: PlatformDeps): typeof fetch {
  const base = deps.fetch ?? fetch;
  const nowMs = () => (deps.now?.() ?? new Date()).getTime();
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const u = new URL(String(input));
    const query = [...u.searchParams.entries()];
    u.search = query.length ? `?${encodePairs(query)}` : "";
    const headers = new Headers(init.headers);
    let body = init.body;
    let bodyParams: Array<[string, string]> = [];
    if (typeof body === "string" && (headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
      bodyParams = [...new URLSearchParams(body).entries()];
      body = encodePairs(bodyParams);
    }
    const url = u.toString();
    headers.set("authorization", oauthHeader(creds, method, url, bodyParams, randomBytes(16).toString("hex"), Math.floor(nowMs() / 1000)));
    const res = await base(url, { ...init, method, headers, body });
    if (res.status === 429 && !res.headers.get("retry-after")) {
      const reset = Number(res.headers.get("x-account-rate-limit-reset") ?? res.headers.get("x-rate-limit-reset"));
      if (Number.isFinite(reset) && reset > 0) {
        const h = new Headers(res.headers);
        h.set("retry-after", String(Math.max(1, Math.ceil(reset - nowMs() / 1000))));
        return new Response(await res.text(), { status: 429, headers: h });
      }
    }
    return res;
  }) as typeof fetch;
}

// ---------------------------------------------------------------- API shapes

type XFunding = { id: string; currency?: string; entity_status?: string; able_to_fund?: boolean; deleted?: boolean };
type XCampaign = { id: string; entity_status?: string; deleted?: boolean; reasons_not_servable?: string[] };
type XPromoted = { id: string; tweet_id?: string; entity_status?: string; approval_status?: string; deleted?: boolean };
type XUpload = { data: { id: string; media_key?: string; processing_info?: { state?: string; check_after_secs?: number; error?: { message?: string } } } };
type XStats = { data?: Array<{ id: string; id_data?: Array<{ metrics?: Record<string, Array<number | null> | null> }> }> };

const sum = (v: Array<number | null> | null | undefined) => (v ?? []).reduce<number>((a, b) => a + (b ?? 0), 0);
const toMicro = (usd: number) => String(Math.round(usd * 1_000_000));
const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;

function fail(message: string, status?: number, retryable = false): never {
  throw new PlatformError("x", message, status, retryable);
}

function checkAsset(a: Asset): AssetSpec {
  const spec = info.formats.find((f) => f.kind === a.kind && f.ratio === a.ratio);
  if (!spec) fail(`unsupported ${a.kind} ratio ${a.ratio} (asset ${a.id}); X takes ${info.formats.map((f) => `${f.kind} ${f.ratio}`).join(", ")}`);
  if (!spec.mimes.includes(a.mime)) fail(`unsupported mime ${a.mime} (asset ${a.id})`);
  if (a.bytes > spec.maxBytes) fail(`asset ${a.id} is ${a.bytes} bytes; X allows ${spec.maxBytes}`);
  if (a.kind === "video" && a.durationSec !== undefined && spec.maxDurationSec !== undefined && a.durationSec > spec.maxDurationSec)
    fail(`video ${a.id} is ${a.durationSec}s; X allows ${spec.maxDurationSec}s`);
  return spec;
}

export function create(creds: XCreds, deps: PlatformDeps = {}): AdPlatform {
  const sdeps: PlatformDeps = { ...deps, fetch: signedFetch(creds, deps) };
  const now = () => deps.now?.() ?? new Date();
  const acct = `${ADS}/accounts/${creds.adsAccountId}`;
  const call = <T>(url: string, init?: RequestInit2) => request<T>("x", sdeps, url, init);

  async function fundingInstrument(): Promise<XFunding> {
    const res = await call<{ data?: XFunding[] }>(`${acct}/funding_instruments`, {
      query: creds.fundingInstrumentId ? { funding_instrument_ids: creds.fundingInstrumentId } : { count: 200 },
    });
    const usable = (res.data ?? []).filter((f) => !f.deleted && f.entity_status === "ACTIVE" && f.able_to_fund !== false);
    const fi = creds.fundingInstrumentId ? usable.find((f) => f.id === creds.fundingInstrumentId) : usable[0];
    if (!fi) fail(creds.fundingInstrumentId ? `funding instrument ${creds.fundingInstrumentId} is not active/able to fund` : "no active funding instrument on the ads account");
    if (fi.currency !== "USD") fail(`funding instrument ${fi.id} is in ${fi.currency ?? "unknown currency"}; day2 budgets in USD`);
    return fi;
  }

  async function assertPromotable(userId: string): Promise<void> {
    const res = await call<{ data?: Array<{ user_id?: string; deleted?: boolean }> }>(`${acct}/promotable_users`, { query: { count: 1000 } });
    if (!(res.data ?? []).some((p) => !p.deleted && String(p.user_id) === userId))
      fail(`X user ${userId} is not a promotable user of ads account ${creds.adsAccountId}. ${info.identityHelp}`);
  }

  async function countryLocation(cc: string): Promise<string> {
    const res = await call<{ data?: Array<{ targeting_value?: string; country_code?: string; location_type?: string }> }>(`${ADS}/targeting_criteria/locations`, {
      query: { location_type: "COUNTRIES", country_code: cc },
    });
    const hit = (res.data ?? []).find((l) => l.targeting_value && (l.country_code ?? "").toUpperCase() === cc && (!l.location_type || l.location_type === "COUNTRIES"));
    if (!hit?.targeting_value) fail(`no X location for country ${cc}`);
    return hit.targeting_value;
  }

  /** Chunked v2 upload (INIT → APPEND… → FINALIZE → STATUS). Returns the media_key. */
  async function upload(asset: Asset, category: "amplify_video" | "tweet_image"): Promise<string> {
    const bytes = await assetBytes(deps, asset);
    const init = await call<XUpload>(`${MEDIA}/initialize`, { method: "POST", json: { media_type: asset.mime, total_bytes: bytes.byteLength, media_category: category } });
    const id = init.data.id;
    for (let off = 0, seg = 0; off < bytes.byteLength; off += CHUNK, seg++) {
      const fd = new FormData();
      fd.set("segment_index", String(seg));
      fd.set("media", new Blob([bytes.slice(off, off + CHUNK)], { type: "application/octet-stream" }), `${asset.id}.part${seg}`);
      await call(`${MEDIA}/${id}/append`, { method: "POST", multipart: fd });
    }
    const fin = await call<XUpload>(`${MEDIA}/${id}/finalize`, { method: "POST" });
    const failed = (p?: XUpload["data"]["processing_info"]) => fail(`media ${asset.id} processing failed${p?.error?.message ? `: ${p.error.message}` : ""}`);
    const p0 = fin.data.processing_info;
    if (p0?.state === "failed") failed(p0);
    if (p0 && p0.state !== "succeeded") {
      await poll(
        sdeps,
        async () => {
          const s = await call<XUpload>(MEDIA, { query: { command: "STATUS", media_id: id } });
          const p = s.data?.processing_info;
          if (!p || p.state === "succeeded") return true;
          if (p.state === "failed") failed(p);
          return undefined;
        },
        { everyMs: Math.max(1, p0.check_after_secs ?? 3) * 1000, timeoutMs: 20 * 60_000, what: `media ${asset.id} processing`, platform: "x" },
      );
    }
    const key = fin.data.media_key ?? init.data.media_key;
    if (!key) fail(`no media_key for ${asset.id}`);
    return key;
  }

  async function setCampaign(campaignId: string, form: Record<string, string>): Promise<void> {
    await call(`${acct}/campaigns/${campaignId}`, { method: "PUT", form });
  }

  return {
    id: "x",

    async launch(spec: LaunchSpec): Promise<Launched> {
      const userId = spec.identity?.ref;
      if (!spec.identity || spec.identity.platform !== "x" || !userId || !/^\d{1,20}$/.test(userId)) fail("launch needs an X identity whose ref is the app account's numeric user id");
      if (!spec.creatives.length) fail("launch needs at least one creative");
      if (!spec.targeting.countries.length) fail("launch needs at least one country");
      if (!(Number.isFinite(spec.dailyBudgetUsd) && spec.dailyBudgetUsd > 0)) fail(`invalid daily budget ${spec.dailyBudgetUsd}`);
      for (const c of spec.creatives) if (c.asset) checkAsset(c.asset);

      // Everything that can fail cheaply, before any spending entity exists.
      await assertPromotable(userId);
      const fi = await fundingInstrument();
      const locations: string[] = [];
      for (const cc of [...new Set(spec.targeting.countries.map((c) => c.toUpperCase()))]) locations.push(await countryLocation(cc));

      // Creatives: promoted-only posts (nullcast) never show organically and spend nothing on their own.
      const tweets: Array<{ key: string; tweetId: string }> = [];
      for (const c of spec.creatives) {
        const name = fit(`${spec.campaignName} ${c.key}`, 80);
        const post: Record<string, string> = { as_user_id: userId, nullcast: "true", name };
        if (c.asset) {
          const isVideo = c.asset.kind === "video";
          const mediaKey = await upload(c.asset, isVideo ? "amplify_video" : "tweet_image");
          const lib: Record<string, string> = { media_key: mediaKey, name: fit(name, 100) };
          if (isVideo && c.asset.thumbnail) lib.poster_media_key = await upload(c.asset.thumbnail, "tweet_image");
          const libRes = await call<{ data?: { media_key?: string } }>(`${acct}/media_library`, { method: "POST", form: lib });
          const card = await call<{ data?: { card_uri?: string } }>(`${acct}/cards`, {
            method: "POST",
            json: {
              name,
              components: [
                { type: "MEDIA", media_key: libRes.data?.media_key ?? mediaKey },
                { type: "DETAILS", title: fit(c.copy.headline, info.copyLimits.headline), destination: { type: "WEBSITE", url: spec.link } },
              ],
            },
          });
          if (!card.data?.card_uri) fail(`card for ${c.key} has no card_uri`);
          post.text = fit(c.copy.body, info.copyLimits.body);
          post.card_uri = card.data.card_uri;
        } else {
          post.text = `${fit(c.copy.body, info.copyLimits.body)} ${spec.link}`;
        }
        const tw = await call<{ data?: { id_str?: string; id?: number | string } }>(`${acct}/tweet`, { method: "POST", form: post });
        const tweetId = tw.data?.id_str ?? (tw.data?.id !== undefined ? String(tw.data.id) : undefined);
        if (!tweetId) fail(`post for ${c.key} returned no id`);
        tweets.push({ key: c.key, tweetId });
      }

      // Spending entities: created PAUSED, activated only at the very end.
      const camp = await call<{ data?: { id?: string } }>(`${acct}/campaigns`, {
        method: "POST",
        form: { funding_instrument_id: fi.id, name: fit(spec.campaignName, 255), daily_budget_amount_local_micro: toMicro(spec.dailyBudgetUsd), entity_status: "PAUSED" },
      });
      const campaignId = camp.data?.id;
      if (!campaignId) fail("campaign create returned no id");

      try {
        const start = now();
        const li = await call<{ data?: { id?: string } }>(`${acct}/line_items`, {
          method: "POST",
          form: {
            campaign_id: campaignId,
            name: fit(spec.campaignName, 255),
            objective: "WEBSITE_CLICKS",
            product_type: "PROMOTED_TWEETS",
            placements: "ALL_ON_TWITTER",
            bid_strategy: "AUTO",
            advertiser_domain: new URL(spec.link).hostname,
            start_time: start.toISOString(),
            end_time: new Date(start.getTime() + FLIGHT_DAYS * 24 * HOUR).toISOString(),
            entity_status: "PAUSED",
          },
        });
        const lineItemId = li.data?.id;
        if (!lineItemId) fail("line item create returned no id");

        const tc = await call<{ operation_errors?: unknown[][]; errors?: unknown[] }>(`${ADS}/batch/accounts/${creds.adsAccountId}/targeting_criteria`, {
          method: "POST",
          json: locations.map((v) => ({ operation_type: "Create", params: { line_item_id: lineItemId, targeting_type: "LOCATION", targeting_value: v } })),
        });
        if (tc?.errors?.length || tc?.operation_errors?.some((e) => e && e.length)) fail(`targeting failed: ${JSON.stringify(tc.errors ?? tc.operation_errors).slice(0, 300)}`);

        const pt = await call<{ data?: XPromoted[] }>(`${acct}/promoted_tweets`, {
          method: "POST",
          form: { line_item_id: lineItemId, tweet_ids: tweets.map((t) => t.tweetId).join(",") },
        });
        const promoted = pt.data ?? [];
        const ads: Record<string, string> = {};
        tweets.forEach((t, i) => {
          const p = promoted.find((x) => x.tweet_id === t.tweetId) ?? promoted[i];
          if (!p?.id) fail(`post ${t.tweetId} (${t.key}) was not promoted`);
          ads[t.key] = p.id;
        });

        await call(`${acct}/line_items/${lineItemId}`, { method: "PUT", form: { entity_status: "ACTIVE" } });
        await setCampaign(campaignId, { entity_status: "ACTIVE" });

        return {
          platform: "x",
          campaignId,
          refs: { lineItemId, fundingInstrumentId: fi.id, currency: "USD", createdAt: start.toISOString() },
          ads,
        };
      } catch (err) {
        try {
          await call(`${acct}/campaigns/${campaignId}`, { method: "DELETE" });
        } catch {
          await setCampaign(campaignId, { entity_status: "PAUSED" }).catch(() => undefined);
        }
        if (err instanceof PlatformError) throw err;
        fail(`launch failed: ${(err as Error).message}`);
      }
    },

    async stats(c: Launched): Promise<AdStats> {
      const camp = await call<{ data?: XCampaign }>(`${acct}/campaigns/${c.campaignId}`, { query: { with_deleted: true } });
      const pts = await call<{ data?: XPromoted[] }>(`${acct}/promoted_tweets`, { query: { line_item_ids: c.refs.lineItemId, with_deleted: true, count: 1000 } });
      const keyOf = new Map(Object.entries(c.ads).map(([k, id]) => [id, k]));
      const ids = Object.values(c.ads);

      const totals = new Map<string, { spendUsd: number; impressions: number; clicks: number }>(ids.map((id) => [id, { spendUsd: 0, impressions: 0, clicks: 0 }]));
      const created = c.refs.createdAt ? new Date(c.refs.createdAt).getTime() : now().getTime() - WEEK;
      const from = Math.floor(created / HOUR) * HOUR;
      const to = Math.max(from + HOUR, Math.ceil(now().getTime() / HOUR) * HOUR);
      for (let s = from; s < to; s += WEEK) {
        const e = Math.min(s + WEEK, to);
        for (let i = 0; i < ids.length; i += 20) {
          const res = await call<XStats>(`${ADS}/stats/accounts/${creds.adsAccountId}`, {
            query: {
              entity: "PROMOTED_TWEET",
              entity_ids: ids.slice(i, i + 20).join(","),
              start_time: new Date(s).toISOString().replace(/\.\d{3}Z$/, "Z"),
              end_time: new Date(e).toISOString().replace(/\.\d{3}Z$/, "Z"),
              granularity: "TOTAL",
              placement: "ALL_ON_TWITTER",
              metric_groups: "BILLING,ENGAGEMENT",
            },
          });
          for (const d of res.data ?? []) {
            const t = totals.get(d.id);
            if (!t) continue;
            for (const seg of d.id_data ?? []) {
              const m = seg.metrics ?? {};
              t.spendUsd += sum(m.billed_charge_local_micro) / 1_000_000;
              t.impressions += sum(m.impressions);
              t.clicks += m.url_clicks ? sum(m.url_clicks) : sum(m.clicks);
            }
          }
        }
      }

      const adStatus = (p?: XPromoted): CampaignStatus => {
        if (!p) return "unknown";
        if (p.deleted) return "ended";
        if (p.approval_status === "REJECTED") return "rejected";
        if (p.entity_status === "PAUSED") return "paused";
        if (p.approval_status && p.approval_status !== "ACCEPTED") return "in_review";
        return p.entity_status === "ACTIVE" ? "active" : "unknown";
      };
      const byCreative: NonNullable<AdStats["byCreative"]> = {};
      const statuses: CampaignStatus[] = [];
      for (const [id, t] of totals) {
        const key = keyOf.get(id)!;
        const st = adStatus((pts.data ?? []).find((p) => p.id === id));
        statuses.push(st);
        byCreative[key] = { spendUsd: Math.round(t.spendUsd * 100) / 100, impressions: t.impressions, clicks: t.clicks, status: st };
      }

      const cd = camp.data;
      let status: CampaignStatus;
      if (!cd) status = "unknown";
      else if (cd.deleted || (cd.reasons_not_servable ?? []).includes("EXPIRED")) status = "ended";
      else if (cd.entity_status === "PAUSED" || cd.entity_status === "DRAFT") status = "paused";
      else if (statuses.length && statuses.every((s) => s === "rejected")) status = "rejected";
      else if (statuses.includes("in_review") && !statuses.includes("active")) status = "in_review";
      else if (cd.entity_status === "ACTIVE") status = "active";
      else status = "unknown";

      const rejected = Object.entries(byCreative).filter(([, v]) => v.status === "rejected").map(([k]) => k);
      const all = [...totals.values()];
      return {
        spendUsd: Math.round(all.reduce((a, t) => a + t.spendUsd, 0) * 100) / 100,
        impressions: all.reduce((a, t) => a + t.impressions, 0),
        clicks: all.reduce((a, t) => a + t.clicks, 0),
        status,
        ...(rejected.length ? { rejection: `X rejected the promoted post(s) for ${rejected.join(", ")} (approval_status REJECTED; see ads.x.com for the policy reason)` } : {}),
        byCreative,
      };
    },

    async pause(c: Launched): Promise<void> {
      await setCampaign(c.campaignId, { entity_status: "PAUSED" });
    },

    async resume(c: Launched): Promise<void> {
      await setCampaign(c.campaignId, { entity_status: "ACTIVE" });
    },

    async setDailyBudget(c: Launched, usd: number): Promise<void> {
      if (!(Number.isFinite(usd) && usd > 0)) fail(`invalid daily budget ${usd}`);
      if (c.refs.currency && c.refs.currency !== "USD") fail(`campaign currency is ${c.refs.currency}, not USD`);
      await setCampaign(c.campaignId, { daily_budget_amount_local_micro: toMicro(usd) });
    },
  };
}
