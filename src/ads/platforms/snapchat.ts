/**
 * Snapchat — Snap Marketing API (Ads API v1), https://adsapi.snapchat.com/v1
 *
 * Launch flow (all from day2's own ad account):
 *   per creative: media (create → upload, chunked above ~31 MB → poll until READY)
 *                 → WEB_VIEW creative (top snap = media, attachment = spec.link)
 *   campaign (PAUSED, objective TRAFFIC) → ad squad (SNAP_ADS, SWIPES, AUTO_BID, daily budget)
 *   → ads (REMOTE_WEBPAGE, bulk) → campaign PATCH status ACTIVE.
 *
 * The campaign is the single on/off switch: it stays PAUSED until every
 * child exists, and anything created is deleted again if a step fails.
 *
 * Snap requires every advertiser to run ads under a Snapchat Public Profile
 * (creative.profile_properties.profile_id), so identity is "app_account".
 */
import { assetBytes, fit, poll, request, tokenCache, type RequestInit2 } from "../http";
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

export const API = "https://adsapi.snapchat.com";
export const BASE = `${API}/v1`;
export const TOKEN_URL = "https://accounts.snapchat.com/login/oauth2/access_token";

/** Single upload limit is 32 MB; stay under it and chunk above. Max 32 chunks, 1 GB total. */
const CHUNK_BYTES = 31_000_000;
const MAX_CHUNKS = 32;
const MIN_DAILY_MICRO = 5_000_000;

export type SnapchatCreds = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  adAccountId: string;
};

export const info: PlatformInfo = {
  id: "snapchat",
  name: "Snapchat",
  formats: [
    { kind: "video", ratio: "9:16", width: 1080, height: 1920, minDurationSec: 3, maxDurationSec: 180, maxBytes: CHUNK_BYTES * MAX_CHUNKS, mimes: ["video/mp4", "video/quicktime"] },
    { kind: "image", ratio: "9:16", width: 1080, height: 1920, maxBytes: 5_000_000, mimes: ["image/jpeg", "image/png"] },
  ],
  textOnly: false,
  // Snap Ads show the brand name and a 34-char headline over the Top Snap; there is no caption,
  // so `body` is not shown (kept equal to the headline limit for callers that write one).
  copyLimits: { headline: 34, body: 34 },
  minDailyUsd: 5,
  identity: "app_account",
  identityHelp:
    "The app's Snapchat Public Profile must be shared with day2's Snap Business organization (Business Manager → Public Profiles) and its profile id stored as the identity ref.",
  audiences: ["consumer"],
  env: ["SNAP_CLIENT_ID", "SNAP_CLIENT_SECRET", "SNAP_REFRESH_TOKEN", "SNAP_AD_ACCOUNT_ID"],
  apiVersion: "v1",
};

export function credentialsFromEnv(env: Record<string, string | undefined>): SnapchatCreds | null {
  const clientId = env.SNAP_CLIENT_ID?.trim();
  const clientSecret = env.SNAP_CLIENT_SECRET?.trim();
  const refreshToken = env.SNAP_REFRESH_TOKEN?.trim();
  const adAccountId = env.SNAP_AD_ACCOUNT_ID?.trim();
  if (!clientId || !clientSecret || !refreshToken || !adAccountId) return null;
  return { clientId, clientSecret, refreshToken, adAccountId };
}

/** Snap's WEB_VIEW call_to_action enum has no LEARN_MORE/GET_STARTED; MORE and TRY are the closest. */
export const CTA: Record<CallToAction, string> = {
  learn_more: "MORE",
  sign_up: "SIGN_UP",
  download: "DOWNLOAD",
  get_started: "TRY",
};

type SubItem = { sub_request_status?: string; sub_request_error_reason?: string } & Record<string, unknown>;
type Envelope = { request_status?: string; request_id?: string; debug_message?: string; display_message?: string } & Record<string, unknown>;

type SnapAd = { id: string; status?: string; review_status?: string; review_status_reasons?: string[] };
type StatBlock = { impressions?: number; swipes?: number; spend?: number };
type TotalStat = { id?: string; type?: string; stats?: StatBlock; breakdown_stats?: { ad?: Array<{ id: string; stats?: StatBlock }> } };

const err = (message: string, status?: number, retryable = false) => new PlatformError("snapchat", message, status, retryable);

export function create(creds: SnapchatCreds, deps: PlatformDeps = {}): AdPlatform {
  const now = () => (deps.now ? deps.now() : new Date());

  const token = tokenCache(async () => {
    const r = await request<{ access_token?: string; expires_in?: number }>("snapchat", deps, TOKEN_URL, {
      method: "POST",
      form: { grant_type: "refresh_token", client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: creds.refreshToken },
    });
    if (!r?.access_token) throw err("OAuth refresh returned no access_token");
    return { accessToken: r.access_token, expiresInSec: r.expires_in ?? 1800 };
  }, () => now().getTime());

  async function api<T = Envelope>(path: string, init: RequestInit2 = {}): Promise<T> {
    const url = path.startsWith("http") ? path : `${path.startsWith("/v1/") ? API : BASE}${path}`;
    const res = await request<T>("snapchat", deps, url, {
      ...init,
      headers: { authorization: `Bearer ${await token()}`, ...(init.headers ?? {}) },
    });
    const env = res as unknown as Envelope | undefined;
    if (env && typeof env === "object" && env.request_status && String(env.request_status).toUpperCase() !== "SUCCESS") {
      throw err(`${path}: ${env.request_status} ${env.display_message ?? env.debug_message ?? ""}`.trim());
    }
    return res;
  }

  /** Unwraps `{ <plural>: [{ sub_request_status, <singular>: {...} }] }`, failing on any sub-request error. */
  function items<T>(res: Envelope, plural: string, singular: string): T[] {
    const list = (res[plural] as SubItem[] | undefined) ?? [];
    return list.map((it) => {
      if (it.sub_request_status && it.sub_request_status.toUpperCase() !== "SUCCESS") {
        throw err(`${singular} rejected: ${it.sub_request_error_reason ?? it.sub_request_status}`);
      }
      const obj = it[singular] as T | undefined;
      if (!obj) throw err(`response had no ${singular}`);
      return obj;
    });
  }

  function one<T>(res: Envelope, plural: string, singular: string): T {
    const [x] = items<T>(res, plural, singular);
    if (!x) throw err(`response had no ${singular}`);
    return x;
  }

  let currencyChecked = false;
  async function checkCurrency() {
    if (currencyChecked) return;
    const acct = one<{ currency?: string }>(await api(`/adaccounts/${creds.adAccountId}`), "adaccounts", "adaccount");
    if (acct.currency && acct.currency !== "USD") throw err(`ad account currency is ${acct.currency}; this adapter reports and budgets in USD`);
    currencyChecked = true;
  }

  async function uploadMedia(asset: Asset, name: string, aiGenerated: boolean): Promise<string> {
    const media = one<{ id: string }>(
      await api(`/adaccounts/${creds.adAccountId}/media`, {
        method: "POST",
        json: {
          media: [
            {
              name: fit(name, 375),
              type: asset.kind === "video" ? "VIDEO" : "IMAGE",
              ad_account_id: creds.adAccountId,
              ...(aiGenerated ? { ai_content_source: "USER_AI_GEN" } : {}),
            },
          ],
        },
      }),
      "media",
      "media",
    );
    const bytes = await assetBytes(deps, asset);
    const fileName = `${asset.id}.${extFor(asset.mime)}`;
    const blob = (part: Uint8Array) => new Blob([part as BlobPart], { type: asset.mime });

    if (bytes.byteLength <= CHUNK_BYTES) {
      const fd = new FormData();
      fd.append("file", blob(bytes), fileName);
      await api(`/media/${media.id}/upload`, { method: "POST", multipart: fd });
    } else {
      const parts = Math.ceil(bytes.byteLength / CHUNK_BYTES);
      if (parts > MAX_CHUNKS) throw err(`asset ${asset.id} is too large for Snap (${bytes.byteLength} bytes)`);
      const init = new FormData();
      init.append("file_name", fileName);
      init.append("file_size", String(bytes.byteLength));
      init.append("number_of_parts", String(parts));
      const started = await api<{ upload_id?: string; add_path?: string; finalize_path?: string }>(`/media/${media.id}/multipart-upload-v2`, {
        method: "POST",
        query: { action: "INIT" },
        multipart: init,
      });
      if (!started.upload_id || !started.add_path || !started.finalize_path) throw err("chunked upload INIT returned no upload_id/paths");
      for (let p = 0; p < parts; p++) {
        const fd = new FormData();
        fd.append("file", blob(bytes.subarray(p * CHUNK_BYTES, (p + 1) * CHUNK_BYTES)), fileName);
        fd.append("part_number", String(p + 1));
        fd.append("upload_id", started.upload_id);
        await api(`${API}${started.add_path}`, { method: "POST", multipart: fd });
      }
      const fin = new FormData();
      fin.append("upload_id", started.upload_id);
      await api(`${API}${started.finalize_path}`, { method: "POST", multipart: fin });
    }

    await poll(
      deps,
      async () => {
        const m = one<{ media_status?: string }>(await api(`/media/${media.id}`), "media", "media");
        return m.media_status === "READY" ? true : undefined;
      },
      { what: `media ${media.id} to be READY`, platform: "snapchat", everyMs: 3000, timeoutMs: 15 * 60_000 },
    );
    return media.id;
  }

  async function getAdSquad(id: string): Promise<Record<string, unknown>> {
    return one<Record<string, unknown>>(await api(`/adsquads/${id}`), "adsquads", "adsquad");
  }

  async function setCampaignStatus(campaignId: string, status: "ACTIVE" | "PAUSED") {
    await api(`/adaccounts/${creds.adAccountId}/campaigns/${campaignId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json-patch+json" },
      json: [{ op: "replace", path: "/status", value: status }],
    });
  }

  function targeting(spec: LaunchSpec) {
    const t = spec.targeting;
    if (!t.countries.length) throw err("targeting needs at least one country");
    const demo: Record<string, unknown> = { min_age: String(Math.min(35, Math.max(13, Math.round(t.ageMin)))) };
    if (t.ageMax !== undefined && t.ageMax < 55) demo.max_age = String(Math.max(Number(demo.min_age), Math.round(t.ageMax)));
    // Multi-country specs must carry exactly one language.
    const langs = t.languages.map((l) => l.toLowerCase());
    if (langs.length) demo.languages = t.countries.length > 1 ? [langs[0]] : langs;
    return {
      regulated_content: false,
      geos: t.countries.map((c) => ({ country_code: c.toLowerCase() })),
      demographics: [demo],
    };
  }

  return {
    id: "snapchat",

    async launch(spec: LaunchSpec): Promise<Launched> {
      if (!spec.identity?.ref) throw err("a Snapchat Public Profile (identity) is required to run Snap ads");
      if (!spec.creatives.length) throw err("no creatives");
      for (const c of spec.creatives) {
        if (!c.asset) throw err(`creative ${c.key}: Snap needs an image or video`);
        if (c.asset.ratio !== "9:16") throw err(`creative ${c.key}: Snap Ads need 9:16, got ${c.asset.ratio}`);
        const fmt = info.formats.find((f) => f.kind === c.asset!.kind);
        if (fmt && c.asset.bytes > fmt.maxBytes) throw err(`creative ${c.key}: ${c.asset.bytes} bytes exceeds ${fmt.maxBytes}`);
      }
      const dailyMicro = Math.round(spec.dailyBudgetUsd * 1_000_000);
      if (dailyMicro < MIN_DAILY_MICRO) throw err(`daily budget must be at least $${info.minDailyUsd}`);

      await checkCurrency();

      const flagged = spec.creatives.some((c) => c.asset?.aiGenerated || c.asset?.aiPerson);
      const brandName = fit(spec.identity.displayName || spec.appName, 32);
      const created: { campaignId?: string; adSquadId?: string; adIds: string[] } = { adIds: [] };

      try {
        // 1. Media + creatives (no spend possible yet).
        const creativeIds: Record<string, string> = {};
        for (const c of spec.creatives) {
          const asset = c.asset!;
          const ai = asset.aiGenerated || asset.aiPerson || (spec.aiContent && !flagged);
          const mediaId = await uploadMedia(asset, `${spec.campaignName} ${c.key}`, ai);
          const creative = one<{ id: string }>(
            await api(`/adaccounts/${creds.adAccountId}/creatives`, {
              method: "POST",
              json: {
                creatives: [
                  {
                    ad_account_id: creds.adAccountId,
                    name: fit(`${spec.campaignName} ${c.key}`, 375),
                    type: "WEB_VIEW",
                    top_snap_media_id: mediaId,
                    headline: fit(c.copy.headline, 34),
                    brand_name: brandName,
                    shareable: true,
                    call_to_action: CTA[c.copy.cta] ?? "MORE",
                    profile_properties: { profile_id: spec.identity.ref },
                    // block_preload: don't hit day2's tracked link unless someone actually swipes.
                    web_view_properties: { url: spec.link, block_preload: true },
                  },
                ],
              },
            }),
            "creatives",
            "creative",
          );
          creativeIds[c.key] = creative.id;
        }

        // 2. Campaign, PAUSED until everything below exists.
        const campaign = one<{ id: string }>(
          await api(`/adaccounts/${creds.adAccountId}/campaigns`, {
            method: "POST",
            json: {
              campaigns: [
                {
                  name: fit(spec.campaignName, 375),
                  ad_account_id: creds.adAccountId,
                  status: "PAUSED",
                  start_time: now().toISOString(),
                  buy_model: "AUCTION",
                  objective_v2_properties: { objective_v2_type: "TRAFFIC" },
                },
              ],
            },
          }),
          "campaigns",
          "campaign",
        );
        created.campaignId = campaign.id;

        // 3. Ad squad: swipes to the web view, auto bid, daily budget.
        const squad = one<{ id: string }>(
          await api(`/campaigns/${campaign.id}/adsquads`, {
            method: "POST",
            json: {
              adsquads: [
                {
                  name: fit(spec.campaignName, 375),
                  campaign_id: campaign.id,
                  type: "SNAP_ADS",
                  status: "ACTIVE",
                  targeting: targeting(spec),
                  placement_v2: { config: "AUTOMATIC" },
                  billing_event: "IMPRESSION",
                  optimization_goal: "SWIPES",
                  bid_strategy: "AUTO_BID",
                  delivery_constraint: "DAILY_BUDGET",
                  daily_budget_micro: dailyMicro,
                },
              ],
            },
          }),
          "adsquads",
          "adsquad",
        );
        created.adSquadId = squad.id;

        // 4. Ads, in one bulk request (Snap 429s on rapid single creates).
        const keys = spec.creatives.map((c) => c.key);
        const ads = items<{ id: string }>(
          await api(`/adsquads/${squad.id}/ads`, {
            method: "POST",
            json: {
              ads: keys.map((k) => ({
                ad_squad_id: squad.id,
                creative_id: creativeIds[k],
                name: fit(`${spec.campaignName} ${k}`, 375),
                type: "REMOTE_WEBPAGE",
                status: "ACTIVE",
              })),
            },
          }),
          "ads",
          "ad",
        );
        if (ads.length !== keys.length) throw err(`expected ${keys.length} ads, got ${ads.length}`);
        created.adIds = ads.map((a) => a.id);

        // 5. Switch on.
        await setCampaignStatus(campaign.id, "ACTIVE");

        return {
          platform: "snapchat",
          campaignId: campaign.id,
          refs: { adAccountId: creds.adAccountId, adSquadId: squad.id },
          ads: Object.fromEntries(keys.map((k, i) => [k, ads[i]!.id])),
        };
      } catch (e) {
        // Best effort: remove whatever exists. The campaign was PAUSED throughout, so nothing spends either way.
        for (const id of created.adIds) await api(`/ads/${id}`, { method: "DELETE", retries: 2 }).catch(() => {});
        if (created.adSquadId) await api(`/adsquads/${created.adSquadId}`, { method: "DELETE", retries: 2 }).catch(() => {});
        if (created.campaignId) await api(`/campaigns/${created.campaignId}`, { method: "DELETE", retries: 2 }).catch(() => {});
        if (e instanceof PlatformError) throw e;
        throw err(`launch failed: ${(e as Error).message}`);
      }
    },

    async stats(c: Launched): Promise<AdStats> {
      const statsRes = await api<{ total_stats?: Array<{ total_stat?: TotalStat }> }>(`/campaigns/${c.campaignId}/stats`, {
        query: { granularity: "TOTAL", fields: "impressions,swipes,spend", breakdown: "ad" },
      });
      const total = statsRes.total_stats?.[0]?.total_stat;
      const camp = one<{ status?: string; deleted?: boolean; end_time?: string }>(await api(`/campaigns/${c.campaignId}`), "campaigns", "campaign");
      const adList: SnapAd[] = c.refs.adSquadId ? items<SnapAd>(await api(`/adsquads/${c.refs.adSquadId}/ads`), "ads", "ad") : [];

      const usd = (micro?: number) => Math.round((micro ?? 0) / 10_000) / 100;
      const byId = new Map(adList.map((a) => [a.id, a]));
      const statById = new Map((total?.breakdown_stats?.ad ?? []).map((s) => [s.id, s.stats ?? {}]));

      const adStatus = (a: SnapAd | undefined): CampaignStatus | undefined => {
        if (!a) return undefined;
        if (a.review_status === "REJECTED") return "rejected";
        if (a.status === "PAUSED") return "paused";
        if (a.review_status === "PENDING") return "in_review";
        if (a.review_status === "APPROVED") return "active";
        return "unknown";
      };

      const byCreative: NonNullable<AdStats["byCreative"]> = {};
      for (const [key, adId] of Object.entries(c.ads)) {
        const s = statById.get(adId) ?? {};
        byCreative[key] = { spendUsd: usd(s.spend), impressions: s.impressions ?? 0, clicks: s.swipes ?? 0, status: adStatus(byId.get(adId)) };
      }

      const ours = Object.values(c.ads).map((id) => byId.get(id)).filter((a): a is SnapAd => !!a);
      const rejected = ours.filter((a) => a.review_status === "REJECTED");
      const rejection = [...new Set(rejected.flatMap((a) => a.review_status_reasons ?? []))].join("; ") || undefined;

      let status: CampaignStatus;
      const ended = camp.deleted || (camp.end_time && new Date(camp.end_time).getTime() < now().getTime());
      if (ended) status = "ended";
      else if (ours.length && rejected.length === ours.length) status = "rejected";
      else if (camp.status === "PAUSED") status = "paused";
      else if (ours.length && !ours.some((a) => a.review_status === "APPROVED") && ours.some((a) => a.review_status === "PENDING")) status = "in_review";
      else if (camp.status === "ACTIVE") status = "active";
      else status = "unknown";

      const s = total?.stats ?? {};
      return {
        spendUsd: usd(s.spend),
        impressions: s.impressions ?? 0,
        clicks: s.swipes ?? 0,
        status,
        ...(rejection ? { rejection } : {}),
        byCreative,
      };
    },

    async pause(c: Launched) {
      await setCampaignStatus(c.campaignId, "PAUSED");
    },

    async resume(c: Launched) {
      await setCampaignStatus(c.campaignId, "ACTIVE");
    },

    async setDailyBudget(c: Launched, usd: number) {
      const micro = Math.round(usd * 1_000_000);
      if (!Number.isFinite(micro) || micro < MIN_DAILY_MICRO) throw err(`daily budget must be at least $${info.minDailyUsd}`);
      const squadId = c.refs.adSquadId;
      if (!squadId) throw err("launched campaign has no adSquadId ref");
      // Ad squad updates are a full-object PUT: read, change the budget, write back.
      const squad = await getAdSquad(squadId);
      const { auto_bid: _a, target_bid: _t, created_at: _c, updated_at: _u, delivery_status: _d, ...rest } = squad;
      await api(`/campaigns/${c.campaignId}/adsquads`, {
        method: "PUT",
        json: { adsquads: [{ ...rest, id: squadId, campaign_id: c.campaignId, delivery_constraint: "DAILY_BUDGET", daily_budget_micro: micro }] },
      });
    },
  };
}

function extFor(mime: string): string {
  if (mime === "video/quicktime") return "mov";
  if (mime === "video/mp4") return "mp4";
  if (mime === "image/png") return "png";
  return "jpg";
}
