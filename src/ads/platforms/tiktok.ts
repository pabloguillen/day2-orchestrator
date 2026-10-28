import { createHash } from "node:crypto";
import { fit, request, type RequestInit2 } from "../http";
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

/**
 * TikTok API for Business (Marketing API) v1.3.
 *
 * Every call carries the long-lived advertiser access token in the
 * `Access-Token` header. TikTok answers HTTP 200 with an envelope
 * `{ code, message, request_id, data }`; anything but `code: 0` is an error.
 *
 * Structure per launch: one campaign (TRAFFIC, or WEB_CONVERSIONS when
 * optimising for sign-ups; created DISABLED, unlimited campaign budget) →
 * one ad group (daily budget in the account's currency, TikTok placement,
 * website promotion) → one single-video ad per creative shown as the app's
 * custom identity. The campaign is enabled only after everything exists; on
 * any failure it is deleted.
 *
 * Conversions go server-to-server through the Events API 2.0
 * (`/event/track/`) to a web pixel day2 owns on the advertiser.
 */

export const API_VERSION = "v1.3";
export const DEFAULT_BASE = "https://business-api.tiktok.com/open_api/v1.3";

/** Ad group daily budget minimum in USD (BUDGET_MODE_DAY). Other currencies: the caller converts. */
const MIN_DAILY_USD = 20;
/** ad_text: 1–100 characters. */
const AD_TEXT_MAX = 100;
/** Custom identity display name. */
const DISPLAY_NAME_MAX = 40;
/** Name of the web pixel day2 creates (and finds again) on the advertiser. */
export const PIXEL_NAME = "day2 conversions";
/** Events API batch size (TikTok accepts up to 1,000 events per request). */
const EVENTS_BATCH = 500;

const VIDEO_MIMES = ["video/mp4", "video/quicktime", "video/mpeg", "video/3gpp", "video/x-msvideo"];
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

export const info: PlatformInfo = {
  id: "tiktok",
  name: "TikTok",
  formats: [
    { kind: "video", ratio: "9:16", width: 1080, height: 1920, minDurationSec: 5, maxDurationSec: 60, maxBytes: MAX_VIDEO_BYTES, mimes: VIDEO_MIMES },
    { kind: "video", ratio: "1:1", width: 1080, height: 1080, minDurationSec: 5, maxDurationSec: 60, maxBytes: MAX_VIDEO_BYTES, mimes: VIDEO_MIMES },
    { kind: "video", ratio: "16:9", width: 1920, height: 1080, minDurationSec: 5, maxDurationSec: 60, maxBytes: MAX_VIDEO_BYTES, mimes: VIDEO_MIMES },
  ],
  textOnly: false,
  // TikTok in-feed ads have no headline field (the identity's display name
  // sits above the caption); the headline is only used as a fallback caption.
  copyLimits: { headline: AD_TEXT_MAX, body: AD_TEXT_MAX },
  minDailyUsd: MIN_DAILY_USD,
  clickIdParam: "ttclid",
  identity: "custom",
  audiences: ["consumer"],
  env: ["TIKTOK_ACCESS_TOKEN", "TIKTOK_ADVERTISER_ID"],
  apiVersion: API_VERSION,
};

export type TikTokCreds = {
  accessToken: string;
  advertiserId: string;
  /** Override for the sandbox (https://sandbox-ads.tiktok.com/open_api/v1.3). */
  baseUrl?: string;
};

export function credentialsFromEnv(env: Record<string, string | undefined>): TikTokCreds | null {
  const accessToken = env.TIKTOK_ACCESS_TOKEN?.trim();
  const advertiserId = env.TIKTOK_ADVERTISER_ID?.trim();
  if (!accessToken || !advertiserId) return null;
  const baseUrl = env.TIKTOK_API_BASE?.trim();
  return { accessToken, advertiserId, ...(baseUrl ? { baseUrl } : {}) };
}

/** day2 CTA → TikTok call_to_action enum. TikTok has no "Get started"; Learn more is valid for every website ad. */
export const CTA: Record<CallToAction, string> = {
  learn_more: "LEARN_MORE",
  sign_up: "SIGN_UP",
  download: "DOWNLOAD_NOW",
  get_started: "LEARN_MORE",
};

/** day2 conversion → Events API event name. "activated" has no standard equivalent, so it is a custom event. */
export const EVENT_NAMES: Record<Conversion["name"], string> = {
  signup: "CompleteRegistration",
  activated: "Activated",
};
/** Ad group optimization_event for the pixel's Complete Registration event. */
const SIGNUP_OPTIMIZATION_EVENT = "ON_WEB_REGISTER";

/** TikTok envelope codes that mean "slow down" (QPS / frequency limits). */
const RATE_LIMIT_CODES = new Set([40100]);
/** Server-side failures: worth retrying later, but not blindly re-sent here (a create may have gone through). */
const isSystemCode = (code: number) => code >= 50000 && code < 60000;

type Envelope<T> = { code: number; message?: string; request_id?: string; data?: T };

/**
 * One call to the Marketing API: Access-Token header (when given), the
 * `{code, message, data}` envelope unwrapped, rate-limit codes retried with
 * backoff, every other non-zero code thrown as PlatformError.
 */
export async function tiktokCall<T>(deps: PlatformDeps, url: string, token: string | null, init: RequestInit2 = {}): Promise<T> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const path = new URL(url).pathname.replace(/^\/open_api\/v[\d.]+/, "");
  const attempts = 3;
  for (let i = 0; ; i++) {
    const res = await request<Envelope<T>>("tiktok", deps, url, {
      ...init,
      headers: { ...(token ? { "Access-Token": token } : {}), ...(init.headers ?? {}) },
    });
    if (!res || typeof res !== "object" || typeof res.code !== "number") {
      throw new PlatformError("tiktok", `unexpected response from ${path}`);
    }
    if (res.code === 0) return res.data as T;
    const rateLimited = RATE_LIMIT_CODES.has(res.code) || /too (many|frequent)|rate limit|qps/i.test(res.message ?? "");
    // A rate-limited request was not executed, so resending it is safe.
    if (rateLimited && i < attempts - 1) {
      await sleep(1000 * 2 ** i);
      continue;
    }
    const msg = `${path} failed: ${res.message ?? "error"} (code ${res.code}${res.request_id ? `, request_id ${res.request_id}` : ""})`;
    throw new PlatformError("tiktok", msg, undefined, rateLimited || isSystemCode(res.code));
  }
}

/** GET query values: arrays/objects JSON-encoded, as TikTok expects. */
export function tiktokQuery(q: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(q)) if (v !== undefined) out[k] = typeof v === "object" ? JSON.stringify(v) : (v as string | number | boolean);
  return out;
}

export type AdvertiserRow = { advertiser_id?: string | number; name?: string; currency?: string; status?: string };
export const ADVERTISER_FIELDS = ["advertiser_id", "name", "currency", "status"];

const ADVERTISER_PROBLEMS: Record<string, string> = {
  STATUS_DISABLE: "The ad account is disabled.",
  STATUS_PENDING_CONFIRM: "The ad account is still under review by TikTok.",
  STATUS_PENDING_VERIFIED: "The ad account is waiting for verification.",
  STATUS_CONFIRM_FAIL: "TikTok rejected the ad account's review.",
  STATUS_CONFIRM_FAIL_END: "TikTok rejected the ad account's review.",
  STATUS_PENDING_CONFIRM_MODIFY: "Changes to the ad account are under review.",
  STATUS_CONFIRM_MODIFY_FAIL: "TikTok rejected changes to the ad account.",
  STATUS_LIMIT: "The ad account is restricted by TikTok.",
  STATUS_WAIT_FOR_BPM_AUDIT: "The ad account is waiting for Business Center review.",
  STATUS_WAIT_FOR_PUBLIC_AUTH: "The ad account is waiting for authorization.",
  STATUS_SELF_SERVICE_UNAUDITED: "The ad account's business details haven't been verified yet.",
  STATUS_CONTRACT_PENDING: "The ad account's contract hasn't taken effect yet.",
};

/** advertiser/info row → day2's account view. Only STATUS_ENABLE can deliver ads. */
export function advertiserInfo(row: AdvertiserRow, fallbackId: string): AdAccountInfo {
  const status = row.status ?? "";
  const canSpend = status === "STATUS_ENABLE";
  return {
    id: String(row.advertiser_id ?? fallbackId),
    name: row.name ?? String(row.advertiser_id ?? fallbackId),
    currency: (row.currency ?? "").toUpperCase(),
    canSpend,
    ...(canSpend ? {} : { problem: ADVERTISER_PROBLEMS[status] ?? `The ad account can't run ads (${status || "unknown status"}).` }),
  };
}

const AGE_GROUPS: Array<[min: number, max: number, key: string]> = [
  [13, 17, "AGE_13_17"],
  [18, 24, "AGE_18_24"],
  [25, 34, "AGE_25_34"],
  [35, 44, "AGE_35_44"],
  [45, 54, "AGE_45_54"],
  [55, 100, "AGE_55_100"],
];

/**
 * TikTok age buckets for [ageMin, ageMax]. Strict on the lower bound (never
 * reach anyone younger than ageMin) unless that leaves nothing, then the
 * overlapping buckets (still never under 18 unless ageMin is under 18).
 */
export function ageGroups(ageMin: number, ageMax?: number): string[] {
  const max = ageMax ?? 100;
  const strict = AGE_GROUPS.filter(([lo]) => lo >= ageMin && lo <= max);
  const chosen = strict.length ? strict : AGE_GROUPS.filter(([lo, hi]) => hi >= ageMin && lo <= max && (lo >= 18 || ageMin < 18));
  return chosen.map(([, , k]) => k);
}

const money = (n: number) => Math.round(n * 100) / 100;

function utcStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** TikTok wants external_id SHA-256 hashed; day2's id may already be a SHA-256 hex digest. */
export function hashExternalId(id: string): string {
  const t = id.trim();
  return /^[a-f0-9]{64}$/.test(t) ? t : createHash("sha256").update(t.toLowerCase()).digest("hex");
}

/** secondary_status of one ad → day2 status. */
export function adStatus(secondary: string | undefined, operation?: string): CampaignStatus {
  const s = secondary ?? "";
  if (/AUDIT_DENY|_DENY$|NOT_APPROVED|_BAD$/.test(s)) return "rejected";
  if (s === "AD_STATUS_DELIVERY_OK" || s === "AD_STATUS_DELIVERY_AND_REAUDIT" || s === "AD_STATUS_REVIEW_PARTIALLY_APPROVED") return "active";
  if (/(^|_)(DISABLE|CAMPAIGN_DISABLE|ADGROUP_DISABLE)$/.test(s)) return "paused";
  if (/DELETE|TIME_DONE|CLOSED/.test(s)) return "ended";
  if (/AUDIT|REAUDIT|NOT_START|PRE_ONLINE/.test(s)) return "in_review";
  if (/BUDGET_EXCEED|BALANCE_EXCEED|CAMPAIGN_EXCEED/.test(s)) return "active";
  if (operation === "DISABLE") return "paused";
  return "unknown";
}

/** Several ads → one campaign-level status. */
function overall(statuses: CampaignStatus[]): CampaignStatus {
  if (!statuses.length) return "unknown";
  for (const s of ["active", "paused", "in_review"] as const) if (statuses.includes(s)) return s;
  if (statuses.every((s) => s === "rejected")) return "rejected";
  if (statuses.includes("ended")) return "ended";
  return statuses.includes("rejected") ? "rejected" : "unknown";
}

export function create(creds: TikTokCreds, deps: PlatformDeps = {}): AdPlatform {
  const base = (creds.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  const adv = creds.advertiserId;
  const now = deps.now ?? (() => new Date());
  /** ISO country → TikTok location_id, filled from /tool/region/ once per instance. */
  let regions: Map<string, string> | null = null;
  /** The advertiser's currency, read once (it can't change on TikTok). */
  let currency: string | null = null;

  const call = <T>(path: string, init: RequestInit2 = {}) => tiktokCall<T>(deps, `${base}${path}`, creds.accessToken, init);
  const get = <T>(path: string, query: Record<string, unknown>) => call<T>(path, { method: "GET", query: tiktokQuery({ advertiser_id: adv, ...query }) });
  const post = <T>(path: string, body: Record<string, unknown>) => call<T>(path, { method: "POST", json: { advertiser_id: adv, ...body } });

  async function accountInfo(): Promise<AdAccountInfo> {
    const data = await call<{ list?: AdvertiserRow[] }>("/advertiser/info/", {
      method: "GET",
      query: tiktokQuery({ advertiser_ids: [adv], fields: ADVERTISER_FIELDS }),
    });
    const row = data?.list?.find((r) => String(r.advertiser_id) === adv) ?? data?.list?.[0];
    if (!row) throw new PlatformError("tiktok", `advertiser ${adv} not found or not authorized`);
    const acc = advertiserInfo(row, adv);
    if (acc.currency) currency = acc.currency;
    return acc;
  }

  async function accountCurrency(): Promise<string> {
    if (currency) return currency;
    const acc = await accountInfo();
    if (!acc.currency) throw new PlatformError("tiktok", "advertiser/info returned no currency", undefined, true);
    return acc.currency;
  }

  function fileName(asset: Asset, what: string): string {
    // File names must be unique in the ad account's library.
    return `day2-${what}-${asset.id}-${now().getTime()}`;
  }

  async function uploadImageByUrl(url: string, name: string): Promise<string> {
    const form = new FormData();
    form.set("advertiser_id", adv);
    form.set("upload_type", "UPLOAD_BY_URL");
    form.set("image_url", url);
    form.set("file_name", name);
    const data = await call<{ image_id?: string } | Array<{ image_id?: string }>>("/file/image/ad/upload/", { method: "POST", multipart: form });
    const id = (Array.isArray(data) ? data[0] : data)?.image_id;
    if (!id) throw new PlatformError("tiktok", "image upload returned no image_id");
    return id;
  }

  async function uploadVideoByUrl(asset: Asset): Promise<string> {
    const form = new FormData();
    form.set("advertiser_id", adv);
    form.set("upload_type", "UPLOAD_BY_URL");
    form.set("video_url", asset.url);
    form.set("file_name", fileName(asset, "video"));
    const data = await call<{ video_id?: string } | Array<{ video_id?: string }>>("/file/video/ad/upload/", { method: "POST", multipart: form });
    const id = (Array.isArray(data) ? data[0] : data)?.video_id;
    if (!id) throw new PlatformError("tiktok", "video upload returned no video_id");
    return id;
  }

  /** Cover image for a video: day2's thumbnail, else TikTok's own first frame. */
  async function coverImage(video: Asset, videoId: string): Promise<string> {
    if (video.thumbnail) return uploadImageByUrl(video.thumbnail.url, fileName(video.thumbnail, "cover"));
    const data = await get<{ list?: Array<{ video_id?: string; video_cover_url?: string }> }>("/file/video/ad/info/", { video_ids: [videoId] });
    const cover = data?.list?.find((v) => v.video_id === videoId)?.video_cover_url ?? data?.list?.[0]?.video_cover_url;
    if (!cover) throw new PlatformError("tiktok", `no cover image available for video ${video.id}`);
    return uploadImageByUrl(cover, fileName(video, "cover"));
  }

  async function locationIds(countries: string[]): Promise<string[]> {
    if (!regions) {
      const data = await get<{ region_info?: Array<{ location_id?: string | number; region_code?: string; level?: string; area_type?: string }> }>("/tool/region/", {
        placements: ["PLACEMENT_TIKTOK"],
        objective_type: "TRAFFIC",
        level_range: "TO_COUNTRY",
      });
      const m = new Map<string, string>();
      for (const r of data?.region_info ?? []) {
        const lvl = r.level ?? r.area_type;
        if (r.region_code && r.location_id !== undefined && (!lvl || lvl === "COUNTRY")) m.set(r.region_code.toUpperCase(), String(r.location_id));
      }
      if (!m.size) throw new PlatformError("tiktok", "tool/region returned no countries", undefined, true);
      regions = m;
    }
    const out: string[] = [];
    const missing: string[] = [];
    for (const c of countries) {
      const id = regions.get(c.toUpperCase());
      if (id) out.push(id);
      else missing.push(c);
    }
    if (missing.length) throw new PlatformError("tiktok", `countries not available for TikTok ads: ${missing.join(", ")}`);
    return out;
  }

  async function setCampaignStatus(campaignId: string, status: "ENABLE" | "DISABLE" | "DELETE") {
    await post("/campaign/status/update/", { campaign_ids: [campaignId], operation_status: status });
  }

  async function findIdentity(displayName: string): Promise<{ identity_id: string; display_name: string } | undefined> {
    for (let page = 1; page <= 20; page++) {
      const data = await get<{
        identity_list?: Array<{ identity_id?: string; identity_type?: string; display_name?: string }>;
        page_info?: { total_page?: number };
      }>("/identity/get/", { identity_type: "CUSTOMIZED_USER", page, page_size: 100 });
      const hit = data?.identity_list?.find((i) => i.identity_id && (i.display_name ?? "").trim() === displayName);
      if (hit?.identity_id) return { identity_id: hit.identity_id, display_name: hit.display_name ?? displayName };
      if (!data?.page_info?.total_page || page >= data.page_info.total_page) return undefined;
    }
    return undefined;
  }

  type PixelRow = { pixel_id?: string | number; pixel_code?: string; pixel_name?: string };
  async function findPixel(name: string): Promise<PixelRow | undefined> {
    for (let page = 1; page <= 20; page++) {
      const data = await get<{ pixels?: PixelRow[]; page_info?: { total_page?: number } }>("/pixel/list/", { name, page, page_size: 20 });
      const hit = data?.pixels?.find((p) => p.pixel_id !== undefined && p.pixel_code && (p.pixel_name ?? "").trim() === name);
      if (hit) return hit;
      if (!data?.page_info?.total_page || page >= data.page_info.total_page) return undefined;
    }
    return undefined;
  }

  /** Best effort: why TikTok's review rejected these ads. */
  async function rejectionReason(adIds: string[]): Promise<string> {
    const fallback = "Ad rejected by TikTok review";
    try {
      type Review = { review_status?: string; reject_info?: Array<{ reasons?: string[] | string; suggestion?: string }> };
      const data = await get<{ ad_review_map?: Record<string, Review>; ad_review_infos?: Array<Review & { ad_id?: string }> }>("/ad/review_info/", { ad_ids: adIds });
      const reviews: Review[] = data?.ad_review_map ? Object.values(data.ad_review_map) : (data?.ad_review_infos ?? []);
      const texts = new Set<string>();
      for (const r of reviews)
        for (const ri of r.reject_info ?? []) {
          for (const reason of Array.isArray(ri.reasons) ? ri.reasons : ri.reasons ? [ri.reasons] : []) texts.add(reason);
          if (ri.suggestion) texts.add(`Suggestion: ${ri.suggestion}`);
        }
      return texts.size ? [...texts].join("; ") : fallback;
    } catch {
      return fallback;
    }
  }

  return {
    id: "tiktok",

    accountInfo,

    async ensureIdentity(app) {
      const displayName = fit(app.displayName, DISPLAY_NAME_MAX);
      if (!displayName) throw new PlatformError("tiktok", "identity display name is empty");
      const existing = await findIdentity(displayName);
      if (existing) return { platform: "tiktok", ref: existing.identity_id, displayName, logo: app.logo };
      if (app.logo.kind !== "image" || app.logo.width !== app.logo.height) {
        throw new PlatformError("tiktok", "identity logo must be a square image");
      }
      const imageId = await uploadImageByUrl(app.logo.url, fileName(app.logo, "avatar"));
      const data = await post<{ identity_id?: string }>("/identity/create/", { display_name: displayName, image_uri: imageId });
      if (!data?.identity_id) throw new PlatformError("tiktok", "identity/create returned no identity_id");
      return { platform: "tiktok", ref: data.identity_id, displayName, logo: app.logo } satisfies Identity;
    },

    async ensureConversions(): Promise<ConversionSetup> {
      let pixel = await findPixel(PIXEL_NAME);
      if (!pixel) {
        const created = await post<PixelRow>("/pixel/create/", { pixel_name: PIXEL_NAME });
        if (created?.pixel_id === undefined || !created.pixel_code) throw new PlatformError("tiktok", "pixel/create returned no pixel_id/pixel_code");
        pixel = created;
      }
      return { platform: "tiktok", refs: { pixelId: String(pixel.pixel_id), pixelCode: String(pixel.pixel_code) } };
    },

    async sendConversions(setup, events) {
      const pixelCode = setup.refs.pixelCode;
      if (setup.platform !== "tiktok" || !pixelCode) throw new PlatformError("tiktok", "conversion setup has no TikTok pixel code (run ensureConversions)");
      const rejected: Array<{ eventId: string; why: string }> = [];
      const valid: Array<{ e: Conversion; payload: Record<string, unknown> }> = [];
      for (const e of events) {
        const t = Date.parse(e.at);
        if (!Number.isFinite(t)) {
          rejected.push({ eventId: e.eventId, why: `invalid time "${e.at}"` });
          continue;
        }
        if (e.click.param !== "ttclid" || !e.click.value) {
          rejected.push({ eventId: e.eventId, why: `not a TikTok click (${e.click.param})` });
          continue;
        }
        valid.push({
          e,
          payload: {
            event: EVENT_NAMES[e.name],
            event_time: Math.floor(t / 1000),
            event_id: e.eventId,
            user: {
              ttclid: e.click.value,
              ...(e.externalId ? { external_id: hashExternalId(e.externalId) } : {}),
              // Sent as-is (TikTok does not want ip / user_agent hashed).
              ...(e.clientIp ? { ip: e.clientIp } : {}),
              ...(e.userAgent ? { user_agent: e.userAgent } : {}),
            },
            page: { url: e.pageUrl },
          },
        });
      }
      let sent = 0;
      for (let i = 0; i < valid.length; i += EVENTS_BATCH) {
        const chunk = valid.slice(i, i + EVENTS_BATCH);
        try {
          await call("/event/track/", {
            method: "POST",
            json: { event_source: "web", event_source_id: pixelCode, data: chunk.map((c) => c.payload) },
          });
          sent += chunk.length;
        } catch (err) {
          // Outages / rate limits: let the caller retry the whole batch later (dedup by event_id makes that safe).
          if (err instanceof PlatformError && err.retryable) throw err;
          const why = err instanceof Error ? err.message : String(err);
          for (const c of chunk) rejected.push({ eventId: c.e.eventId, why });
        }
      }
      return { sent, rejected };
    },

    async launch(spec: LaunchSpec): Promise<Launched> {
      // ---- Validate everything before creating anything. ----
      if (!spec.identity || spec.identity.platform !== "tiktok") {
        throw new PlatformError("tiktok", "launch needs a TikTok custom identity (call ensureIdentity first)");
      }
      const budget = money(spec.dailyBudget);
      if (!(budget > 0)) throw new PlatformError("tiktok", `invalid daily budget ${spec.dailyBudget}`);
      const specCurrency = spec.currency.toUpperCase();
      if (specCurrency === "USD" && budget < MIN_DAILY_USD) throw new PlatformError("tiktok", `daily budget ${budget} USD is below TikTok's ad group minimum of ${MIN_DAILY_USD} USD`);
      const signups = spec.optimizeFor === "signups";
      const pixelId = spec.conversion?.refs.pixelId;
      if (signups && (spec.conversion?.platform !== "tiktok" || !pixelId)) {
        throw new PlatformError("tiktok", "optimizing for sign-ups needs a TikTok pixel (run ensureConversions)");
      }
      if (!spec.targeting.countries.length) throw new PlatformError("tiktok", "no target countries");
      const creatives = spec.creatives.filter((c) => c.asset?.kind === "video");
      if (!creatives.length) throw new PlatformError("tiktok", "TikTok needs at least one video creative");
      for (const c of creatives) {
        const a = c.asset!;
        if (a.durationSec !== undefined && (a.durationSec < 5 || a.durationSec > 600)) throw new PlatformError("tiktok", `video ${a.id} is ${a.durationSec}s (TikTok accepts 5–600s, 5–60s recommended)`);
        if (a.bytes > MAX_VIDEO_BYTES) throw new PlatformError("tiktok", `video ${a.id} exceeds 500 MB`);
      }
      // Budgets are in the advertiser's currency: never send an amount meant for another one.
      const accCurrency = await accountCurrency();
      if (accCurrency !== specCurrency) {
        throw new PlatformError("tiktok", `budget is in ${specCurrency} but the TikTok ad account bills in ${accCurrency}`);
      }
      const location_ids = await locationIds(spec.targeting.countries);

      // ---- Upload media (no spend risk; nothing to clean up). ----
      const media: Array<{ videoId: string; coverId: string }> = [];
      for (const c of creatives) {
        const videoId = await uploadVideoByUrl(c.asset!);
        media.push({ videoId, coverId: await coverImage(c.asset!, videoId) });
      }

      // ---- Campaign (disabled) → ad group → ads → enable. ----
      const camp = await post<{ campaign_id?: string }>("/campaign/create/", {
        campaign_name: fit(spec.campaignName, 512),
        objective_type: signups ? "WEB_CONVERSIONS" : "TRAFFIC",
        budget_mode: "BUDGET_MODE_INFINITE",
        operation_status: "DISABLE",
      });
      const campaignId = camp?.campaign_id;
      if (!campaignId) throw new PlatformError("tiktok", "campaign/create returned no campaign_id");

      try {
        const languages = [...new Set(spec.targeting.languages.map((l) => l.toLowerCase().slice(0, 2)).filter(Boolean))];
        const optimization = signups
          ? { optimization_goal: "CONVERT", pixel_id: pixelId, optimization_event: SIGNUP_OPTIMIZATION_EVENT, billing_event: "OCPM" }
          : { optimization_goal: "CLICK", billing_event: "CPC" };
        const ag = await post<{ adgroup_id?: string }>("/adgroup/create/", {
          campaign_id: campaignId,
          adgroup_name: fit(`${spec.campaignName} · ad group`, 512),
          promotion_type: "WEBSITE",
          placement_type: "PLACEMENT_TYPE_NORMAL",
          placements: ["PLACEMENT_TIKTOK"],
          location_ids,
          ...(languages.length ? { languages } : {}),
          age_groups: ageGroups(spec.targeting.ageMin, spec.targeting.ageMax),
          gender: "GENDER_UNLIMITED",
          budget_mode: "BUDGET_MODE_DAY",
          budget,
          schedule_type: "SCHEDULE_FROM_NOW",
          schedule_start_time: utcStamp(now()),
          ...optimization,
          bid_type: "BID_TYPE_NO_BID",
          pacing: "PACING_MODE_SMOOTH",
          operation_status: "ENABLE",
        });
        const adgroupId = ag?.adgroup_id;
        if (!adgroupId) throw new PlatformError("tiktok", "adgroup/create returned no adgroup_id");

        const ads: Record<string, string> = {};
        for (const [i, c] of creatives.entries()) {
          const m = media[i]!;
          const data = await post<{ ad_ids?: string[] }>("/ad/create/", {
            adgroup_id: adgroupId,
            creatives: [
              {
                ad_name: fit(`${spec.campaignName} ${c.key}`, 512),
                ad_format: "SINGLE_VIDEO",
                identity_type: "CUSTOMIZED_USER",
                identity_id: spec.identity.ref,
                video_id: m.videoId,
                image_ids: [m.coverId],
                ad_text: fit(c.copy.body || c.copy.headline, AD_TEXT_MAX),
                call_to_action: CTA[c.copy.cta],
                landing_page_url: c.link ?? spec.link,
                ...(spec.aiContent || c.asset!.aiGenerated || c.asset!.aiPerson ? { aigc_disclosure_type: "SELF_DISCLOSURE" } : {}),
              },
            ],
          });
          const adId = data?.ad_ids?.[0];
          if (!adId) throw new PlatformError("tiktok", `ad/create returned no ad_id for ${c.key}`);
          ads[c.key] = String(adId);
        }

        await setCampaignStatus(campaignId, "ENABLE");
        return { platform: "tiktok", campaignId, refs: { adgroupId }, ads };
      } catch (err) {
        try {
          await setCampaignStatus(campaignId, "DELETE");
        } catch {
          // Still DISABLED, so it cannot spend; surface the original error.
        }
        if (err instanceof PlatformError) throw err;
        throw new PlatformError("tiktok", `launch failed: ${(err as Error).message}`);
      }
    },

    async stats(c: Launched): Promise<AdStats> {
      const cur = await accountCurrency();
      const report = await get<{ list?: Array<{ dimensions?: { ad_id?: string | number }; metrics?: Record<string, string | number> }> }>("/report/integrated/get/", {
        report_type: "BASIC",
        data_level: "AUCTION_AD",
        dimensions: ["ad_id"],
        metrics: ["spend", "impressions", "clicks"],
        query_lifetime: true,
        filtering: [{ field_name: "campaign_ids", filter_type: "IN", filter_value: JSON.stringify([c.campaignId]) }],
        page: 1,
        page_size: 1000,
      });
      const byAd = new Map<string, { spend: number; impressions: number; clicks: number }>();
      for (const row of report?.list ?? []) {
        const id = row.dimensions?.ad_id;
        if (id === undefined) continue;
        byAd.set(String(id), { spend: num(row.metrics?.spend), impressions: num(row.metrics?.impressions), clicks: num(row.metrics?.clicks) });
      }

      const adData = await get<{ list?: Array<{ ad_id?: string | number; secondary_status?: string; operation_status?: string }> }>("/ad/get/", {
        filtering: { campaign_ids: [c.campaignId] },
        fields: ["ad_id", "secondary_status", "operation_status"],
        page: 1,
        page_size: 100,
      });
      const status = new Map<string, CampaignStatus>();
      for (const a of adData?.list ?? []) if (a.ad_id !== undefined) status.set(String(a.ad_id), adStatus(a.secondary_status, a.operation_status));

      let spend = 0;
      let impressions = 0;
      let clicks = 0;
      for (const m of byAd.values()) {
        spend += m.spend;
        impressions += m.impressions;
        clicks += m.clicks;
      }
      const byCreative: NonNullable<AdStats["byCreative"]> = {};
      for (const [key, adId] of Object.entries(c.ads)) {
        byCreative[key] = { ...(byAd.get(adId) ?? { spend: 0, impressions: 0, clicks: 0 }), status: status.get(adId) ?? "unknown" };
      }

      // Campaign status from the ads that are still meant to run (paused single ads don't make the campaign "paused").
      const all = Object.values(c.ads).map((id) => status.get(id)).filter((s): s is CampaignStatus => !!s);
      const out: AdStats = { spend: money(spend), currency: cur, impressions, clicks, status: overall(all), byCreative };

      const rejectedIds = Object.values(c.ads).filter((id) => status.get(id) === "rejected");
      if (rejectedIds.length) out.rejection = await rejectionReason(rejectedIds);
      return out;
    },

    async pause(c) {
      await setCampaignStatus(c.campaignId, "DISABLE");
    },

    async resume(c) {
      await setCampaignStatus(c.campaignId, "ENABLE");
    },

    async setAdActive(c, key, active) {
      const adId = c.ads[key];
      if (!adId) throw new PlatformError("tiktok", `no ad for creative "${key}" in campaign ${c.campaignId}`);
      await post("/ad/status/update/", { ad_ids: [adId], operation_status: active ? "ENABLE" : "DISABLE" });
    },

    async setDailyBudget(c, amount) {
      const budget = money(amount);
      if (!(budget > 0)) throw new PlatformError("tiktok", `invalid daily budget ${amount}`);
      const adgroupId = c.refs.adgroupId;
      if (!adgroupId) throw new PlatformError("tiktok", "launched campaign has no adgroupId ref");
      if ((await accountCurrency()) === "USD" && budget < MIN_DAILY_USD) {
        throw new PlatformError("tiktok", `daily budget ${budget} USD is below TikTok's ad group minimum of ${MIN_DAILY_USD} USD`);
      }
      await post("/adgroup/update/", { adgroup_id: adgroupId, budget });
    },
  };
}
