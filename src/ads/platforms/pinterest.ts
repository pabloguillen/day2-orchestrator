import { assetBytes, fit, poll, request, tokenCache, type RequestInit2 } from "../http";
import {
  PlatformError,
  type AdCreativeInput,
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

/**
 * Pinterest API v5 (ads), written against REST API 5.28.0
 * (github.com/pinterest/api-description, v5/openapi.json).
 *
 * Flow per launch:
 *   1. GET /ad_accounts/{id}: the account must bill in USD (all money
 *      fields are micro-units of the account currency).
 *   2. One Pin per creative, created by day2's business account with
 *      ?ad_account_id=… (image Pins from image_url; video Pins after
 *      POST /media → upload to the returned URL → poll until succeeded).
 *      Without PINTEREST_BOARD_ID the Pin goes onto Pinterest's protected
 *      board for ad-only Pins (not shown on the profile, not organic).
 *   3. Campaign, objective CONSIDERATION (traffic), created PAUSED. Pinterest
 *      treats CONSIDERATION as a Campaign Budget Optimization campaign, so
 *      the daily budget lives on the campaign (daily_spend_cap, micro USD)
 *      and the ad group uses budget_type CBO_ADGROUP.
 *   4. One ad group (CLICKTHROUGH billing, automatic bid, country/language/
 *      age targeting), then one ad per Pin.
 *   5. Campaign → ACTIVE. Any failure after step 3 archives the campaign and
 *      rethrows, so nothing half-built can spend.
 */

const API = "https://api.pinterest.com/v5";
const ID = "pinterest" as const;
const MICRO = 1_000_000;
/** Sync analytics can't look further back than 90 days. */
const ANALYTICS_WINDOW_DAYS = 89;

export type PinterestCreds = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  adAccountId: string;
  /** Optional board (owned by day2's business account) to save the ad Pins on. */
  boardId?: string;
  /**
   * Pinterest's continuous refresh tokens roll: a refresh can return a new
   * one. Called with it so the operator can persist it (never log it).
   */
  onRefreshToken?: (token: string) => void | Promise<void>;
};

export const info: PlatformInfo = {
  id: ID,
  name: "Pinterest",
  formats: [
    { kind: "image", ratio: "2:3", width: 1000, height: 1500, maxBytes: 20 * 1024 * 1024, mimes: ["image/jpeg", "image/png"] },
    { kind: "image", ratio: "1:1", width: 1000, height: 1000, maxBytes: 20 * 1024 * 1024, mimes: ["image/jpeg", "image/png"] },
    { kind: "video", ratio: "9:16", width: 1080, height: 1920, minDurationSec: 4, maxDurationSec: 900, maxBytes: 2 * 1024 * 1024 * 1024, mimes: ["video/mp4", "video/quicktime", "video/x-m4v"] },
    { kind: "video", ratio: "1:1", width: 1080, height: 1080, minDurationSec: 4, maxDurationSec: 900, maxBytes: 2 * 1024 * 1024 * 1024, mimes: ["video/mp4", "video/quicktime", "video/x-m4v"] },
    { kind: "video", ratio: "2:3", width: 1000, height: 1500, minDurationSec: 4, maxDurationSec: 900, maxBytes: 2 * 1024 * 1024 * 1024, mimes: ["video/mp4", "video/quicktime", "video/x-m4v"] },
  ],
  textOnly: false,
  // Pin title (API max 100) and description (ad spec 500; API max 800).
  copyLimits: { headline: 100, body: 500 },
  minDailyUsd: 5,
  // Ads run as day2's own Pinterest business profile (the Pin owner); the app's
  // name, creative and link carry the app's brand. No per-app linking needed.
  identity: "none",
  audiences: ["consumer"],
  env: ["PINTEREST_CLIENT_ID", "PINTEREST_CLIENT_SECRET", "PINTEREST_REFRESH_TOKEN", "PINTEREST_AD_ACCOUNT_ID", "PINTEREST_BOARD_ID"],
  apiVersion: "v5 (REST API 5.28.0)",
};

export function credentialsFromEnv(env: Record<string, string | undefined>): PinterestCreds | null {
  const clientId = env.PINTEREST_CLIENT_ID?.trim();
  const clientSecret = env.PINTEREST_CLIENT_SECRET?.trim();
  const refreshToken = env.PINTEREST_REFRESH_TOKEN?.trim();
  const adAccountId = env.PINTEREST_AD_ACCOUNT_ID?.trim();
  if (!clientId || !clientSecret || !refreshToken || !adAccountId) return null;
  const boardId = env.PINTEREST_BOARD_ID?.trim();
  return { clientId, clientSecret, refreshToken, adAccountId, ...(boardId ? { boardId } : {}) };
}

/** Pinterest CTA values allowed for CONSIDERATION campaigns (DOWNLOAD isn't one). */
const CTA: Record<CallToAction, string> = {
  learn_more: "LEARN_MORE",
  sign_up: "SIGN_UP",
  download: "VISIT_SITE",
  get_started: "VISIT_SITE",
};

type BatchItem<T> = { data?: T; exceptions?: unknown };
type BatchResponse<T> = { items?: BatchItem<T>[] };
type ApiCampaign = { id: string; status?: string; summary_status?: string };
type ApiAd = {
  id: string;
  status?: string;
  summary_status?: string;
  review_status?: string;
  rejected_reasons?: string[] | null;
  rejection_labels?: string[] | null;
};
type AnalyticsRow = { AD_ID?: string; SPEND_IN_MICRO_DOLLAR?: number; IMPRESSION_1?: number; CLICKTHROUGH_1?: number };

function exceptionText(ex: unknown): string | null {
  if (!ex) return null;
  const list = Array.isArray(ex) ? ex : [ex];
  if (!list.length) return null;
  return list
    .map((e) => {
      const o = e as { code?: unknown; message?: unknown };
      return [o.code, o.message].filter((x) => x !== undefined && x !== null).join(" ");
    })
    .join("; ");
}

/** Unwraps a batch write response, throwing if any item failed. */
function batchData<T>(what: string, res: BatchResponse<T> | undefined, expected: number): T[] {
  const items = res?.items ?? [];
  const errors = items.map((it, i) => [i, exceptionText(it.exceptions)] as const).filter(([, e]) => e);
  if (errors.length) throw new PlatformError(ID, `${what} failed: ${errors.map(([i, e]) => `#${i} ${e}`).join(" | ").slice(0, 500)}`, 400);
  const data = items.map((it) => it.data);
  if (data.length !== expected || data.some((d) => !d)) throw new PlatformError(ID, `${what}: unexpected response (${data.length}/${expected} items)`);
  return data as T[];
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function micro(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) throw new PlatformError(ID, `invalid daily budget ${usd}`);
  return Math.round(usd * MICRO);
}

function adStatus(ad: ApiAd): CampaignStatus {
  if (ad.review_status === "REJECTED" || ad.summary_status === "REJECTED") return "rejected";
  if (ad.status === "ARCHIVED" || ad.summary_status === "ARCHIVED") return "ended";
  if (ad.status === "PAUSED" || ad.summary_status === "PAUSED" || ad.summary_status === "ADVERTISER_DISABLED") return "paused";
  if (ad.review_status === "PENDING" || ad.summary_status === "PENDING") return "in_review";
  if (ad.status === "ACTIVE") return "active";
  return "unknown";
}

function rejectionOf(ad: ApiAd): string | undefined {
  const labels = (ad.rejection_labels ?? []).filter(Boolean);
  const reasons = (ad.rejected_reasons ?? []).filter(Boolean);
  const text = [...new Set([...labels, ...(labels.length ? [] : reasons)])].join("; ");
  return text || undefined;
}

export function create(creds: PinterestCreds, deps: PlatformDeps = {}): AdPlatform {
  const now = () => (deps.now ? deps.now() : new Date());
  let refreshToken = creds.refreshToken;
  const basic = `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}`;
  const acct = `${API}/ad_accounts/${encodeURIComponent(creds.adAccountId)}`;

  const token = tokenCache(
    async () => {
      const res = await request<{ access_token?: string; expires_in?: number; refresh_token?: string }>(ID, deps, `${API}/oauth/token`, {
        method: "POST",
        headers: { authorization: basic },
        form: { grant_type: "refresh_token", refresh_token: refreshToken },
      });
      if (!res?.access_token) throw new PlatformError(ID, "token refresh returned no access token", 401);
      if (res.refresh_token && res.refresh_token !== refreshToken) {
        refreshToken = res.refresh_token;
        await Promise.resolve(creds.onRefreshToken?.(res.refresh_token)).catch(() => {});
      }
      return { accessToken: res.access_token, expiresInSec: res.expires_in ?? 3600 };
    },
    () => now().getTime(),
  );

  async function api<T>(url: string, init: RequestInit2 = {}): Promise<T> {
    const t = await token();
    return request<T>(ID, deps, url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${t}` } });
  }

  let usdCheck: Promise<void> | null = null;
  function ensureUsd(): Promise<void> {
    usdCheck ??= api<{ currency?: string }>(acct)
      .then((a) => {
        if (a?.currency !== "USD") throw new PlatformError(ID, `ad account ${creds.adAccountId} bills in ${a?.currency ?? "unknown currency"}, expected USD`);
      })
      .catch((err) => {
        usdCheck = null;
        throw err;
      });
    return usdCheck;
  }

  function checkAsset(c: AdCreativeInput): Asset {
    const a = c.asset;
    if (!a) throw new PlatformError(ID, `creative ${c.key}: Pinterest ads need an image or video`);
    const spec = info.formats.find((f) => f.kind === a.kind && f.ratio === a.ratio);
    if (!spec) throw new PlatformError(ID, `creative ${c.key}: ${a.kind} ${a.ratio} is not a supported Pinterest format`);
    if (!spec.mimes.includes(a.mime)) throw new PlatformError(ID, `creative ${c.key}: ${a.mime} not accepted for ${a.kind}`);
    if (a.bytes > spec.maxBytes) throw new PlatformError(ID, `creative ${c.key}: file too large (${a.bytes} bytes)`);
    if (a.kind === "video" && a.durationSec !== undefined && (a.durationSec < (spec.minDurationSec ?? 0) || a.durationSec > (spec.maxDurationSec ?? Infinity)))
      throw new PlatformError(ID, `creative ${c.key}: video must be ${spec.minDurationSec}-${spec.maxDurationSec}s`);
    return a;
  }

  async function uploadVideo(asset: Asset): Promise<string> {
    const reg = await api<{ media_id?: string; upload_url?: string; upload_parameters?: Record<string, string> }>(`${API}/media`, {
      method: "POST",
      json: { media_type: "video" },
    });
    if (!reg?.media_id || !reg.upload_url) throw new PlatformError(ID, "media register returned no upload URL");
    const bytes = await assetBytes(deps, asset);
    const form = new FormData();
    for (const [k, v] of Object.entries(reg.upload_parameters ?? {})) form.append(k, v);
    form.append("file", new Blob([bytes as BlobPart], { type: asset.mime }), `${asset.id}.${asset.mime === "video/quicktime" ? "mov" : "mp4"}`);
    // Pre-signed upload URL: no Pinterest bearer token goes there.
    await request(ID, deps, reg.upload_url, { method: "POST", multipart: form });
    const mediaId = reg.media_id;
    await poll(
      deps,
      async () => {
        const m = await api<{ status?: string }>(`${API}/media/${encodeURIComponent(mediaId)}`);
        if (m?.status === "failed") throw new PlatformError(ID, `video processing failed for media ${mediaId}`);
        return m?.status === "succeeded" ? true : undefined;
      },
      { what: `video ${mediaId} processing`, platform: ID, everyMs: 5000, timeoutMs: 20 * 60_000 },
    );
    return mediaId;
  }

  async function createPin(spec: LaunchSpec, c: AdCreativeInput, asset: Asset, boardId: string | undefined): Promise<string> {
    let media_source: Record<string, unknown>;
    if (asset.kind === "image") media_source = { source_type: "image_url", url: asset.url };
    else {
      const mediaId = await uploadVideo(asset);
      media_source = asset.thumbnail?.url
        ? { source_type: "video_id", media_id: mediaId, cover_image_url: asset.thumbnail.url }
        : { source_type: "video_id", media_id: mediaId, cover_image_key_frame_time: 1 };
    }
    const disclosures: string[] = [];
    const anyFlagged = spec.creatives.some((x) => x.asset?.aiGenerated || x.asset?.aiPerson);
    if (asset.aiGenerated || (spec.aiContent && !anyFlagged)) disclosures.push("AI_MODIFIED");
    if (asset.aiPerson) disclosures.push("SYNTHETIC_PERFORMER");
    const body: Record<string, unknown> = {
      title: fit(c.copy.headline, info.copyLimits.headline),
      description: fit(c.copy.body, info.copyLimits.body),
      link: spec.link,
      alt_text: fit(c.copy.headline, 500),
      media_source,
      ...(boardId ? { board_id: boardId } : {}),
      ...(disclosures.length ? { ai_disclosures: { values: disclosures } } : {}),
    };
    const pin = await api<{ id?: string }>(`${API}/pins`, { method: "POST", json: body, query: { ad_account_id: creds.adAccountId } });
    if (!pin?.id) throw new PlatformError(ID, `pin for ${c.key}: no id returned`);
    return pin.id;
  }

  async function setCampaign(campaignId: string, fields: Record<string, unknown>, what: string): Promise<void> {
    const res = await api<BatchResponse<ApiCampaign>>(`${acct}/campaigns`, {
      method: "PATCH",
      json: [{ id: campaignId, ad_account_id: creds.adAccountId, ...fields }],
    });
    batchData(what, res, 1);
  }

  async function archive(campaignId: string): Promise<void> {
    try {
      await setCampaign(campaignId, { status: "ARCHIVED" }, "archive campaign");
    } catch {
      // Best effort: the campaign was created PAUSED, so it isn't spending either way.
    }
  }

  return {
    id: ID,

    async launch(spec: LaunchSpec): Promise<Launched> {
      if (!spec.creatives.length) throw new PlatformError(ID, "no creatives");
      if (spec.creatives.length > 30) throw new PlatformError(ID, "at most 30 creatives per launch");
      if (!spec.targeting.countries.length) throw new PlatformError(ID, "targeting needs at least one country");
      const budget = micro(spec.dailyBudgetUsd);
      const assets = spec.creatives.map(checkAsset);
      await ensureUsd();

      // Pins first: they cost nothing, so a failure here leaves nothing to clean up.
      const boardId = spec.identity?.ref || creds.boardId;
      const pins: string[] = [];
      for (const [i, c] of spec.creatives.entries()) pins.push(await createPin(spec, c, assets[i]!, boardId));

      const campaign = batchData(
        "create campaign",
        await api<BatchResponse<ApiCampaign>>(`${acct}/campaigns`, {
          method: "POST",
          json: [
            {
              ad_account_id: creds.adAccountId,
              name: spec.campaignName,
              objective_type: "CONSIDERATION",
              status: "PAUSED",
              is_campaign_budget_optimization: true,
              is_flexible_daily_budgets: false,
              daily_spend_cap: budget,
            },
          ],
        }),
        1,
      )[0]!;
      const campaignId = campaign.id;

      try {
        const t = spec.targeting;
        const minAge = Math.min(64, Math.max(18, Math.round(t.ageMin || 18)));
        const maxAge = t.ageMax !== undefined && t.ageMax < 65 ? Math.max(Math.round(t.ageMax), minAge + 1) : undefined;
        const targeting_spec: Record<string, unknown> = {
          LOCATION: t.countries.map((c) => c.toUpperCase()),
          MINIMUM_AGE: String(minAge),
          MAXIMUM_AGE: maxAge === undefined || maxAge >= 65 ? "65+" : String(maxAge),
        };
        if (t.languages.length) targeting_spec.LOCALE = t.languages.map((l) => l.toLowerCase().slice(0, 2));

        const adGroup = batchData(
          "create ad group",
          await api<BatchResponse<{ id: string }>>(`${acct}/ad_groups`, {
            method: "POST",
            json: [
              {
                campaign_id: campaignId,
                name: `${spec.campaignName} · ad group`,
                status: "ACTIVE",
                budget_type: "CBO_ADGROUP",
                billable_event: "CLICKTHROUGH",
                bid_strategy_type: "AUTOMATIC_BID",
                auto_targeting_enabled: false,
                placement_group: "ALL",
                targeting_spec,
              },
            ],
          }),
          1,
        )[0]!;

        const ads = batchData(
          "create ads",
          await api<BatchResponse<{ id: string }>>(`${acct}/ads`, {
            method: "POST",
            json: spec.creatives.map((c, i) => ({
              ad_group_id: adGroup.id,
              pin_id: pins[i],
              creative_type: assets[i]!.kind === "video" ? "VIDEO" : "REGULAR",
              name: `${spec.campaignName} ${c.key}`.slice(0, 255),
              status: "ACTIVE",
              destination_url: spec.link,
              customizable_cta_type: CTA[c.copy.cta],
            })),
          }),
          spec.creatives.length,
        );

        await setCampaign(campaignId, { status: "ACTIVE" }, "activate campaign");

        return {
          platform: ID,
          campaignId,
          refs: { adGroupId: adGroup.id, startDate: ymd(now()), ...Object.fromEntries(spec.creatives.map((c, i) => [`pin:${c.key}`, pins[i]!])) },
          ads: Object.fromEntries(spec.creatives.map((c, i) => [c.key, ads[i]!.id])),
        };
      } catch (err) {
        await archive(campaignId);
        if (err instanceof PlatformError) throw err;
        throw new PlatformError(ID, `launch failed: ${(err as Error).message}`);
      }
    },

    async stats(c: Launched): Promise<AdStats> {
      await ensureUsd();
      const campaign = await api<ApiCampaign>(`${acct}/campaigns/${encodeURIComponent(c.campaignId)}`);

      const ads: ApiAd[] = [];
      let bookmark: string | undefined;
      do {
        const page = await api<{ items?: ApiAd[]; bookmark?: string | null }>(`${acct}/ads`, {
          query: { campaign_ids: c.campaignId, page_size: 100, bookmark },
        });
        ads.push(...(page?.items ?? []));
        bookmark = page?.bookmark ?? undefined;
      } while (bookmark);

      const today = now();
      const earliest = new Date(today.getTime() - ANALYTICS_WINDOW_DAYS * 86_400_000);
      const launched = c.refs.startDate ? new Date(`${c.refs.startDate}T00:00:00Z`) : earliest;
      const start = launched > earliest ? launched : earliest;
      const adIds = Object.values(c.ads);
      const rows: AnalyticsRow[] = [];
      for (let i = 0; i < adIds.length; i += 250) {
        const res = await api<AnalyticsRow[]>(`${acct}/ads/analytics`, {
          query: {
            ad_ids: adIds.slice(i, i + 250).join(","),
            start_date: ymd(start),
            end_date: ymd(today),
            columns: "AD_ID,SPEND_IN_MICRO_DOLLAR,IMPRESSION_1,CLICKTHROUGH_1",
            granularity: "TOTAL",
          },
        });
        if (Array.isArray(res)) rows.push(...res);
      }

      const keyOf = new Map(Object.entries(c.ads).map(([k, id]) => [id, k]));
      const adById = new Map(ads.map((a) => [a.id, a]));
      const byCreative: NonNullable<AdStats["byCreative"]> = {};
      for (const [key, id] of Object.entries(c.ads)) {
        const ad = adById.get(id);
        byCreative[key] = { spendUsd: 0, impressions: 0, clicks: 0, ...(ad ? { status: adStatus(ad) } : {}) };
      }
      let spendMicro = 0;
      let impressions = 0;
      let clicks = 0;
      for (const r of rows) {
        const s = Number(r.SPEND_IN_MICRO_DOLLAR ?? 0) || 0;
        const imp = Number(r.IMPRESSION_1 ?? 0) || 0;
        const clk = Number(r.CLICKTHROUGH_1 ?? 0) || 0;
        spendMicro += s;
        impressions += imp;
        clicks += clk;
        const key = r.AD_ID ? keyOf.get(String(r.AD_ID)) : undefined;
        if (key && byCreative[key]) {
          byCreative[key].spendUsd += s / MICRO;
          byCreative[key].impressions += imp;
          byCreative[key].clicks += clk;
        }
      }

      const mine = ads.filter((a) => keyOf.has(a.id));
      const statuses = mine.map(adStatus);
      const rejected = mine.filter((a) => adStatus(a) === "rejected");
      let status: CampaignStatus;
      if (campaign?.status === "ARCHIVED" || campaign?.summary_status === "COMPLETED" || campaign?.summary_status === "ARCHIVED") status = "ended";
      else if (campaign?.status === "PAUSED" || campaign?.summary_status === "PAUSED" || campaign?.summary_status === "ADVERTISER_DISABLED") status = "paused";
      else if (mine.length && rejected.length === mine.length) status = "rejected";
      else if (statuses.includes("active")) status = "active";
      else if (statuses.includes("in_review")) status = "in_review";
      else if (campaign?.status === "ACTIVE") status = "active";
      else status = "unknown";

      const rejection = [...new Set(rejected.map(rejectionOf).filter((x): x is string => !!x))].join(" | ") || undefined;
      return {
        spendUsd: spendMicro / MICRO,
        impressions,
        clicks,
        status,
        ...(rejection ? { rejection } : {}),
        byCreative,
      };
    },

    async pause(c: Launched): Promise<void> {
      await setCampaign(c.campaignId, { status: "PAUSED" }, "pause campaign");
    },

    async resume(c: Launched): Promise<void> {
      await setCampaign(c.campaignId, { status: "ACTIVE" }, "resume campaign");
    },

    async setDailyBudget(c: Launched, usd: number): Promise<void> {
      const budget = micro(usd);
      await ensureUsd();
      await setCampaign(c.campaignId, { daily_spend_cap: budget }, "set daily budget");
    },
  };
}
