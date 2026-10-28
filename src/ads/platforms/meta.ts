import { createHmac } from "node:crypto";
import { assetBytes, fit, poll, request, type RequestInit2 } from "../http";
import {
  PlatformError,
  type AdPlatform,
  type AdStats,
  type Asset,
  type AssetSpec,
  type CallToAction,
  type CampaignStatus,
  type Launched,
  type LaunchSpec,
  type PlatformDeps,
  type PlatformInfo,
} from "../types";

/**
 * Meta (Facebook + Instagram) through the Marketing API (Graph API), from
 * day2's own ad account.
 *
 * Launch: account check → locale lookup → media uploads (adimages,
 * advideos by file_url, poll until ready) → ad creatives → campaign
 * (PAUSED) → ad set → ads → campaign ACTIVE. Nothing can deliver until the
 * last call; if anything fails after the campaign exists, the campaign
 * (and with it its ad sets and ads) is deleted, or paused if deletion fails.
 *
 * Objective OUTCOME_TRAFFIC, budget on the ad set (cents of the account
 * currency, which must be USD), IMPRESSIONS billing, LINK_CLICKS
 * optimization, WEBSITE destination, Advantage+ placements (no
 * publisher_platforms → Meta picks Facebook/Instagram/… placements).
 *
 * Docs: https://developers.facebook.com/documentation/ads-commerce/marketing-api
 */

export const META_API_VERSION = "v26.0";
const GRAPH = "https://graph.facebook.com";

export type MetaCreds = {
  accessToken: string;
  /** Always "act_<digits>". */
  adAccountId: string;
  appSecret?: string;
  apiVersion: string;
  /** Who pays for the ads, for EU DSA transparency (dsa_payor). */
  dsaPayor: string;
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
  identity: "app_account",
  identityHelp:
    "The app's Facebook Page must be assigned to day2's business (and its system user) with ad permission; Identity.ref is the Page id, or \"<pageId>:<instagramUserId>\" to also run as the app's Instagram account.",
  audiences: ["consumer", "business"],
  env: ["META_ACCESS_TOKEN", "DAY2_META_AD_ACCOUNT_ID"],
  apiVersion: META_API_VERSION,
};

/** META_ACCESS_TOKEN, DAY2_META_AD_ACCOUNT_ID (with or without "act_"); optional META_APP_SECRET, META_API_VERSION, DAY2_META_DSA_PAYOR. */
export function credentialsFromEnv(env: Record<string, string | undefined>): MetaCreds | null {
  const accessToken = env.META_ACCESS_TOKEN?.trim();
  const rawAccount = env.DAY2_META_AD_ACCOUNT_ID?.trim();
  if (!accessToken || !rawAccount) return null;
  const digits = rawAccount.replace(/^act_/, "");
  if (!/^\d+$/.test(digits)) return null;
  const version = env.META_API_VERSION?.trim();
  return {
    accessToken,
    adAccountId: `act_${digits}`,
    appSecret: env.META_APP_SECRET?.trim() || undefined,
    apiVersion: version && /^v\d+\.\d+$/.test(version) ? version : META_API_VERSION,
    dsaPayor: env.DAY2_META_DSA_PAYOR?.trim() || "day2",
  };
}

const CTA: Record<CallToAction, string> = { learn_more: "LEARN_MORE", sign_up: "SIGN_UP", download: "DOWNLOAD", get_started: "GET_STARTED" };

/** EU + EEA: ads reaching them need dsa_beneficiary / dsa_payor on the ad set. */
const DSA_COUNTRIES = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO".split(" "));

/** ISO 639-1 → the English name Meta's locale search uses. */
const LANGUAGE_NAMES: Record<string, string> = {
  ar: "Arabic", bg: "Bulgarian", ca: "Catalan", cs: "Czech", da: "Danish", de: "German", el: "Greek", en: "English", es: "Spanish", et: "Estonian",
  fi: "Finnish", fr: "French", he: "Hebrew", hi: "Hindi", hr: "Croatian", hu: "Hungarian", id: "Indonesian", it: "Italian", ja: "Japanese", ko: "Korean",
  lt: "Lithuanian", lv: "Latvian", ms: "Malay", nb: "Norwegian", nl: "Dutch", no: "Norwegian", pl: "Polish", pt: "Portuguese", ro: "Romanian", ru: "Russian",
  sk: "Slovak", sl: "Slovenian", sr: "Serbian", sv: "Swedish", th: "Thai", tl: "Tagalog", tr: "Turkish", uk: "Ukrainian", vi: "Vietnamese", zh: "Chinese",
};

/** Graph API error codes that mean "throttled / temporarily unavailable" (sent as HTTP 400). */
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80000, 80003, 80004, 80005, 80008, 80014]);

type GraphError = { message?: string; type?: string; code?: number; error_subcode?: number; error_user_title?: string; error_user_msg?: string; is_transient?: boolean };
type Id = { id: string };
type AdRow = { id: string; name?: string; effective_status?: string; ad_review_feedback?: { global?: Record<string, string> } };
type InsightRow = { ad_id?: string; spend?: string; impressions?: string; inline_link_clicks?: string; account_currency?: string };

const usdToCents = (usd: number): number => {
  if (!Number.isFinite(usd) || usd < 1) throw new PlatformError("meta", `daily budget must be at least $1 (got ${usd})`);
  return Math.round(usd * 100);
};

function graphMessage(err: PlatformError): { text: string; transient: boolean } {
  const raw = err.message.replace(/^meta: /, "");
  const json = raw.replace(/^\d+\s+/, "");
  try {
    const e = (JSON.parse(json) as { error?: GraphError }).error;
    if (e) {
      const text = [e.error_user_title, e.error_user_msg ?? e.message].filter(Boolean).join(": ") + (e.code !== undefined ? ` (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""})` : "");
      return { text, transient: Boolean(e.is_transient) || (e.code !== undefined && TRANSIENT_CODES.has(e.code)) };
    }
  } catch {
    /* not JSON */
  }
  return { text: raw, transient: false };
}

export function create(creds: MetaCreds, deps: PlatformDeps = {}): AdPlatform {
  const base = `${GRAPH}/${creds.apiVersion}`;
  const proof = creds.appSecret ? createHmac("sha256", creds.appSecret).update(creds.accessToken).digest("hex") : undefined;
  const localeCache = new Map<string, number[]>();

  /** One Graph call. `what` names the step in errors; Graph throttling codes become retryable. */
  async function graph<T>(what: string, method: "GET" | "POST" | "DELETE", path: string, opts: { form?: Record<string, unknown>; query?: RequestInit2["query"] } = {}): Promise<T> {
    const form = opts.form ? Object.fromEntries(Object.entries(opts.form).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])) : undefined;
    try {
      return await request<T>("meta", deps, `${base}/${path}`, {
        method,
        headers: { authorization: `OAuth ${creds.accessToken}` },
        form,
        query: { ...opts.query, appsecret_proof: proof },
      });
    } catch (err) {
      if (!(err instanceof PlatformError)) throw err;
      const { text, transient } = graphMessage(err);
      throw new PlatformError("meta", `${what}: ${text}`, err.status, err.retryable || transient);
    }
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

  return {
    id: "meta",

    async launch(spec: LaunchSpec): Promise<Launched> {
      if (!spec.identity?.ref) throw new PlatformError("meta", "launch needs the app's Facebook Page (identity)");
      if (!spec.creatives.length) throw new PlatformError("meta", "launch needs at least one creative");
      if (spec.creatives.some((c) => !c.asset)) throw new PlatformError("meta", "Meta ads need an image or video for every creative");
      if (!spec.targeting.countries.length) throw new PlatformError("meta", "launch needs at least one country");
      const budgetCents = usdToCents(spec.dailyBudgetUsd);
      const [pageId, igUserId] = spec.identity.ref.split(":");

      // Budgets are in the account currency's minor unit: refuse anything but USD.
      const acct = await graph<{ currency?: string; account_status?: number }>("ad account check", "GET", creds.adAccountId, { query: { fields: "currency,account_status" } });
      if (acct.currency !== "USD") throw new PlatformError("meta", `ad account currency is ${acct.currency ?? "unknown"}, expected USD`);
      if (acct.account_status !== undefined && acct.account_status !== 1) throw new PlatformError("meta", `ad account is not active (account_status ${acct.account_status})`);

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
        const headline = fit(c.copy.headline, info.copyLimits.headline);
        const body = fit(c.copy.body, info.copyLimits.body);
        const description = c.copy.description ? fit(c.copy.description, info.copyLimits.description ?? 30) : undefined;
        const call_to_action = { type: CTA[c.copy.cta], value: { link: spec.link } };
        let story: Record<string, unknown>;
        if (a.kind === "video") {
          const v = await uploadVideo(a, images);
          story = { video_data: { video_id: v.videoId, ...v.thumb, message: body, title: headline, link_description: description, call_to_action } };
        } else {
          const hash = await uploadImage(a, images);
          story = { link_data: { image_hash: hash, link: spec.link, message: body, name: headline, description, call_to_action } };
        }
        media.push({ key: c.key, story });
      }
      for (const m of media) {
        const r = await graph<Id>(`creative ${m.key}`, "POST", `${creds.adAccountId}/adcreatives`, {
          form: { name: `${spec.campaignName} · ${m.key}`, object_story_spec: { page_id: pageId, ...(igUserId ? { instagram_user_id: igUserId } : {}), ...m.story } },
        });
        creativeIds.push({ key: m.key, creativeId: r.id });
      }

      const { id: campaignId } = await graph<Id>("campaign", "POST", `${creds.adAccountId}/campaigns`, {
        form: { name: spec.campaignName, objective: "OUTCOME_TRAFFIC", status: "PAUSED", buying_type: "AUCTION", special_ad_categories: [], is_adset_budget_sharing_enabled: "false" },
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
            daily_budget: String(budgetCents),
            billing_event: "IMPRESSIONS",
            optimization_goal: "LINK_CLICKS",
            bid_strategy: "LOWEST_COST_WITHOUT_CAP",
            destination_type: "WEBSITE",
            targeting,
            status: "ACTIVE",
            ...(eu ? { dsa_beneficiary: spec.identity.displayName || spec.appName, dsa_payor: creds.dsaPayor } : {}),
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
        return { platform: "meta", campaignId, refs: { adSetId, adAccountId: creds.adAccountId }, ads };
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
      const adsRes = await graph<{ data?: AdRow[] }>("ads status", "GET", `${c.campaignId}/ads`, { query: { fields: "id,name,effective_status,ad_review_feedback", limit: 200 } });
      const ins = await graph<{ data?: InsightRow[] }>("insights", "GET", `${c.campaignId}/insights`, {
        query: { level: "ad", date_preset: "maximum", fields: "ad_id,spend,impressions,inline_link_clicks,account_currency", limit: 500 },
      });

      const keyOf = new Map(Object.entries(c.ads).map(([k, id]) => [id, k]));
      const byCreative: NonNullable<AdStats["byCreative"]> = {};
      for (const key of Object.keys(c.ads)) byCreative[key] = { spendUsd: 0, impressions: 0, clicks: 0 };

      let spendCents = 0;
      let impressions = 0;
      let clicks = 0;
      for (const r of ins.data ?? []) {
        if (r.account_currency && r.account_currency !== "USD") throw new PlatformError("meta", `insights are in ${r.account_currency}, expected USD`);
        const s = Math.round(Number(r.spend ?? 0) * 100) || 0;
        const i = Number(r.impressions ?? 0) || 0;
        const k = Number(r.inline_link_clicks ?? 0) || 0;
        spendCents += s;
        impressions += i;
        clicks += k;
        const key = r.ad_id ? keyOf.get(r.ad_id) : undefined;
        const slot = key ? byCreative[key] : undefined;
        if (slot) {
          slot.spendUsd = Math.round(slot.spendUsd * 100 + s) / 100;
          slot.impressions += i;
          slot.clicks += k;
        }
      }

      const reasons: string[] = [];
      const adStatuses: CampaignStatus[] = [];
      for (const ad of adsRes.data ?? []) {
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

      const out: AdStats = { spendUsd: spendCents / 100, impressions, clicks, status: overallStatus(camp.effective_status, adStatuses), byCreative };
      if (reasons.length) out.rejection = reasons.join("; ");
      return out;
    },

    async pause(c) {
      await setStatus(c.campaignId, "PAUSED", "pause");
    },

    async resume(c) {
      await setStatus(c.campaignId, "ACTIVE", "resume");
    },

    async setDailyBudget(c, usd) {
      const adSetId = c.refs.adSetId;
      if (!adSetId) throw new PlatformError("meta", "no ad set id stored for this campaign");
      await graph("set daily budget", "POST", adSetId, { form: { daily_budget: String(usdToCents(usd)) } });
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
