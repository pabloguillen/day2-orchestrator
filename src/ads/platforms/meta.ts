import { createHash, createHmac } from "node:crypto";
import { assetBytes, fit, poll, request, type RequestInit2 } from "../http";
import {
  PlatformError,
  type AdAccountInfo,
  type AdPlatform,
  type AdStats,
  type Asset,
  type AssetSpec,
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

/**
 * Meta (Facebook + Instagram) through the Marketing API (Graph API).
 *
 * Launch: account check → locale lookup → media uploads (adimages,
 * advideos by file_url, poll until ready) → ad creatives → campaign
 * (PAUSED) → ad set → ads → campaign ACTIVE. Nothing can deliver until the
 * last call; if anything fails after the campaign exists, the campaign
 * (and with it its ad sets and ads) is deleted, or paused if deletion fails.
 *
 * optimizeFor "clicks": OUTCOME_TRAFFIC, LINK_CLICKS.
 * optimizeFor "signups": OUTCOME_LEADS, OFFSITE_CONVERSIONS on the pixel's
 * CompleteRegistration event (promoted_object pixel_id + custom_event_type).
 * Both: budget on the ad set in the account currency's minor unit,
 * IMPRESSIONS billing, WEBSITE destination, Advantage+ placements (no
 * publisher_platforms → Meta picks Facebook/Instagram/… placements).
 *
 * Conversions go to the pixel/dataset through the Conversions API.
 *
 * Docs: https://developers.facebook.com/documentation/ads-commerce/marketing-api
 */

export const META_API_VERSION = "v26.0";
export const GRAPH = "https://graph.facebook.com";

export type MetaCreds = {
  accessToken: string;
  /** Always "act_<digits>". */
  adAccountId: string;
  appSecret?: string;
  apiVersion: string;
  /**
   * Who pays for the ads, for EU DSA transparency (dsa_payor). When unset,
   * the ad account's saved DSA defaults apply.
   */
  dsaPayor?: string;
};

const MB = 1024 * 1024;
const IMG_MIMES = ["image/jpeg", "image/png"];
const VID_MIMES = ["video/mp4", "video/quicktime"];
// Meta accepts videos up to 4 GB; day2 caps at 1 GB so the URL fetch stays reliable.
const VID_BYTES = 1024 * MB;
const IMG_BYTES = 30 * MB;
// 1–60 s fits every Advantage+ placement at once (Instagram feed caps at 60 s, Reels ads at 90 s).
const vid = (ratio: AssetSpec["ratio"], width: number, height: number): AssetSpec => ({ kind: "video", ratio, width, height, minDurationSec: 1, maxDurationSec: 60, maxBytes: VID_BYTES, mimes: VID_MIMES });
const img = (ratio: AssetSpec["ratio"], width: number, height: number): AssetSpec => ({ kind: "image", ratio, width, height, maxBytes: IMG_BYTES, mimes: IMG_MIMES });

export const info: PlatformInfo = {
  id: "meta",
  name: "Meta (Facebook + Instagram)",
  formats: [vid("9:16", 1080, 1920), img("1:1", 1080, 1080), vid("4:5", 1080, 1350), img("4:5", 1080, 1350), vid("1:1", 1080, 1080), img("9:16", 1080, 1920), img("1.91:1", 1200, 628)],
  textOnly: false,
  // Display limits before "See more" / truncation (hard limits are longer).
  copyLimits: { headline: 40, body: 125, description: 30 },
  // Meta's floor for IMPRESSIONS billing is $1/day; below ~$5/day an ad set barely leaves learning.
  minDailyUsd: 5,
  clickIdParam: "fbclid",
  identity: "app_account",
  identityHelp:
    "The app's Facebook Page must be shared with day2's business (and its system user) with the Advertise task; Identity.ref is the Page id, or \"<pageId>:<instagramUserId>\" to also run as the app's Instagram account.",
  audiences: ["consumer", "business"],
  env: ["META_ACCESS_TOKEN", "DAY2_META_AD_ACCOUNT_ID"],
  apiVersion: META_API_VERSION,
};

export const normalizeAccountId = (raw: string): string | null => {
  const digits = raw.trim().replace(/^act_/, "");
  return /^\d+$/.test(digits) ? `act_${digits}` : null;
};

/** META_ACCESS_TOKEN, DAY2_META_AD_ACCOUNT_ID (with or without "act_"); optional META_APP_SECRET, META_API_VERSION, DAY2_META_DSA_PAYOR. */
export function credentialsFromEnv(env: Record<string, string | undefined>): MetaCreds | null {
  const accessToken = env.META_ACCESS_TOKEN?.trim();
  const adAccountId = normalizeAccountId(env.DAY2_META_AD_ACCOUNT_ID ?? "");
  if (!accessToken || !adAccountId) return null;
  const version = env.META_API_VERSION?.trim();
  return {
    accessToken,
    adAccountId,
    appSecret: env.META_APP_SECRET?.trim() || undefined,
    apiVersion: version && /^v\d+\.\d+$/.test(version) ? version : META_API_VERSION,
    dsaPayor: env.DAY2_META_DSA_PAYOR?.trim() || "day2",
  };
}

const CTA: Record<CallToAction, string> = { learn_more: "LEARN_MORE", sign_up: "SIGN_UP", download: "DOWNLOAD", get_started: "GET_STARTED" };

/**
 * Meta's currency offsets (https://developers.facebook.com/documentation/ads-commerce/marketing-api/currencies):
 * budgets and bids are integers in 1/offset of the currency. These have
 * offset 1 (whole units); every other supported currency has 100. Note Meta
 * uses 1 for TWD and HUF although ISO 4217 gives them minor units.
 */
const OFFSET_1 = new Set(["CLP", "COP", "CRC", "HUF", "ISK", "IDR", "JPY", "KRW", "PYG", "TWD", "VND"]);
const OFFSET_100 = new Set(
  "DZD ARS AUD BHD BDT BOB BGN BRL GBP CAD CNY HRK CZK DKK EGP EUR GTQ HNL HKD INR ILS JOD KES LVL LTL MOP MYR MXN NZD NIO NGN NOK PKR PEN PHP PLN QAR RON RUB SAR RSD SGD SKK ZAR SEK CHF THB TRY AED UAH USD UYU VEF VES".split(" "),
);
export function currencyOffset(currency: string): number {
  const c = currency.toUpperCase();
  if (OFFSET_1.has(c)) return 1;
  if (OFFSET_100.has(c)) return 100;
  throw new PlatformError("meta", `currency ${currency} is not supported by Meta ads`);
}
const toMinor = (amount: number, currency: string): number => {
  const v = Math.round(amount * currencyOffset(currency));
  if (!Number.isFinite(amount) || v < 1) throw new PlatformError("meta", `daily budget must be positive (got ${amount} ${currency})`);
  return v;
};

/** EU + EEA: ads reaching them need dsa_beneficiary / dsa_payor on the ad set (or account defaults). */
const DSA_COUNTRIES = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO".split(" "));

/** ISO 639-1 → the English name Meta's locale search uses. */
const LANGUAGE_NAMES: Record<string, string> = {
  ar: "Arabic", bg: "Bulgarian", ca: "Catalan", cs: "Czech", da: "Danish", de: "German", el: "Greek", en: "English", es: "Spanish", et: "Estonian",
  fi: "Finnish", fr: "French", he: "Hebrew", hi: "Hindi", hr: "Croatian", hu: "Hungarian", id: "Indonesian", it: "Italian", ja: "Japanese", ko: "Korean",
  lt: "Lithuanian", lv: "Latvian", ms: "Malay", nb: "Norwegian", nl: "Dutch", no: "Norwegian", pl: "Polish", pt: "Portuguese", ro: "Romanian", ru: "Russian",
  sk: "Slovak", sl: "Slovenian", sr: "Serbian", sv: "Swedish", th: "Thai", tl: "Tagalog", tr: "Turkish", uk: "Ukrainian", vi: "Vietnamese", zh: "Chinese",
};

/** Conversions API event names. "activated" has no standard event, so it is a custom event. */
const EVENT_NAMES: Record<Conversion["name"], string> = { signup: "CompleteRegistration", activated: "Activated" };
const SIGNUP_EVENT_TYPE = "COMPLETE_REGISTRATION";
const PIXEL_NAME = "day2";
const CAPI_BATCH = 1000;
const CAPI_MAX_AGE_MS = 7 * 24 * 3600_000;

/** Graph API error codes that mean "throttled / temporarily unavailable" (sent as HTTP 400). */
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80000, 80003, 80004, 80005, 80008, 80014]);

/** account_status / disable_reason (https://developers.facebook.com/docs/marketing-api/reference/ad-account/). */
const DISABLE_REASONS: Record<number, string> = {
  1: "ads integrity policy", 2: "intellectual property review", 3: "payment risk", 4: "account shut down", 5: "ads review", 6: "business integrity review",
  7: "permanently closed", 8: "unused reseller account", 9: "unused account", 10: "umbrella ad account", 11: "Business Manager integrity policy",
  12: "misrepresented ad account", 13: "legal entity de-shared", 14: "thread review", 15: "compromised ad account",
};
export function describeAccount(a: { account_status?: number; disable_reason?: number }): { canSpend: boolean; problem?: string } {
  switch (a.account_status) {
    case 1:
      return { canSpend: true };
    case 9:
      return { canSpend: true, problem: "in grace period: settle the outstanding balance soon" };
    case 2: {
      const why = a.disable_reason ? DISABLE_REASONS[a.disable_reason] : undefined;
      return { canSpend: false, problem: `disabled${why ? ` (${why})` : ""}` };
    }
    case 3:
      return { canSpend: false, problem: "unsettled: pay the outstanding balance in Billing" };
    case 7:
      return { canSpend: false, problem: "pending risk review" };
    case 8:
      return { canSpend: false, problem: "pending settlement" };
    case 100:
      return { canSpend: false, problem: "pending closure" };
    case 101:
      return { canSpend: false, problem: "closed" };
    default:
      return { canSpend: false, problem: `unknown account status ${a.account_status ?? "(none)"}` };
  }
}

type GraphError = { message?: string; type?: string; code?: number; error_subcode?: number; error_user_title?: string; error_user_msg?: string; is_transient?: boolean };
type Id = { id: string };
type AdRow = { id: string; name?: string; effective_status?: string; ad_review_feedback?: { global?: Record<string, string> } };
type InsightRow = { ad_id?: string; spend?: string; impressions?: string; inline_link_clicks?: string; account_currency?: string };
type Paged<T> = { data?: T[]; paging?: { cursors?: { after?: string }; next?: string } };

export function graphMessage(err: PlatformError): { text: string; transient: boolean; code?: number } {
  const raw = err.message.replace(/^meta: /, "");
  const json = raw.replace(/^\d+\s+/, "");
  try {
    const e = (JSON.parse(json) as { error?: GraphError }).error;
    if (e) {
      const text = [e.error_user_title, e.error_user_msg ?? e.message].filter(Boolean).join(": ") + (e.code !== undefined ? ` (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""})` : "");
      return { text, transient: Boolean(e.is_transient) || (e.code !== undefined && TRANSIENT_CODES.has(e.code)), code: e.code };
    }
  } catch {
    /* not JSON */
  }
  return { text: raw, transient: false };
}

/** `retries`: attempts on 429/5xx/network errors (default 3); 1 = none — for calls that create something and must never repeat on their own. */
export type GraphCall = <T>(what: string, method: "GET" | "POST" | "DELETE", path: string, opts?: { form?: Record<string, unknown>; query?: RequestInit2["query"]; retries?: number }) => Promise<T>;

/**
 * Graph API calls with one token: OAuth header (never in the URL),
 * appsecret_proof when the app secret is known, nested values JSON-encoded
 * in the form body, Graph throttling codes (sent as HTTP 400) retryable.
 */
export function graphClient(o: { token: string; appSecret?: string; apiVersion: string }, deps: PlatformDeps): GraphCall {
  const base = `${GRAPH}/${o.apiVersion}`;
  const proof = o.appSecret ? createHmac("sha256", o.appSecret).update(o.token).digest("hex") : undefined;
  return async <T>(what: string, method: "GET" | "POST" | "DELETE", path: string, opts: { form?: Record<string, unknown>; query?: RequestInit2["query"]; retries?: number } = {}): Promise<T> => {
    const form = opts.form ? Object.fromEntries(Object.entries(opts.form).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])) : undefined;
    try {
      return await request<T>("meta", deps, `${base}/${path}`, {
        method,
        headers: { authorization: `OAuth ${o.token}` },
        form,
        query: { ...opts.query, appsecret_proof: proof },
        ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
      });
    } catch (err) {
      if (!(err instanceof PlatformError)) throw err;
      const { text, transient } = graphMessage(err);
      throw new PlatformError("meta", `${what}: ${text}`, err.status, err.retryable || transient);
    }
  };
}

/** Reads every page of a Graph edge (cursor paging), up to `max` rows. */
export async function graphAll<T>(graph: GraphCall, what: string, path: string, query: RequestInit2["query"], max = 2000): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (;;) {
    const r = await graph<Paged<T>>(what, "GET", path, { query: { ...query, after } });
    out.push(...(r.data ?? []));
    after = r.paging?.cursors?.after;
    if (!r.paging?.next || !after || out.length >= max) return out;
  }
}

/** SHA-256 hex of a normalised value, unless it already is one (Meta's hashing rules for external_id). */
const sha256 = (v: string): string => (/^[a-f0-9]{64}$/.test(v) ? v : createHash("sha256").update(v.trim().toLowerCase()).digest("hex"));

export function create(creds: MetaCreds, deps: PlatformDeps = {}): AdPlatform {
  const graph = graphClient({ token: creds.accessToken, appSecret: creds.appSecret, apiVersion: creds.apiVersion }, deps);
  const now = () => (deps.now ? deps.now() : new Date()).getTime();
  const localeCache = new Map<string, number[]>();
  let accountCurrency: string | undefined;

  async function account() {
    const a = await graph<{ id?: string; name?: string; currency?: string; account_status?: number; disable_reason?: number }>("ad account", "GET", creds.adAccountId, {
      query: { fields: "id,name,currency,account_status,disable_reason" },
    });
    if (a.currency) accountCurrency = a.currency;
    return a;
  }

  async function currencyOf(c: Launched): Promise<string> {
    return c.refs.currency ?? accountCurrency ?? (await account()).currency ?? "USD";
  }

  async function locales(languages: string[]): Promise<number[]> {
    const out = new Set<number>();
    for (const code of languages) {
      const name = LANGUAGE_NAMES[code.toLowerCase().slice(0, 2)];
      if (!name) continue; // unknown language: don't restrict on it
      let keys = localeCache.get(name);
      if (!keys) {
        const r = await graph<{ data?: Array<{ key: number; name: string }> }>("locale lookup", "GET", "search", { query: { type: "adlocale", q: name, limit: 50 } });
        const rows = r.data ?? [];
        const all = rows.find((l) => l.name === `${name} (All)`);
        const exact = rows.find((l) => l.name === name);
        keys = all ? [all.key] : exact ? [exact.key] : rows.filter((l) => l.name.startsWith(`${name} (`) && !/upside down|pirate/i.test(l.name)).map((l) => l.key);
        localeCache.set(name, keys);
      }
      for (const k of keys) out.add(k);
    }
    return [...out];
  }

  async function uploadImage(a: Asset, cache: Map<string, string>): Promise<string> {
    const hit = cache.get(a.id);
    if (hit) return hit;
    const bytes = await assetBytes(deps, a);
    const r = await graph<{ images?: Record<string, { hash?: string }> }>(`image upload ${a.id}`, "POST", `${creds.adAccountId}/adimages`, { form: { bytes: Buffer.from(bytes).toString("base64") } });
    const hash = Object.values(r.images ?? {})[0]?.hash;
    if (!hash) throw new PlatformError("meta", `image upload ${a.id}: no hash returned`);
    cache.set(a.id, hash);
    return hash;
  }

  /** Uploads a video by URL, waits until Meta has processed it, returns its id and a thumbnail. */
  async function uploadVideo(a: Asset, images: Map<string, string>): Promise<{ videoId: string; thumb: { image_hash: string } | { image_url: string } }> {
    const { id: videoId } = await graph<Id>(`video upload ${a.id}`, "POST", `${creds.adAccountId}/advideos`, { form: { file_url: a.url, name: a.id } });
    const thumbHash = a.thumbnail ? await uploadImage(a.thumbnail, images) : undefined;
    await poll(
      deps,
      async () => {
        const r = await graph<{ status?: { video_status?: string } }>(`video status ${a.id}`, "GET", videoId, { query: { fields: "status" } });
        const s = r.status?.video_status;
        if (s === "ready") return true;
        if (s === "error" || s === "expired") throw new PlatformError("meta", `video ${a.id} failed processing (${s})`);
        return undefined;
      },
      { platform: "meta", what: `video ${a.id} processing`, everyMs: 5000, timeoutMs: 15 * 60_000 },
    );
    if (thumbHash) return { videoId, thumb: { image_hash: thumbHash } };
    const t = await graph<{ data?: Array<{ uri: string; is_preferred?: boolean }> }>(`video thumbnails ${a.id}`, "GET", `${videoId}/thumbnails`, { query: { fields: "uri,is_preferred" } });
    const uri = (t.data?.find((x) => x.is_preferred) ?? t.data?.[0])?.uri;
    if (!uri) throw new PlatformError("meta", `video ${a.id}: no thumbnail available`);
    return { videoId, thumb: { image_url: uri } };
  }

  async function setStatus(id: string, status: "ACTIVE" | "PAUSED", what: string) {
    await graph(what, "POST", id, { form: { status } });
  }

  /** Builds one Conversions API event, or says why it can't be sent. */
  function capiEvent(e: Conversion): { event: Record<string, unknown> } | { why: string } {
    const ms = Date.parse(e.at);
    if (!Number.isFinite(ms)) return { why: `invalid time ${e.at}` };
    if (now() - ms > CAPI_MAX_AGE_MS) return { why: "older than 7 days (Meta rejects it)" };
    // Website events need the visitor's browser and IP (not hashed): https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/customer-information-parameters
    if (!e.clientIp && !e.userAgent) return { why: "no client IP or user agent (Meta needs them for website events)" };
    const user_data: Record<string, unknown> = {};
    if (e.clientIp) user_data.client_ip_address = e.clientIp;
    if (e.userAgent) user_data.client_user_agent = e.userAgent;
    // fbc = fb.<subdomain index>.<creation time ms>.<fbclid>, not hashed. The click time isn't known, so the conversion time stands in.
    if (e.click.param === "fbclid" && e.click.value) user_data.fbc = `fb.1.${Math.min(ms, now())}.${e.click.value}`;
    if (e.externalId) user_data.external_id = [sha256(e.externalId)];
    if (!user_data.fbc && !user_data.external_id) return { why: "no fbclid or external id to match on" };
    return {
      event: {
        event_name: EVENT_NAMES[e.name],
        event_time: Math.floor(ms / 1000),
        event_id: e.eventId,
        action_source: "website",
        event_source_url: e.pageUrl,
        user_data,
      },
    };
  }

  return {
    id: "meta",

    async launch(spec: LaunchSpec): Promise<Launched> {
      if (!spec.identity?.ref) throw new PlatformError("meta", "launch needs the app's Facebook Page (identity)");
      if (!spec.creatives.length) throw new PlatformError("meta", "launch needs at least one creative");
      if (spec.creatives.some((c) => !c.asset)) throw new PlatformError("meta", "Meta ads need an image or video for every creative");
      if (!spec.targeting.countries.length) throw new PlatformError("meta", "launch needs at least one country");
      const pixelId = spec.conversion?.refs.pixelId;
      if (spec.optimizeFor === "signups" && !pixelId) throw new PlatformError("meta", "optimizing for sign-ups needs a conversion setup with a pixel (ensureConversions)");
      const budgetMinor = toMinor(spec.dailyBudget, spec.currency);
      const [pageId, igUserId] = spec.identity.ref.split(":");

      // Budgets are in the account currency: make sure day2 and Meta agree on it.
      const acct = await account();
      if ((acct.currency ?? "").toUpperCase() !== spec.currency.toUpperCase()) throw new PlatformError("meta", `ad account currency is ${acct.currency ?? "unknown"}, but the budget is in ${spec.currency}`);
      const state = describeAccount(acct);
      if (!state.canSpend) throw new PlatformError("meta", `ad account can't spend: ${state.problem}`);

      const t = spec.targeting;
      const ageMin = Math.min(65, Math.max(13, Math.round(t.ageMin || 18)));
      const ageMax = t.ageMax ? Math.min(65, Math.max(ageMin, Math.round(t.ageMax))) : undefined;
      const localeKeys = await locales(t.languages);
      const countries = [...new Set(t.countries.map((c) => c.toUpperCase()))];

      // Media and creatives first: they can't spend, so a failure here leaves nothing running.
      const images = new Map<string, string>();
      const creativeIds: Array<{ key: string; creativeId: string }> = [];
      const media: Array<{ key: string; story: Record<string, unknown> }> = [];
      for (const c of spec.creatives) {
        const a = c.asset as Asset;
        const link = c.link ?? spec.link;
        const headline = fit(c.copy.headline, info.copyLimits.headline);
        const body = fit(c.copy.body, info.copyLimits.body);
        const description = c.copy.description ? fit(c.copy.description, info.copyLimits.description ?? 30) : undefined;
        const call_to_action = { type: CTA[c.copy.cta], value: { link } };
        let story: Record<string, unknown>;
        if (a.kind === "video") {
          const v = await uploadVideo(a, images);
          story = { video_data: { video_id: v.videoId, ...v.thumb, message: body, title: headline, link_description: description, call_to_action } };
        } else {
          const hash = await uploadImage(a, images);
          story = { link_data: { image_hash: hash, link, message: body, name: headline, description, call_to_action } };
        }
        media.push({ key: c.key, story });
      }
      for (const m of media) {
        const r = await graph<Id>(`creative ${m.key}`, "POST", `${creds.adAccountId}/adcreatives`, {
          form: { name: `${spec.campaignName} · ${m.key}`, object_story_spec: { page_id: pageId, ...(igUserId ? { instagram_user_id: igUserId } : {}), ...m.story } },
        });
        creativeIds.push({ key: m.key, creativeId: r.id });
      }

      const signups = spec.optimizeFor === "signups";
      const { id: campaignId } = await graph<Id>("campaign", "POST", `${creds.adAccountId}/campaigns`, {
        form: {
          name: spec.campaignName,
          objective: signups ? "OUTCOME_LEADS" : "OUTCOME_TRAFFIC",
          status: "PAUSED",
          buying_type: "AUCTION",
          special_ad_categories: [],
          is_adset_budget_sharing_enabled: "false",
        },
      });

      try {
        const targeting: Record<string, unknown> = {
          geo_locations: { countries },
          age_min: ageMin,
          ...(ageMax ? { age_max: ageMax } : {}),
          ...(localeKeys.length ? { locales: localeKeys } : {}),
          // Keep day2's targeting exact (Advantage+ audience would reset ages and widen the audience).
          targeting_automation: { advantage_audience: 0 },
        };
        const eu = countries.some((c) => DSA_COUNTRIES.has(c));
        const { id: adSetId } = await graph<Id>("ad set", "POST", `${creds.adAccountId}/adsets`, {
          form: {
            name: `${spec.campaignName} · ad set`,
            campaign_id: campaignId,
            daily_budget: String(budgetMinor),
            billing_event: "IMPRESSIONS",
            optimization_goal: signups ? "OFFSITE_CONVERSIONS" : "LINK_CLICKS",
            ...(signups ? { promoted_object: { pixel_id: pixelId, custom_event_type: SIGNUP_EVENT_TYPE } } : {}),
            bid_strategy: "LOWEST_COST_WITHOUT_CAP",
            destination_type: "WEBSITE",
            targeting,
            status: "ACTIVE",
            ...(eu && creds.dsaPayor ? { dsa_beneficiary: spec.identity.displayName || spec.appName, dsa_payor: creds.dsaPayor } : {}),
          },
        });
        const ads: Record<string, string> = {};
        for (const c of creativeIds) {
          const r = await graph<Id>(`ad ${c.key}`, "POST", `${creds.adAccountId}/ads`, {
            form: { name: `${spec.campaignName} · ${c.key}`, adset_id: adSetId, creative: { creative_id: c.creativeId }, status: "ACTIVE" },
          });
          ads[c.key] = r.id;
        }
        await setStatus(campaignId, "ACTIVE", "campaign activation");
        return { platform: "meta", campaignId, refs: { adSetId, adAccountId: creds.adAccountId, currency: spec.currency.toUpperCase() }, ads };
      } catch (err) {
        let cleanup = "deleted the campaign";
        try {
          await graph("rollback delete", "DELETE", campaignId, {});
        } catch {
          try {
            await setStatus(campaignId, "PAUSED", "rollback pause");
            cleanup = "paused the campaign (delete failed)";
          } catch {
            cleanup = `could NOT delete or pause campaign ${campaignId} — check it by hand`;
          }
        }
        const e = err instanceof PlatformError ? err : new PlatformError("meta", (err as Error).message);
        throw new PlatformError("meta", `launch failed, ${cleanup}: ${e.message.replace(/^meta: /, "")}`, e.status, e.retryable);
      }
    },

    async stats(c: Launched): Promise<AdStats> {
      const camp = await graph<{ effective_status?: string }>("campaign status", "GET", c.campaignId, { query: { fields: "effective_status" } });
      const adRows = await graphAll<AdRow>(graph, "ads status", `${c.campaignId}/ads`, { fields: "id,name,effective_status,ad_review_feedback", limit: 200 });
      const insRows = await graphAll<InsightRow>(graph, "insights", `${c.campaignId}/insights`, {
        level: "ad",
        date_preset: "maximum",
        fields: "ad_id,spend,impressions,inline_link_clicks,account_currency",
        limit: 500,
      });

      let currency = c.refs.currency ?? insRows.find((r) => r.account_currency)?.account_currency;
      currency ??= await currencyOf(c);
      const offset = currencyOffset(currency);
      const keyOf = new Map(Object.entries(c.ads).map(([k, id]) => [id, k]));
      const minor: Record<string, number> = {};
      const byCreative: NonNullable<AdStats["byCreative"]> = {};
      for (const key of Object.keys(c.ads)) byCreative[key] = { spend: 0, impressions: 0, clicks: 0 };

      let spendMinor = 0;
      let impressions = 0;
      let clicks = 0;
      for (const r of insRows) {
        if (r.account_currency && r.account_currency !== currency) throw new PlatformError("meta", `insights are in ${r.account_currency}, expected ${currency}`);
        // Insights spend is a decimal string in the account currency; sum in minor units to avoid float drift.
        const s = Math.round(Number(r.spend ?? 0) * offset) || 0;
        const i = Number(r.impressions ?? 0) || 0;
        const k = Number(r.inline_link_clicks ?? 0) || 0;
        spendMinor += s;
        impressions += i;
        clicks += k;
        const key = r.ad_id ? keyOf.get(r.ad_id) : undefined;
        const slot = key ? byCreative[key] : undefined;
        if (key && slot) {
          minor[key] = (minor[key] ?? 0) + s;
          slot.spend = (minor[key] ?? 0) / offset;
          slot.impressions += i;
          slot.clicks += k;
        }
      }

      const reasons: string[] = [];
      const adStatuses: CampaignStatus[] = [];
      for (const ad of adRows) {
        const st = mapAdStatus(ad.effective_status);
        adStatuses.push(st);
        const key = keyOf.get(ad.id);
        const slot = key ? byCreative[key] : undefined;
        if (slot) slot.status = st;
        if (st === "rejected") {
          const why = Object.values(ad.ad_review_feedback?.global ?? {}).filter(Boolean);
          reasons.push(`${key ?? ad.id}: ${why.length ? why.join(" ") : "disapproved"}`);
        }
      }

      const out: AdStats = { spend: spendMinor / offset, currency, impressions, clicks, status: overallStatus(camp.effective_status, adStatuses), byCreative };
      if (reasons.length) out.rejection = reasons.join("; ");
      return out;
    },

    async pause(c) {
      await setStatus(c.campaignId, "PAUSED", "pause");
    },

    async resume(c) {
      await setStatus(c.campaignId, "ACTIVE", "resume");
    },

    async setDailyBudget(c, amount) {
      const adSetId = c.refs.adSetId;
      if (!adSetId) throw new PlatformError("meta", "no ad set id stored for this campaign");
      await graph("set daily budget", "POST", adSetId, { form: { daily_budget: String(toMinor(amount, await currencyOf(c))) } });
    },

    async setAdActive(c, key, active) {
      const adId = c.ads[key];
      if (!adId) throw new PlatformError("meta", `no ad for creative ${key} in this campaign`);
      await setStatus(adId, active ? "ACTIVE" : "PAUSED", `${active ? "activate" : "pause"} ad ${key}`);
    },

    async accountInfo(): Promise<AdAccountInfo> {
      const a = await account();
      return { id: a.id ?? creds.adAccountId, name: a.name ?? "", currency: a.currency ?? "", ...describeAccount(a) };
    },

    async checkIdentity(identity: Identity) {
      const [pageId, igUserId] = identity.ref.split(":");
      if (!pageId || !/^\d+$/.test(pageId)) return { ok: false as const, problem: `"${identity.ref}" is not a Facebook Page id` };
      // Pages assigned to day2's (system) user, with the tasks it may perform on each.
      const pages = await graphAll<{ id: string; name?: string; tasks?: string[] }>(graph, "page access check", "me/accounts", { fields: "id,name,tasks", limit: 100 });
      const page = pages.find((p) => p.id === pageId);
      if (!page) return { ok: false as const, problem: `day2 has no access to Page ${pageId}: the Page owner must approve day2's access request (Meta Business Suite → Requests), then assign day2's system user to it` };
      if (!page.tasks?.includes("ADVERTISE")) return { ok: false as const, problem: `day2 can see Page ${page.name ?? pageId} but lacks the Advertise task on it` };
      if (igUserId && !/^\d+$/.test(igUserId)) return { ok: false as const, problem: `"${igUserId}" is not an Instagram account id` };
      return { ok: true as const };
    },

    async ensureConversions(): Promise<ConversionSetup> {
      const list = () => graphAll<{ id: string; name?: string }>(graph, "list pixels", `${creds.adAccountId}/adspixels`, { fields: "id,name", limit: 100 });
      const pick = (ps: Array<{ id: string; name?: string }>) => ps.find((p) => p.name === PIXEL_NAME) ?? ps[0];
      let pixel = pick(await list());
      if (!pixel) {
        try {
          pixel = await graph<Id>("create pixel", "POST", `${creds.adAccountId}/adspixels`, { form: { name: PIXEL_NAME } });
        } catch (err) {
          // 6200/6202: the account already has a pixel (created meanwhile or not listed) — use it.
          const again = pick(await list());
          if (!again) throw err;
          pixel = again;
        }
      }
      return { platform: "meta", refs: { pixelId: pixel.id, adAccountId: creds.adAccountId } };
    },

    async sendConversions(setup, events) {
      const pixelId = setup.refs.pixelId;
      if (!pixelId) throw new PlatformError("meta", "conversion setup has no pixel id");
      const rejected: Array<{ eventId: string; why: string }> = [];
      const ready: Array<{ eventId: string; event: Record<string, unknown> }> = [];
      for (const e of events) {
        const r = capiEvent(e);
        if ("why" in r) rejected.push({ eventId: e.eventId, why: r.why });
        else ready.push({ eventId: e.eventId, event: r.event });
      }
      const post = (batch: typeof ready) => graph<{ events_received?: number }>("conversions", "POST", `${pixelId}/events`, { form: { data: batch.map((b) => b.event) } });
      let sent = 0;
      for (let i = 0; i < ready.length; i += CAPI_BATCH) {
        const batch = ready.slice(i, i + CAPI_BATCH);
        try {
          sent += (await post(batch)).events_received ?? batch.length;
        } catch (err) {
          // Outages / throttling: let the caller retry later (event_id makes resends safe).
          if (!(err instanceof PlatformError) || err.retryable) throw err;
          if (batch.length === 1) {
            rejected.push({ eventId: batch[0]!.eventId, why: err.message.replace(/^meta: conversions: /, "") });
            continue;
          }
          // One bad event fails the whole request; resend one by one (duplicates are dropped by event_id).
          for (const b of batch) {
            try {
              sent += (await post([b])).events_received ?? 1;
            } catch (e1) {
              if (!(e1 instanceof PlatformError) || e1.retryable) throw e1;
              rejected.push({ eventId: b.eventId, why: e1.message.replace(/^meta: conversions: /, "") });
            }
          }
        }
      }
      return { sent, rejected };
    },
  };
}

function mapAdStatus(s: string | undefined): CampaignStatus {
  switch (s) {
    case "ACTIVE":
      return "active";
    case "PAUSED":
    case "CAMPAIGN_PAUSED":
    case "ADSET_PAUSED":
      return "paused";
    case "PENDING_REVIEW":
    case "IN_PROCESS":
    case "PREAPPROVED":
      return "in_review";
    case "DISAPPROVED":
      return "rejected";
    case "DELETED":
    case "ARCHIVED":
      return "ended";
    default:
      return "unknown";
  }
}

function overallStatus(campaign: string | undefined, ads: CampaignStatus[]): CampaignStatus {
  const c = mapAdStatus(campaign);
  if (c === "paused" || c === "ended") return c;
  if (c === "in_review") return "in_review";
  if (c !== "active") return "unknown";
  if (!ads.length) return "active";
  if (ads.includes("active")) return "active";
  if (ads.includes("in_review")) return "in_review";
  if (ads.every((a) => a === "rejected")) return "rejected";
  if (ads.every((a) => a === "rejected" || a === "paused" || a === "ended")) return ads.includes("rejected") ? "rejected" : "paused";
  return "unknown";
}
