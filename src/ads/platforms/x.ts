import { createHmac, randomBytes } from "node:crypto";
import { assetBytes, fit, poll, request, type RequestInit2 } from "../http";
import {
  PlatformError,
  type AdAccountInfo,
  type AdPlatform,
  type AdStats,
  type Asset,
  type AssetSpec,
  type CampaignStatus,
  type Conversion,
  type ConversionSetup,
  type Identity,
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
 * (https://docs.x.com/x-api/media/quickstart/media-upload-chunked), web
 * event tags + Conversion API (https://docs.x.com/x-ads-api/measurement/web-conversions).
 *
 * Auth: OAuth 1.0a user context (HMAC-SHA1) of an X user with Ad manager /
 * Account admin access to the ads account. Every attempt is signed afresh.
 *
 * Launch, per creative: chunked media upload (amplify_video / tweet_image) →
 * account media library → website card (MEDIA + DETAILS with the ad's own
 * WEBSITE url) → promoted-only post (nullcast) as the app's X account
 * (Identity.ref = numeric user id; see checkIdentity). Then a PAUSED campaign
 * (daily budget in the account currency, local micro) → PAUSED line item
 * (WEBSITE_CLICKS; for "signups" goal WEBSITE_CONVERSIONS with the day2
 * sign-up web event tag) → country targeting → promoted tweets → activate
 * line item, then campaign. Any failure after the campaign exists deletes it
 * (or at least pauses it).
 *
 * Per-ad pause: X has no update for promoted tweets ("It is not possible to
 * update (PUT) promoted Tweet entities"), so setAdActive(false) deletes the
 * promoted tweet (detaches the post from the line item) and
 * setAdActive(true) re-attaches the same post. Stats therefore aggregate all
 * promoted tweets (deleted included) per post id.
 *
 * CallToAction: website cards take a DETAILS component (title + WEBSITE
 * destination); BUTTON labels exist only for app destinations, so the CTA is
 * not representable for link ads and is ignored.
 */

export const API_VERSION = "12";
export const ADS_BASE = `https://ads-api.x.com/${API_VERSION}`;
const MEDIA = "https://api.x.com/2/media/upload";
/** X recommends ≤ 5 MB per APPEND segment. */
const CHUNK = 4 * 1024 * 1024;
/** X's line items require an end_time; day2 pauses/stops campaigns itself. */
const FLIGHT_DAYS = 365;
/** t.co wraps every link to 23 characters; text-only posts append " " + link. */
const POST_MAX = 280;
const LINK_LEN = 23;
/** Conversion API: "Up to 500 conversion events may be provided." */
const CAPI_BATCH = 500;
export const CONVERSION_TAGS = {
  signup: { name: "day2 signup", type: "SIGN_UP" },
  activated: { name: "day2 activated", type: "CUSTOM" },
} as const;

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
  clickIdParam: "twclid",
  identity: "app_account",
  identityHelp:
    "The app's own X account (Identity.ref = its numeric user id) must be the FULL promotable user of the ads account day2 runs (i.e. its own ads account, connected to day2 with Ad manager + post-composer access), because X only lets promoted-only posts be created for that user.",
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

/** Consumer (app) keys plus, once a user is connected, their token. */
export type OAuthKeys = { consumerKey: string; consumerSecret: string; accessToken?: string; accessTokenSecret?: string };

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

/**
 * Builds the `Authorization: OAuth …` header value. `extra` carries
 * protocol parameters such as oauth_callback (request token step).
 */
export function oauthHeader(
  keys: OAuthKeys,
  method: string,
  url: string,
  bodyParams: Array<[string, string]>,
  nonce: string,
  timestamp: number,
  extra: Record<string, string> = {},
): string {
  const oauth: Record<string, string> = {
    ...extra,
    oauth_consumer_key: keys.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp),
    ...(keys.accessToken ? { oauth_token: keys.accessToken } : {}),
    oauth_version: "1.0",
  };
  oauth.oauth_signature = oauthSignature(method, url, [...Object.entries(oauth), ...bodyParams], keys.consumerSecret, keys.accessTokenSecret ?? "");
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
export function signedFetch(keys: OAuthKeys, deps: PlatformDeps, extra: Record<string, string> = {}): typeof fetch {
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
    headers.set("authorization", oauthHeader(keys, method, url, bodyParams, randomBytes(16).toString("hex"), Math.floor(nowMs() / 1000), extra));
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

/** A signed request() for X. */
export function xCaller(keys: OAuthKeys, deps: PlatformDeps = {}) {
  const sdeps: PlatformDeps = { ...deps, fetch: signedFetch(keys, deps) };
  return <T>(url: string, init?: RequestInit2) => request<T>("x", sdeps, url, init);
}
export type XCall = ReturnType<typeof xCaller>;

// ---------------------------------------------------------------- shared account checks

type XFunding = { id: string; currency?: string; entity_status?: string; able_to_fund?: boolean; deleted?: boolean };
type XAccount = { id: string; name?: string; approval_status?: string; deleted?: boolean };

const MANAGE_ROLES = ["ACCOUNT_ADMIN", "AD_MANAGER"];

/**
 * Name, currency (of the usable funding instrument) and whether the
 * authenticated user can run spend on an ads account. Used by accountInfo()
 * and the connect flow's listAdAccounts().
 */
export async function describeAccount(call: XCall, accountId: string, fundingInstrumentId?: string, account?: XAccount): Promise<AdAccountInfo & { fundingInstrumentId?: string }> {
  const acct = `${ADS_BASE}/accounts/${accountId}`;
  const a = account ?? (await call<{ data?: XAccount }>(acct)).data;
  const fis = (
    await call<{ data?: XFunding[] }>(`${acct}/funding_instruments`, { query: fundingInstrumentId ? { funding_instrument_ids: fundingInstrumentId } : { count: 200 } })
  ).data ?? [];
  const access = (await call<{ data?: { permissions?: string[] } }>(`${acct}/authenticated_user_access`)).data?.permissions ?? [];
  const usable = fis.filter((f) => !f.deleted && f.entity_status === "ACTIVE" && f.able_to_fund !== false);
  const fi = fundingInstrumentId ? usable.find((f) => f.id === fundingInstrumentId) : usable[0];
  const anyFi = fi ?? fis.find((f) => !f.deleted && f.currency);
  const problems: string[] = [];
  if (!a || a.deleted) problems.push("ads account is deleted");
  else if (a.approval_status && a.approval_status !== "ACCEPTED") problems.push(`ads account approval status is ${a.approval_status}`);
  if (!fi) problems.push(fundingInstrumentId ? `funding instrument ${fundingInstrumentId} is not active/able to fund` : "no active funding instrument (add a payment method in ads.x.com)");
  if (!access.some((p) => MANAGE_ROLES.includes(p))) problems.push("the connected X user needs the Ad manager or Account admin role on this ads account");
  return {
    id: accountId,
    name: a?.name ?? accountId,
    currency: anyFi?.currency ?? "",
    canSpend: problems.length === 0,
    ...(problems.length ? { problem: problems.join("; ") } : {}),
    ...(fi ? { fundingInstrumentId: fi.id } : {}),
  };
}

/** Whether day2 can create promoted-only posts as `userId` on this ads account. */
export async function identityProblem(call: XCall, accountId: string, userId: string): Promise<string | null> {
  if (!/^\d{1,20}$/.test(userId)) return `X identity ref must be the account's numeric user id, got "${userId}"`;
  const acct = `${ADS_BASE}/accounts/${accountId}`;
  const users = (await call<{ data?: Array<{ user_id?: string; promotable_user_type?: string; deleted?: boolean }> }>(`${acct}/promotable_users`, { query: { count: 1000 } })).data ?? [];
  const pu = users.find((p) => !p.deleted && String(p.user_id) === userId);
  if (!pu) return `X user ${userId} is not a promotable user of ads account ${accountId}`;
  if (pu.promotable_user_type !== "FULL")
    return `X user ${userId} is a ${pu.promotable_user_type ?? "limited"} promotable user of ads account ${accountId}: X only allows promoting its existing posts there, not creating promoted-only posts. Connect the app's own X ads account (where it is the FULL promotable user) instead.`;
  const access = (await call<{ data?: { permissions?: string[] } }>(`${acct}/authenticated_user_access`)).data?.permissions ?? [];
  if (!access.some((p) => MANAGE_ROLES.includes(p))) return "the connected X user needs the Ad manager or Account admin role on the ads account";
  if (!access.includes("TWEET_COMPOSER")) return "the connected X user lacks the post-composer (TWEET_COMPOSER) permission needed to create promoted-only posts; grant it in ads.x.com > Multi-user login";
  return null;
}

// ---------------------------------------------------------------- adapter

type XCampaign = { id: string; entity_status?: string; deleted?: boolean; reasons_not_servable?: string[] };
type XPromoted = { id: string; tweet_id?: string; line_item_id?: string; entity_status?: string; approval_status?: string; deleted?: boolean };
type XUpload = { data: { id: string; media_key?: string; processing_info?: { state?: string; check_after_secs?: number; error?: { message?: string } } } };
type XStats = { data?: Array<{ id: string; id_data?: Array<{ metrics?: Record<string, Array<number | null> | null> }> }> };
type XWebTag = { id: string; name?: string; type?: string; website_tag_id?: string; deleted?: boolean };

const sum = (v: Array<number | null> | null | undefined) => (v ?? []).reduce<number>((a, b) => a + (b ?? 0), 0);
const toMicro = (amount: number) => String(Math.round(amount * 1_000_000));
const round2 = (n: number) => Math.round(n * 100) / 100;
const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const tweetRef = (key: string) => `tweet:${key}`;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * Conversion API identifiers: the twclid, plus the click's IP address and
 * user agent in one object, unhashed, as X's example shows. X documents the
 * IP only in IPv4 dotted-decimal form, so IPv6 addresses are left out.
 */
function identifiersOf(e: Conversion): Array<Record<string, string>> {
  const ids: Array<Record<string, string>> = [{ twclid: e.click.value }];
  const device: Record<string, string> = {};
  const ip = e.clientIp?.trim();
  if (ip && IPV4.test(ip)) device.ip_address = ip;
  const ua = e.userAgent?.trim();
  if (ua) device.user_agent = ua;
  if (Object.keys(device).length) ids.push(device);
  return ids;
}

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
  const call = xCaller(creds, deps);
  const now = () => deps.now?.() ?? new Date();
  const acct = `${ADS_BASE}/accounts/${creds.adsAccountId}`;

  async function countryLocation(cc: string): Promise<string> {
    const res = await call<{ data?: Array<{ targeting_value?: string; country_code?: string; location_type?: string }> }>(`${ADS_BASE}/targeting_criteria/locations`, {
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
        deps,
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

  async function promotedTweets(lineItemId: string): Promise<XPromoted[]> {
    return (await call<{ data?: XPromoted[] }>(`${acct}/promoted_tweets`, { query: { line_item_ids: lineItemId, with_deleted: true, count: 1000 } })).data ?? [];
  }

  /** Post id of each creative key (from refs; falls back to the launch-time promoted tweet). */
  function tweetIdOf(c: Launched, key: string, pts: XPromoted[]): string | undefined {
    return c.refs[tweetRef(key)] ?? pts.find((p) => p.id === c.ads[key])?.tweet_id;
  }

  return {
    id: "x",

    async launch(spec: LaunchSpec): Promise<Launched> {
      const userId = spec.identity?.ref;
      if (!spec.identity || spec.identity.platform !== "x" || !userId) fail("launch needs an X identity whose ref is the app account's numeric user id");
      if (!spec.creatives.length) fail("launch needs at least one creative");
      if (!spec.targeting.countries.length) fail("launch needs at least one country");
      if (!(Number.isFinite(spec.dailyBudget) && spec.dailyBudget > 0)) fail(`invalid daily budget ${spec.dailyBudget}`);
      const signupTag = spec.optimizeFor === "signups" ? spec.conversion?.refs.signup : undefined;
      if (spec.optimizeFor === "signups" && (!signupTag || spec.conversion?.platform !== "x")) fail("optimizeFor signups needs the X conversion setup from ensureConversions()");
      for (const c of spec.creatives) {
        if (c.asset) checkAsset(c.asset);
        if (!URL.canParse(c.link ?? spec.link)) fail(`invalid link for ${c.key}: ${c.link ?? spec.link}`);
      }

      // Everything that can fail cheaply, before any spending entity exists.
      const problem = await identityProblem(call, creds.adsAccountId, userId);
      if (problem) fail(problem);
      const account = await describeAccount(call, creds.adsAccountId, creds.fundingInstrumentId);
      if (!account.canSpend || !account.fundingInstrumentId) fail(`ads account ${creds.adsAccountId} cannot spend: ${account.problem ?? "no funding instrument"}`);
      if (account.currency.toUpperCase() !== spec.currency.toUpperCase()) fail(`budget is in ${spec.currency} but the funding instrument bills in ${account.currency}`);
      const locations: string[] = [];
      for (const cc of [...new Set(spec.targeting.countries.map((c) => c.toUpperCase()))]) locations.push(await countryLocation(cc));

      // Creatives: promoted-only posts (nullcast) never show organically and spend nothing on their own.
      const tweets: Array<{ key: string; tweetId: string }> = [];
      for (const c of spec.creatives) {
        const link = c.link ?? spec.link;
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
                { type: "DETAILS", title: fit(c.copy.headline, info.copyLimits.headline), destination: { type: "WEBSITE", url: link } },
              ],
            },
          });
          if (!card.data?.card_uri) fail(`card for ${c.key} has no card_uri`);
          post.text = fit(c.copy.body, info.copyLimits.body);
          post.card_uri = card.data.card_uri;
        } else {
          post.text = `${fit(c.copy.body, info.copyLimits.body)} ${link}`;
        }
        const tw = await call<{ data?: { id_str?: string; id?: number | string } }>(`${acct}/tweet`, { method: "POST", form: post });
        const tweetId = tw.data?.id_str ?? (tw.data?.id !== undefined ? String(tw.data.id) : undefined);
        if (!tweetId) fail(`post for ${c.key} returned no id`);
        tweets.push({ key: c.key, tweetId });
      }

      // Spending entities: created PAUSED, activated only at the very end.
      const camp = await call<{ data?: { id?: string } }>(`${acct}/campaigns`, {
        method: "POST",
        form: {
          funding_instrument_id: account.fundingInstrumentId,
          name: fit(spec.campaignName, 255),
          daily_budget_amount_local_micro: toMicro(spec.dailyBudget),
          entity_status: "PAUSED",
        },
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
            ...(signupTag ? { goal: "WEBSITE_CONVERSIONS", primary_web_event_tag: signupTag } : {}),
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

        const tc = await call<{ operation_errors?: unknown[][]; errors?: unknown[] }>(`${ADS_BASE}/batch/accounts/${creds.adsAccountId}/targeting_criteria`, {
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
          refs: {
            lineItemId,
            fundingInstrumentId: account.fundingInstrumentId,
            currency: account.currency,
            createdAt: start.toISOString(),
            ...Object.fromEntries(tweets.map((t) => [tweetRef(t.key), t.tweetId])),
          },
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
      const pts = await promotedTweets(c.refs.lineItemId!);
      // Every promoted tweet (incl. detached ones from setAdActive) belongs to a creative key by post id.
      const keyByTweet = new Map<string, string>();
      for (const key of Object.keys(c.ads)) {
        const t = tweetIdOf(c, key, pts);
        if (t) keyByTweet.set(t, key);
      }
      const keyOfPt = new Map<string, string>();
      for (const [key, id] of Object.entries(c.ads)) keyOfPt.set(id, key);
      for (const p of pts) {
        const key = p.tweet_id ? keyByTweet.get(p.tweet_id) : undefined;
        if (key) keyOfPt.set(p.id, key);
      }
      const ids = [...keyOfPt.keys()];

      const totals = new Map<string, { spend: number; impressions: number; clicks: number }>(Object.keys(c.ads).map((k) => [k, { spend: 0, impressions: 0, clicks: 0 }]));
      const created = c.refs.createdAt ? new Date(c.refs.createdAt).getTime() : now().getTime() - WEEK;
      const from = Math.floor(created / HOUR) * HOUR;
      const to = Math.max(from + HOUR, Math.ceil(now().getTime() / HOUR) * HOUR);
      for (let s = from; s < to; s += WEEK) {
        const e = Math.min(s + WEEK, to);
        for (let i = 0; i < ids.length; i += 20) {
          const res = await call<XStats>(`${ADS_BASE}/stats/accounts/${creds.adsAccountId}`, {
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
            const key = keyOfPt.get(d.id);
            const t = key ? totals.get(key) : undefined;
            if (!t) continue;
            for (const seg of d.id_data ?? []) {
              const m = seg.metrics ?? {};
              t.spend += sum(m.billed_charge_local_micro) / 1_000_000;
              t.impressions += sum(m.impressions);
              t.clicks += m.url_clicks ? sum(m.url_clicks) : sum(m.clicks);
            }
          }
        }
      }

      const adStatus = (key: string): CampaignStatus => {
        const mine = pts.filter((p) => keyOfPt.get(p.id) === key);
        if (!mine.length) return "unknown";
        const live = mine.filter((p) => !p.deleted);
        if (!live.length) return "paused"; // detached by setAdActive(false)
        if (live.some((p) => p.approval_status === "ACCEPTED" && p.entity_status === "ACTIVE")) return "active";
        if (live.every((p) => p.approval_status === "REJECTED")) return "rejected";
        if (live.some((p) => p.entity_status === "PAUSED")) return "paused";
        if (live.some((p) => p.approval_status && p.approval_status !== "ACCEPTED")) return "in_review";
        return "unknown";
      };
      const byCreative: NonNullable<AdStats["byCreative"]> = {};
      for (const [key, t] of totals) byCreative[key] = { spend: round2(t.spend), impressions: t.impressions, clicks: t.clicks, status: adStatus(key) };
      const statuses = Object.values(byCreative).map((v) => v.status);

      const cd = camp.data;
      let status: CampaignStatus;
      if (!cd) status = "unknown";
      else if (cd.deleted || (cd.reasons_not_servable ?? []).includes("EXPIRED")) status = "ended";
      else if (cd.entity_status === "PAUSED" || cd.entity_status === "DRAFT") status = "paused";
      else if (statuses.includes("active")) status = "active";
      else if (statuses.length && statuses.every((s) => s === "rejected")) status = "rejected";
      else if (statuses.includes("in_review")) status = "in_review";
      else if (statuses.length && statuses.every((s) => s === "paused" || s === "rejected")) status = "paused";
      else status = cd.entity_status === "ACTIVE" ? "active" : "unknown";

      const rejected = Object.entries(byCreative).filter(([, v]) => v.status === "rejected").map(([k]) => k);
      const all = [...totals.values()];
      return {
        spend: round2(all.reduce((a, t) => a + t.spend, 0)),
        currency: c.refs.currency || "USD",
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

    async setDailyBudget(c: Launched, amount: number): Promise<void> {
      if (!(Number.isFinite(amount) && amount > 0)) fail(`invalid daily budget ${amount}`);
      await setCampaign(c.campaignId, { daily_budget_amount_local_micro: toMicro(amount) });
    },

    async setAdActive(c: Launched, key: string, active: boolean): Promise<void> {
      if (!(key in c.ads)) fail(`unknown creative key ${key}`);
      const pts = await promotedTweets(c.refs.lineItemId!);
      const tweetId = tweetIdOf(c, key, pts);
      if (!tweetId) fail(`no post id for creative ${key}`);
      const live = pts.filter((p) => !p.deleted && p.tweet_id === tweetId);
      if (active) {
        if (live.length) return;
        await call(`${acct}/promoted_tweets`, { method: "POST", form: { line_item_id: c.refs.lineItemId!, tweet_ids: tweetId } });
      } else {
        for (const p of live) await call(`${acct}/promoted_tweets/${p.id}`, { method: "DELETE" });
      }
    },

    async accountInfo(): Promise<AdAccountInfo> {
      const { fundingInstrumentId: _fi, ...rest } = await describeAccount(call, creds.adsAccountId, creds.fundingInstrumentId);
      return rest;
    },

    async checkIdentity(identity: Identity) {
      if (identity.platform !== "x") return { ok: false as const, problem: `identity is for ${identity.platform}, not x` };
      const problem = await identityProblem(call, creds.adsAccountId, identity.ref);
      return problem ? { ok: false as const, problem } : { ok: true as const };
    },

    async ensureConversions(): Promise<ConversionSetup> {
      const tags = (await call<{ data?: XWebTag[] }>(`${acct}/web_event_tags`, { query: { count: 1000 } })).data ?? [];
      const refs: Record<string, string> = {};
      for (const [event, def] of Object.entries(CONVERSION_TAGS)) {
        let tag = tags.find((t) => !t.deleted && t.name === def.name);
        if (!tag) {
          const res = await call<{ data?: XWebTag }>(`${acct}/web_event_tags`, {
            method: "POST",
            form: { name: def.name, type: def.type, click_window: "30", view_through_window: "1", retargeting_enabled: "false" },
          });
          tag = res.data;
        }
        if (!tag?.id || !tag.website_tag_id) fail(`web event tag "${def.name}" has no id / website_tag_id`);
        refs[event] = tag.id;
        refs[`${event}Pixel`] = tag.website_tag_id;
      }
      return { platform: "x", refs };
    },

    async sendConversions(setup: ConversionSetup, events: Conversion[]) {
      const rejected: Array<{ eventId: string; why: string }> = [];
      const groups = new Map<string, { eventTag: string; items: Conversion[] }>();
      for (const e of events) {
        const tag = setup.refs[e.name];
        const pixel = setup.refs[`${e.name}Pixel`];
        if (!tag || !pixel) {
          rejected.push({ eventId: e.eventId, why: `no X web event tag for "${e.name}" (run ensureConversions)` });
          continue;
        }
        // X matches by twclid or hashed email; day2 never sends emails, and external ids are not an X identifier.
        if (e.click.param !== "twclid" || !e.click.value) {
          rejected.push({ eventId: e.eventId, why: "no twclid click id" });
          continue;
        }
        if (Number.isNaN(new Date(e.at).getTime())) {
          rejected.push({ eventId: e.eventId, why: `invalid time ${e.at}` });
          continue;
        }
        const g = groups.get(`${pixel}/${tag}`) ?? { eventTag: tag, items: [] };
        g.items.push(e);
        groups.set(`${pixel}/${tag}`, g);
      }
      let sent = 0;
      for (const [k, g] of groups) {
        const pixel = k.split("/")[0]!;
        for (let i = 0; i < g.items.length; i += CAPI_BATCH) {
          const batch = g.items.slice(i, i + CAPI_BATCH);
          const res = await call<{ data?: { conversions_processed?: number } }>(`${ADS_BASE}/measurement/conversions/${pixel}`, {
            method: "POST",
            json: {
              conversions: batch.map((e) => ({
                conversion_time: new Date(e.at).toISOString(),
                event_id: `tw-${pixel}-${g.eventTag}`,
                identifiers: identifiersOf(e),
                conversion_id: e.eventId,
                description: `day2 ${e.name}`,
              })),
            },
          });
          const processed = res?.data?.conversions_processed ?? 0;
          sent += processed;
          // X reports only a count; when nothing went through, every event in the batch was refused.
          if (processed === 0) for (const e of batch) rejected.push({ eventId: e.eventId, why: "X processed 0 conversions in this batch" });
        }
      }
      return { sent, rejected };
    },
  };
}
