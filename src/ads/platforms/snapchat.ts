/**
 * Snapchat — Snap Marketing API (Ads API v1, https://adsapi.snapchat.com/v1)
 * plus the Conversions API v3 (https://tr.snapchat.com/v3).
 *
 * Launch flow:
 *   per creative: media (create → upload, chunked above ~31 MB → poll until READY)
 *                 → WEB_VIEW creative (top snap = media, attachment = the creative's link)
 *   campaign (PAUSED) → ad squad (SNAP_ADS, AUTO_BID, daily budget; SWIPES or PIXEL_SIGNUP)
 *   → ads (REMOTE_WEBPAGE, bulk) → campaign PATCH status ACTIVE.
 *
 * The campaign is the single on/off switch: it stays PAUSED until every
 * child exists, and anything created is deleted again if a step fails.
 * Budgets and spend are micro-units of the ad account's own currency.
 *
 * Snap requires every advertiser to run ads under a Snapchat Public Profile
 * (creative.profile_properties.profile_id), so identity is "app_account".
 */
import { createHash } from "node:crypto";
import { assetBytes, fit, poll, request, tokenCache, type RequestInit2 } from "../http";
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

export const API = "https://adsapi.snapchat.com";
export const BASE = `${API}/v1`;
export const BUSINESS_API = "https://businessapi.snapchat.com/v1";
export const CAPI = "https://tr.snapchat.com/v3";
export const TOKEN_URL = "https://accounts.snapchat.com/login/oauth2/access_token";

/** Single upload limit is 32 MB; stay under it and chunk above. Max 32 chunks, 1 GB total. */
const CHUNK_BYTES = 31_000_000;
const MAX_CHUNKS = 32;
/** Snap: daily_budget_micro ≥ 5,000,000 "across all supported currencies". */
const MIN_DAILY_MICRO = 5_000_000;
/** CAPI: up to 2,000 events per request; events at most 7 days old. */
const CAPI_BATCH = 2000;
const CAPI_MAX_AGE_MS = 7 * 24 * 3600_000;

export type SnapchatCreds = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  adAccountId: string;
  /**
   * Long-lived Conversions API token (Business Manager → Business Details →
   * Conversions API Tokens). Falls back to the OAuth access token when absent.
   */
  conversionsToken?: string;
  /** Called when Snap returns a different refresh token on refresh — persist it. */
  onRefreshToken?: (refreshToken: string) => void | Promise<void>;
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
  // The API minimum is 5.00 in the account's currency (USD/EUR/GBP/…); 7 USD covers GBP and EUR.
  minDailyUsd: 7,
  clickIdParam: "ScCid",
  identity: "app_account",
  identityHelp:
    "The app's Snapchat Public Profile must be shared with day2's Snap Business organization (Business Manager → Public Profiles) so day2's ad account can run ads as it.",
  audiences: ["consumer"],
  env: ["SNAP_CLIENT_ID", "SNAP_CLIENT_SECRET", "SNAP_REFRESH_TOKEN", "SNAP_AD_ACCOUNT_ID"],
  apiVersion: "v1 (Conversions API v3)",
};

export function credentialsFromEnv(env: Record<string, string | undefined>): SnapchatCreds | null {
  const clientId = env.SNAP_CLIENT_ID?.trim();
  const clientSecret = env.SNAP_CLIENT_SECRET?.trim();
  const refreshToken = env.SNAP_REFRESH_TOKEN?.trim();
  const adAccountId = env.SNAP_AD_ACCOUNT_ID?.trim();
  if (!clientId || !clientSecret || !refreshToken || !adAccountId) return null;
  const conversionsToken = env.SNAP_CAPI_TOKEN?.trim();
  return { clientId, clientSecret, refreshToken, adAccountId, ...(conversionsToken ? { conversionsToken } : {}) };
}

/** Snap's WEB_VIEW call_to_action enum has no LEARN_MORE/GET_STARTED; MORE and TRY are the closest. */
export const CTA: Record<CallToAction, string> = {
  learn_more: "MORE",
  sign_up: "SIGN_UP",
  download: "DOWNLOAD",
  get_started: "TRY",
};

/** day2 conversion → Snap CAPI event. Snap has no "activation" standard event, so it is a custom event. */
export const EVENTS: Record<Conversion["name"], string> = {
  signup: "SIGN_UP",
  activated: "CUSTOM_EVENT_1",
};

type SubItem = { sub_request_status?: string; sub_request_error_reason?: string } & Record<string, unknown>;
type Envelope = { request_status?: string; request_id?: string; debug_message?: string; display_message?: string } & Record<string, unknown>;

type SnapAd = { id: string; ad_squad_id?: string; creative_id?: string; name?: string; type?: string; status?: string; review_status?: string; review_status_reasons?: string[] } & Record<string, unknown>;
type StatBlock = { impressions?: number; swipes?: number; spend?: number };
type TotalStat = { id?: string; type?: string; stats?: StatBlock; breakdown_stats?: { ad?: Array<{ id: string; stats?: StatBlock }> } };
type SnapAccount = { id: string; name?: string; currency?: string; status?: string; organization_id?: string; funding_source_ids?: string[]; billing_center_id?: string };

const err = (message: string, status?: number, retryable = false) => new PlatformError("snapchat", message, status, retryable);

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function create(creds: SnapchatCreds, deps: PlatformDeps = {}): AdPlatform {
  const now = () => (deps.now ? deps.now() : new Date());
  let refreshToken = creds.refreshToken;

  const token = tokenCache(async () => {
    const r = await request<{ access_token?: string; expires_in?: number; refresh_token?: string }>("snapchat", deps, TOKEN_URL, {
      method: "POST",
      form: { grant_type: "refresh_token", client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: refreshToken },
    });
    if (!r?.access_token) throw err("OAuth refresh returned no access_token");
    if (r.refresh_token && r.refresh_token !== refreshToken) {
      refreshToken = r.refresh_token;
      try {
        await creds.onRefreshToken?.(r.refresh_token);
      } catch {
        console.warn("snapchat: onRefreshToken callback failed (new refresh token not persisted)");
      }
    }
    return { accessToken: r.access_token, expiresInSec: r.expires_in ?? 1800 };
  }, () => now().getTime());

  async function api<T = Envelope>(path: string, init: RequestInit2 = {}): Promise<T> {
    const url = path.startsWith("http") ? path : `${BASE}${path}`;
    const res = await request<T>("snapchat", deps, url, {
      ...init,
      headers: { authorization: `Bearer ${await token()}`, ...(init.headers ?? {}) },
    });
    const env = res as unknown as Envelope | undefined;
    if (env && typeof env === "object" && env.request_status && String(env.request_status).toUpperCase() !== "SUCCESS") {
      throw err(`${path.replace(/^https?:\/\/[^/]+/, "")}: ${env.request_status} ${env.display_message ?? env.debug_message ?? ""}`.trim());
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

  let account: SnapAccount | null = null;
  async function getAccount(fresh = false): Promise<SnapAccount> {
    if (!account || fresh) account = one<SnapAccount>(await api(`/adaccounts/${creds.adAccountId}`), "adaccounts", "adaccount");
    return account;
  }
  async function currency(): Promise<string> {
    const c = (await getAccount()).currency;
    if (!c) throw err("ad account has no currency");
    return c;
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

  const micro = (amount: number) => Math.round(amount * 1_000_000);
  const fromMicro = (m?: number) => Math.round((m ?? 0) / 10_000) / 100;

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
      const dailyMicro = micro(spec.dailyBudget);
      if (!Number.isFinite(dailyMicro) || dailyMicro < MIN_DAILY_MICRO) throw err(`daily budget must be at least 5 ${spec.currency}`);
      const pixelId = spec.conversion?.refs.pixelId;
      if (spec.optimizeFor === "signups" && !pixelId) throw err("optimizeFor signups needs conversion.refs.pixelId (ensureConversions)");

      // Budgets are in the account's currency: refuse to spend if day2 thinks it's a different one.
      const acctCurrency = await currency();
      if (acctCurrency !== spec.currency.toUpperCase()) throw err(`ad account currency is ${acctCurrency}, launch spec says ${spec.currency}`);

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
                    web_view_properties: { url: c.link ?? spec.link, block_preload: true },
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
        const signups = spec.optimizeFor === "signups";
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
                  // TRAFFIC (web) allows SWIPES; PIXEL_SIGNUP is listed under SALES (web).
                  objective_v2_properties: { objective_v2_type: signups ? "SALES" : "TRAFFIC" },
                },
              ],
            },
          }),
          "campaigns",
          "campaign",
        );
        created.campaignId = campaign.id;

        // 3. Ad squad: auto bid, daily budget.
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
                  optimization_goal: signups ? "PIXEL_SIGNUP" : "SWIPES",
                  ...(signups ? { pixel_id: pixelId } : {}),
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
      const cur = await currency();
      const statsRes = await api<{ total_stats?: Array<{ total_stat?: TotalStat }> }>(`/campaigns/${c.campaignId}/stats`, {
        query: { granularity: "TOTAL", fields: "impressions,swipes,spend", breakdown: "ad" },
      });
      const total = statsRes.total_stats?.[0]?.total_stat;
      const camp = one<{ status?: string; deleted?: boolean; end_time?: string }>(await api(`/campaigns/${c.campaignId}`), "campaigns", "campaign");
      const adList: SnapAd[] = c.refs.adSquadId ? items<SnapAd>(await api(`/adsquads/${c.refs.adSquadId}/ads`), "ads", "ad") : [];

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
        byCreative[key] = { spend: fromMicro(s.spend), impressions: s.impressions ?? 0, clicks: s.swipes ?? 0, status: adStatus(byId.get(adId)) };
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
        spend: fromMicro(s.spend),
        currency: cur,
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

    async setDailyBudget(c: Launched, amount: number) {
      const m = micro(amount);
      if (!Number.isFinite(m) || m < MIN_DAILY_MICRO) throw err("daily budget must be at least 5 in the account currency");
      const squadId = c.refs.adSquadId;
      if (!squadId) throw err("launched campaign has no adSquadId ref");
      // Ad squad updates are a full-object PUT: read, change the budget, write back.
      const squad = one<Record<string, unknown>>(await api(`/adsquads/${squadId}`), "adsquads", "adsquad");
      const { auto_bid: _a, target_bid: _t, created_at: _c, updated_at: _u, delivery_status: _d, ...rest } = squad;
      await api(`/campaigns/${c.campaignId}/adsquads`, {
        method: "PUT",
        json: { adsquads: [{ ...rest, id: squadId, campaign_id: c.campaignId, delivery_constraint: "DAILY_BUDGET", daily_budget_micro: m }] },
      });
    },

    async setAdActive(c: Launched, key: string, active: boolean) {
      const adId = c.ads[key];
      if (!adId) throw err(`no ad for creative ${key}`);
      // Ad updates are a full-object PUT (omitted defaults reset): read it, flip status, write back the documented fields.
      const ad = one<SnapAd>(await api(`/ads/${adId}`), "ads", "ad");
      const squadId = ad.ad_squad_id ?? c.refs.adSquadId;
      if (!squadId) throw err("launched campaign has no adSquadId ref");
      const keep = ["third_party_on_swipe_tracking_urls", "third_party_paid_impression_tracking_urls"].filter((f) => ad[f] !== undefined);
      await api(`/adsquads/${squadId}/ads`, {
        method: "PUT",
        json: {
          ads: [
            {
              id: adId,
              ad_squad_id: squadId,
              creative_id: ad.creative_id,
              name: ad.name,
              type: ad.type,
              status: active ? "ACTIVE" : "PAUSED",
              ...Object.fromEntries(keep.map((f) => [f, ad[f]])),
            },
          ],
        },
      });
    },

    async accountInfo(): Promise<AdAccountInfo> {
      const a = await getAccount(true);
      let problem: string | undefined;
      if (a.status !== "ACTIVE") problem = `ad account status is ${a.status ?? "unknown"}`;
      else if (Array.isArray(a.funding_source_ids) && !a.funding_source_ids.length && !a.billing_center_id) problem = "ad account has no payment method";
      return { id: a.id, name: a.name ?? a.id, currency: a.currency ?? "", canSpend: !problem, ...(problem ? { problem } : {}) };
    },

    async checkIdentity(identity: Identity) {
      if (identity.platform !== "snapchat" || !identity.ref) return { ok: false as const, problem: "not a Snapchat Public Profile" };
      // Public Profile reads need the snapchat-profile-api scope; a profile the token can read belongs to an organization day2 is in.
      let profile: { id?: string; display_name?: string; organization_id?: string } | undefined;
      try {
        const res = await api<{ public_profiles?: Array<{ public_profile?: typeof profile } & typeof profile> }>(`${BUSINESS_API}/public_profiles/${encodeURIComponent(identity.ref)}`);
        const first = res.public_profiles?.[0];
        profile = first?.public_profile ?? first;
      } catch (e) {
        if (e instanceof PlatformError && e.status && [401, 403, 404].includes(e.status)) {
          return {
            ok: false as const,
            problem: `day2 can't access Public Profile ${identity.ref} (${e.status}): share it with day2's Snap Business organization (and make sure day2's Snap login has the snapchat-profile-api scope)`,
          };
        }
        throw e;
      }
      if (!profile?.id) return { ok: false as const, problem: `Public Profile ${identity.ref} not found` };
      return { ok: true as const };
    },

    async ensureConversions(): Promise<ConversionSetup> {
      // Snap has no API to create a pixel (Ads Manager only), so this finds the ad account's pixel.
      const pixels = items<{ id: string; name?: string; status?: string; effective_status?: string }>(await api(`/adaccounts/${creds.adAccountId}/pixels`), "pixels", "pixel");
      const usable = pixels.filter((p) => (p.effective_status ?? p.status ?? "ACTIVE") === "ACTIVE");
      const pick = usable.find((p) => /day2/i.test(p.name ?? "")) ?? usable[0];
      if (!pick) throw err("the ad account has no active Snap Pixel; create one in Ads Manager → Events Manager, then retry");
      return { platform: "snapchat", refs: { pixelId: pick.id } };
    },

    async sendConversions(setup: ConversionSetup, events: Conversion[]) {
      const pixelId = setup.refs.pixelId;
      if (!pixelId) throw err("conversion setup has no pixelId");
      const rejected: Array<{ eventId: string; why: string }> = [];
      const seen = new Set<string>();
      const data: Array<{ eventId: string; body: Record<string, unknown> }> = [];
      const nowMs = now().getTime();
      for (const ev of events) {
        if (seen.has(ev.eventId)) continue; // duplicate in this batch; Snap also dedups on event_id for 48h
        seen.add(ev.eventId);
        const at = Date.parse(ev.at);
        if (!Number.isFinite(at)) rejected.push({ eventId: ev.eventId, why: "invalid timestamp" });
        else if (nowMs - at > CAPI_MAX_AGE_MS) rejected.push({ eventId: ev.eventId, why: "older than 7 days" });
        else if (ev.click.param.toLowerCase() !== "sccid" || !ev.click.value) rejected.push({ eventId: ev.eventId, why: `not a Snapchat click (${ev.click.param})` });
        // Snap needs a match key; the one day2 has is client_ip_address + client_user_agent (as a pair).
        else if (!ev.clientIp?.trim() || !ev.userAgent?.trim()) rejected.push({ eventId: ev.eventId, why: "no client IP + user agent (Snap's required match key)" });
        else {
          const ext = ev.externalId ? (/^[a-f0-9]{64}$/.test(ev.externalId) ? ev.externalId : sha256(ev.externalId.trim().toLowerCase())) : undefined;
          data.push({
            eventId: ev.eventId,
            body: {
              event_name: EVENTS[ev.name],
              event_time: at,
              event_id: ev.eventId,
              action_source: "WEB",
              event_source_url: ev.pageUrl,
              user_data: {
                sc_click_id: ev.click.value,
                client_ip_address: ev.clientIp!.trim(),
                client_user_agent: ev.userAgent!.trim(),
                ...(ext ? { external_id: ext } : {}),
              },
            },
          });
        }
      }
      let sent = 0;
      const capiToken = creds.conversionsToken ?? (await token());
      for (let i = 0; i < data.length; i += CAPI_BATCH) {
        const batch = data.slice(i, i + CAPI_BATCH);
        let res: { status?: string; reason?: string } | undefined;
        try {
          res = await request<{ status?: string; reason?: string }>("snapchat", deps, `${CAPI}/${encodeURIComponent(pixelId)}/events`, {
            method: "POST",
            query: { access_token: capiToken },
            json: { data: batch.map((b) => b.body) },
          });
        } catch (e) {
          if (e instanceof PlatformError && e.status && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403) {
            for (const b of batch) rejected.push({ eventId: b.eventId, why: e.message });
            continue;
          }
          throw e;
        }
        if (res?.status && res.status.toUpperCase() !== "VALID") {
          for (const b of batch) rejected.push({ eventId: b.eventId, why: `${res.status}: ${res.reason ?? ""}`.trim() });
        } else sent += batch.length;
      }
      return { sent, rejected };
    },
  };
}

function extFor(mime: string): string {
  if (mime === "video/quicktime") return "mov";
  if (mime === "video/mp4") return "mp4";
  if (mime === "image/png") return "png";
  return "jpg";
}
