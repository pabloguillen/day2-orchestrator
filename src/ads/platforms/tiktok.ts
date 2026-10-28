import { fit, request, type RequestInit2 } from "../http";
import {
  PlatformError,
  type AdPlatform,
  type AdStats,
  type Asset,
  type CallToAction,
  type CampaignStatus,
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
 * Structure per launch: one TRAFFIC campaign (created DISABLED, unlimited
 * campaign budget) → one ad group (daily budget, TikTok placement, website
 * promotion, CPC on clicks) → one single-video ad per creative shown as the
 * app's custom identity. The campaign is enabled only after everything
 * exists; on any failure it is deleted.
 */

export const API_VERSION = "v1.3";
const DEFAULT_BASE = "https://business-api.tiktok.com/open_api/v1.3";

/** Ad group daily budget minimum (USD) for BUDGET_MODE_DAY. */
const MIN_DAILY_USD = 20;
/** ad_text: 1–100 characters (12–100 recommended). */
const AD_TEXT_MAX = 100;
/** Custom identity display name. */
const DISPLAY_NAME_MAX = 40;

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

/** TikTok envelope codes that mean "slow down" (QPS / frequency limits). */
const RATE_LIMIT_CODES = new Set([40100]);
/** Server-side failures: worth retrying later, but not blindly re-sent here (a create may have gone through). */
const isSystemCode = (code: number) => code >= 50000 && code < 60000;

type Envelope<T> = { code: number; message?: string; request_id?: string; data?: T };

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

const money = (usd: number) => Math.round(usd * 100) / 100;

function utcStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

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
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /** ISO country → TikTok location_id, filled from /tool/region/ once per instance. */
  let regions: Map<string, string> | null = null;

  async function call<T>(path: string, init: RequestInit2 = {}): Promise<T> {
    const attempts = 3;
    for (let i = 0; ; i++) {
      const res = await request<Envelope<T>>("tiktok", deps, `${base}${path}`, {
        ...init,
        headers: { "Access-Token": creds.accessToken, ...(init.headers ?? {}) },
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

  const get = <T>(path: string, query: Record<string, unknown>) =>
    call<T>(path, {
      method: "GET",
      query: Object.fromEntries(
        Object.entries({ advertiser_id: adv, ...query })
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : (v as string | number | boolean)]),
      ),
    });
  const post = <T>(path: string, body: Record<string, unknown>) => call<T>(path, { method: "POST", json: { advertiser_id: adv, ...body } });

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

  return {
    id: "tiktok",

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

    async launch(spec: LaunchSpec): Promise<Launched> {
      // ---- Validate everything before touching the account. ----
      if (!spec.identity || spec.identity.platform !== "tiktok") {
        throw new PlatformError("tiktok", "launch needs a TikTok custom identity (call ensureIdentity first)");
      }
      const budget = money(spec.dailyBudgetUsd);
      if (!(budget >= MIN_DAILY_USD)) throw new PlatformError("tiktok", `daily budget $${spec.dailyBudgetUsd} is below TikTok's ad group minimum of $${MIN_DAILY_USD}`);
      if (!spec.targeting.countries.length) throw new PlatformError("tiktok", "no target countries");
      const creatives = spec.creatives.filter((c) => c.asset?.kind === "video");
      if (!creatives.length) throw new PlatformError("tiktok", "TikTok needs at least one video creative");
      for (const c of creatives) {
        const a = c.asset!;
        if (a.durationSec !== undefined && (a.durationSec < 5 || a.durationSec > 600)) throw new PlatformError("tiktok", `video ${a.id} is ${a.durationSec}s (TikTok accepts 5–600s, 5–60s recommended)`);
        if (a.bytes > MAX_VIDEO_BYTES) throw new PlatformError("tiktok", `video ${a.id} exceeds 500 MB`);
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
        objective_type: "TRAFFIC",
        budget_mode: "BUDGET_MODE_INFINITE",
        operation_status: "DISABLE",
      });
      const campaignId = camp?.campaign_id;
      if (!campaignId) throw new PlatformError("tiktok", "campaign/create returned no campaign_id");

      try {
        const languages = [...new Set(spec.targeting.languages.map((l) => l.toLowerCase().slice(0, 2)).filter(Boolean))];
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
          optimization_goal: "CLICK",
          billing_event: "CPC",
          bid_type: "BID_TYPE_NO_BID",
          pacing: "PACING_MODE_SMOOTH",
          operation_status: "ENABLE",
        });
        const adgroupId = ag?.adgroup_id;
        if (!adgroupId) throw new PlatformError("tiktok", "adgroup/create returned no adgroup_id");

        const ads: Record<string, string> = {};
        for (const [i, c] of creatives.entries()) {
          const m = media[i]!;
          const adText = fit(c.copy.body || c.copy.headline, AD_TEXT_MAX);
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
                ad_text: adText,
                call_to_action: CTA[c.copy.cta],
                landing_page_url: spec.link,
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
      const byAd = new Map<string, { spendUsd: number; impressions: number; clicks: number }>();
      for (const row of report?.list ?? []) {
        const id = row.dimensions?.ad_id;
        if (id === undefined) continue;
        byAd.set(String(id), { spendUsd: num(row.metrics?.spend), impressions: num(row.metrics?.impressions), clicks: num(row.metrics?.clicks) });
      }

      const adData = await get<{ list?: Array<{ ad_id?: string | number; secondary_status?: string; operation_status?: string }> }>("/ad/get/", {
        filtering: { campaign_ids: [c.campaignId] },
        fields: ["ad_id", "secondary_status", "operation_status"],
        page: 1,
        page_size: 100,
      });
      const status = new Map<string, CampaignStatus>();
      for (const a of adData?.list ?? []) if (a.ad_id !== undefined) status.set(String(a.ad_id), adStatus(a.secondary_status, a.operation_status));

      const byCreative: NonNullable<AdStats["byCreative"]> = {};
      let spend = 0;
      let impressions = 0;
      let clicks = 0;
      for (const m of byAd.values()) {
        spend += m.spendUsd;
        impressions += m.impressions;
        clicks += m.clicks;
      }
      for (const [key, adId] of Object.entries(c.ads)) {
        const m = byAd.get(adId) ?? { spendUsd: 0, impressions: 0, clicks: 0 };
        byCreative[key] = { ...m, status: status.get(adId) ?? "unknown" };
      }

      const known = Object.values(c.ads).map((id) => status.get(id)).filter((s): s is CampaignStatus => !!s);
      const out: AdStats = { spendUsd: money(spend), impressions, clicks, status: overall(known), byCreative };

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

    async setDailyBudget(c, usd) {
      const budget = money(usd);
      if (!(budget >= MIN_DAILY_USD)) throw new PlatformError("tiktok", `daily budget $${usd} is below TikTok's ad group minimum of $${MIN_DAILY_USD}`);
      const adgroupId = c.refs.adgroupId;
      if (!adgroupId) throw new PlatformError("tiktok", "launched campaign has no adgroupId ref");
      await post("/adgroup/update/", { adgroup_id: adgroupId, budget });
    },
  };

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
}
