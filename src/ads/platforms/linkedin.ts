import { assetBytes, fit, poll, redact, request, tokenCache, type RequestInit2 } from "../http";
import {
  PlatformError,
  type AdCreativeInput,
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
 * LinkedIn Marketing API (versioned REST, https://api.linkedin.com/rest/…).
 *
 * Structure per launch, all in day2's own ad account:
 *   dark post(s) authored by the app's organization (Posts API, feedDistribution NONE + adContext)
 *   → campaign group (DRAFT) → campaign (DRAFT, SPONSORED_UPDATES / WEBSITE_VISIT)
 *   → creative(s) referencing the posts → activate group, then campaign (last).
 * Any failure before the campaign is ACTIVE deletes what was created and rethrows.
 *
 * Identity: Identity.ref is the app's LinkedIn Page as `urn:li:organization:{id}`. day2's
 * LinkedIn member (the one whose refresh token is in LINKEDIN_REFRESH_TOKEN) needs the Page role
 * "Sponsored Content Poster" (DIRECT_SPONSORED_CONTENT_POSTER) or Super admin (ADMINISTRATOR) on that
 * Page, plus Account Manager / Campaign Manager on day2's ad account. OAuth scopes: rw_ads, r_ads_reporting,
 * w_organization_social (dark posts + image/video uploads).
 */

const ID = "linkedin" as const;
const API = "https://api.linkedin.com/rest";
const OAUTH = "https://www.linkedin.com/oauth/v2/accessToken";
const DEFAULT_VERSION = "202610";

export type LinkedInCreds = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Numeric sponsored account id. */
  adAccountId: string;
  /** LinkedIn-Version header, YYYYMM. */
  apiVersion: string;
  /** Called with a new refresh token when LinkedIn issues one (day2 keeps it, encrypted). */
  onRefreshToken?: (token: string) => void | Promise<void>;
};

const MB = 1024 * 1024;
const IMG_MIMES = ["image/jpeg", "image/png", "image/gif"];
const IMG_MAX = 5 * MB;
const VID_MAX = 500 * MB;
const vid = (ratio: AssetSpec["ratio"], width: number, height: number): AssetSpec => ({
  kind: "video",
  ratio,
  width,
  height,
  minDurationSec: 3,
  maxDurationSec: 1800,
  maxBytes: VID_MAX,
  mimes: ["video/mp4"],
});

export const info: PlatformInfo = {
  id: ID,
  name: "LinkedIn",
  formats: [
    { kind: "image", ratio: "1.91:1", width: 1200, height: 628, maxBytes: IMG_MAX, mimes: IMG_MIMES },
    { kind: "image", ratio: "1:1", width: 1200, height: 1200, maxBytes: IMG_MAX, mimes: IMG_MIMES },
    vid("1:1", 1080, 1080),
    vid("16:9", 1920, 1080),
    vid("4:5", 1080, 1350),
    vid("9:16", 1080, 1920),
    // Vertical images only show on mobile.
    { kind: "image", ratio: "4:5", width: 720, height: 900, maxBytes: IMG_MAX, mimes: IMG_MIMES },
  ],
  textOnly: false,
  // Intro text max 600 (LinkedIn truncates after ~150 with "see more"); headline max 200 but 70 shows
  // untruncated. No description: the Audience Network (which uses it) is disabled.
  copyLimits: { headline: 70, body: 600 },
  minDailyUsd: 10,
  identity: "app_account",
  identityHelp:
    "The app's LinkedIn Page admin grants day2's LinkedIn member the Page role 'Sponsored Content Poster' (or Super admin), and day2 stores the Page as urn:li:organization:{id}.",
  audiences: ["business"],
  env: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "LINKEDIN_REFRESH_TOKEN", "LINKEDIN_AD_ACCOUNT_ID", "LINKEDIN_API_VERSION (optional)"],
  apiVersion: DEFAULT_VERSION,
};

export function credentialsFromEnv(env: Record<string, string | undefined>): LinkedInCreds | null {
  const clientId = env.LINKEDIN_CLIENT_ID?.trim();
  const clientSecret = env.LINKEDIN_CLIENT_SECRET?.trim();
  const refreshToken = env.LINKEDIN_REFRESH_TOKEN?.trim();
  const account = env.LINKEDIN_AD_ACCOUNT_ID?.trim();
  if (!clientId || !clientSecret || !refreshToken || !account) return null;
  const adAccountId = account.replace(/^urn:li:sponsoredAccount:/, "");
  if (!/^\d+$/.test(adAccountId)) return null;
  const v = env.LINKEDIN_API_VERSION?.trim();
  return { clientId, clientSecret, refreshToken, adAccountId, apiVersion: v && /^\d{6}(\.\d+)?$/.test(v) ? v : DEFAULT_VERSION };
}

/** LinkedIn's contentCallToActionLabel values (no GET_STARTED exists; SIGN_UP is the closest). */
const CTA: Record<CallToAction, string> = {
  learn_more: "LEARN_MORE",
  sign_up: "SIGN_UP",
  download: "DOWNLOAD",
  get_started: "SIGN_UP",
};

/** ISO 639-1 → a LinkedIn-supported locale (campaign locale + interfaceLocales targeting). */
const LOCALES: Record<string, string> = {
  en: "en_US", de: "de_DE", fr: "fr_FR", es: "es_ES", it: "it_IT", pt: "pt_BR", nl: "nl_NL", ja: "ja_JP",
  zh: "zh_CN", ko: "ko_KR", ru: "ru_RU", sv: "sv_SE", tr: "tr_TR", pl: "pl_PL", ro: "ro_RO", cs: "cs_CZ",
  da: "da_DK", no: "no_NO", nb: "no_NO", ms: "ms_MY", id: "in_ID", th: "th_TH", tl: "tl_PH", ar: "ar_AE",
};

/** Geo URNs given verbatim in LinkedIn's docs; everything else is resolved via adTargetingEntities typeahead. */
const KNOWN_GEOS: Record<string, string> = { US: "urn:li:geo:103644278", CA: "urn:li:geo:101174742" };
/** Alternate English names LinkedIn may use for a country. */
const GEO_ALIASES: Record<string, string[]> = {
  CZ: ["Czech Republic"],
  KR: ["Korea"],
  GB: ["UK"],
  AE: ["UAE"],
  TR: ["Turkey"],
  CI: ["Cote d'Ivoire", "Côte d'Ivoire", "Ivory Coast"],
  MK: ["Macedonia"],
  HK: ["Hong Kong"],
  TW: ["Taiwan"],
};

const enc = encodeURIComponent;
/** Rest.li 2.0 list in a query string: List(urn%3Ali%3A…,…) — parentheses/commas stay literal. */
const restliList = (urns: string[]) => `List(${urns.map(enc).join(",")})`;

/** Escapes the reserved characters of LinkedIn's "little" text format (post commentary). */
export function littleText(s: string): string {
  return s.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);
}

type InitImage = { value: { uploadUrl: string; image: string } };
type InitVideo = {
  value: { video: string; uploadToken?: string; uploadInstructions: Array<{ uploadUrl: string; firstByte: number; lastByte: number }>; thumbnailUploadUrl?: string };
};
type Campaign = { status?: string; servingStatuses?: string[] };
type Creative = {
  id: string;
  intendedStatus?: string;
  isServing?: boolean;
  servingHoldReasons?: string[];
  review?: { status?: string; rejectionReasons?: string[] };
};
type AnalyticsRow = { costInUsd?: string | number; impressions?: number; clicks?: number; pivotValues?: string[] };

export function create(creds: LinkedInCreds, deps: PlatformDeps = {}): AdPlatform {
  const nowMs = () => (deps.now ? deps.now() : new Date()).getTime();
  const account = creds.adAccountId;
  const accountUrn = `urn:li:sponsoredAccount:${account}`;
  let refreshToken = creds.refreshToken;

  const token = tokenCache(async () => {
    const r = await request<{ access_token?: string; expires_in?: number; refresh_token?: string }>(ID, deps, OAUTH, {
      method: "POST",
      form: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: creds.clientId, client_secret: creds.clientSecret },
    });
    if (!r?.access_token) throw new PlatformError(ID, "token refresh returned no access_token");
    // LinkedIn returns the refresh token with each refresh; keep the newest for this process.
    if (r.refresh_token && r.refresh_token !== refreshToken) {
      refreshToken = r.refresh_token;
      await Promise.resolve(creds.onRefreshToken?.(r.refresh_token)).catch(() => {});
    }
    return { accessToken: r.access_token, expiresInSec: r.expires_in ?? 3600 };
  }, nowMs);

  async function headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await token()}`,
      "linkedin-version": creds.apiVersion,
      "x-restli-protocol-version": "2.0.0",
      ...extra,
    };
  }

  /** JSON call to the versioned API. */
  async function api<T = unknown>(path: string, init: RequestInit2 & { restliMethod?: string } = {}): Promise<T> {
    const { restliMethod, ...rest } = init;
    return request<T>(ID, deps, `${API}${path}`, { ...rest, headers: await headers(restliMethod ? { "x-restli-method": restliMethod } : {}) });
  }

  /** A create call whose id comes back in the x-restli-id header. */
  async function createEntity(path: string, json: unknown, what: string): Promise<string> {
    const res = await request<Response>(ID, deps, `${API}${path}`, { method: "POST", json, headers: await headers(), rawResponse: true });
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new PlatformError(ID, `creating ${what}: ${res.status} ${redact(text.slice(0, 500))}`, res.status, false);
    let id = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id");
    if (!id && text) {
      try {
        id = (JSON.parse(text) as { id?: string | number }).id?.toString() ?? null;
      } catch {
        /* no body id */
      }
    }
    if (!id) throw new PlatformError(ID, `creating ${what}: no id in response`, res.status, false);
    return decodeURIComponent(id);
  }

  const lastSegment = (urnOrId: string) => urnOrId.split(":").pop() ?? urnOrId;
  const patch = (path: string, set: Record<string, unknown>) => api(path, { method: "POST", restliMethod: "PARTIAL_UPDATE", json: { patch: { $set: set } } });
  const campaignPath = (id: string) => `/adAccounts/${account}/adCampaigns/${id}`;
  const groupPath = (id: string) => `/adAccounts/${account}/adCampaignGroups/${id}`;
  const usd = (n: number) => ({ amount: n.toFixed(2), currencyCode: "USD" });

  // ---------- targeting ----------

  const geoCache = new Map<string, string>();
  async function geoUrn(country: string): Promise<string> {
    const cc = country.toUpperCase();
    const known = KNOWN_GEOS[cc] ?? geoCache.get(cc);
    if (known) return known;
    let name: string | undefined;
    try {
      name = new Intl.DisplayNames(["en"], { type: "region" }).of(cc);
    } catch {
      name = undefined;
    }
    if (!name || name === cc) throw new PlatformError(ID, `unknown country code ${country}`);
    const names = [name, ...(GEO_ALIASES[cc] ?? [])].map((n) => n.toLowerCase());
    const r = await api<{ elements?: Array<{ urn: string; name: string; facetUrn?: string }> }>(
      `/adTargetingEntities?q=typeahead&queryVersion=QUERY_USES_URNS&facet=${enc("urn:li:adTargetingFacet:locations")}&query=${enc(name)}&locale=(language:en,country:US)`,
    );
    const hit = (r?.elements ?? []).find((e) => e.urn?.startsWith("urn:li:geo:") && names.includes(e.name?.trim().toLowerCase()));
    if (!hit) throw new PlatformError(ID, `no LinkedIn location matches country ${cc} (${name})`);
    geoCache.set(cc, hit.urn);
    return hit.urn;
  }

  let jobFunctions: Array<{ urn: string; name: string }> | null = null;
  async function jobFunctionUrns(interests: string[]): Promise<string[]> {
    if (!interests.length) return [];
    try {
      jobFunctions ??=
        (
          await api<{ elements?: Array<{ urn: string; name: string }> }>(
            `/adTargetingEntities?q=adTargetingFacet&queryVersion=QUERY_USES_URNS&facet=${enc("urn:li:adTargetingFacet:jobFunctions")}&locale=(language:en,country:US)`,
          )
        )?.elements ?? [];
    } catch {
      return []; // best effort: location targeting alone is still valid
    }
    const wanted = new Set(interests.map((i) => i.trim().toLowerCase()));
    return [...new Set(jobFunctions.filter((f) => wanted.has(f.name?.trim().toLowerCase())).map((f) => f.urn))];
  }

  // ---------- assets ----------

  function checkAsset(a: Asset) {
    const spec = info.formats.find((f) => f.kind === a.kind && f.ratio === a.ratio);
    if (!spec) throw new PlatformError(ID, `${a.kind} ${a.ratio} is not a LinkedIn format`);
    if (a.bytes > spec.maxBytes) throw new PlatformError(ID, `${a.kind} ${a.id} is ${a.bytes} bytes, over LinkedIn's ${spec.maxBytes}`);
    if (!spec.mimes.includes(a.mime)) throw new PlatformError(ID, `${a.mime} is not accepted for LinkedIn ${a.kind}s`);
    if (a.kind === "video" && a.durationSec !== undefined && (a.durationSec < 3 || a.durationSec > 1800))
      throw new PlatformError(ID, `video ${a.id} is ${a.durationSec}s; LinkedIn needs 3s–30min`);
  }

  async function waitAvailable(kind: "images" | "videos", urn: string): Promise<void> {
    await poll(
      deps,
      async () => {
        const r = await api<{ status?: string; processingFailureReason?: string }>(`/${kind}/${enc(urn)}`);
        if (r?.status === "AVAILABLE") return true;
        if (r?.status === "PROCESSING_FAILED") throw new PlatformError(ID, `${kind} ${urn} processing failed${r.processingFailureReason ? `: ${r.processingFailureReason}` : ""}`);
        return undefined;
      },
      { platform: ID, what: `${kind} ${urn} to be available`, everyMs: 3000, timeoutMs: 15 * 60_000 },
    );
  }

  async function uploadImage(a: Asset, owner: string): Promise<string> {
    const init = await api<InitImage>(`/images?action=initializeUpload`, { method: "POST", json: { initializeUploadRequest: { owner } } });
    if (!init?.value?.uploadUrl || !init.value.image) throw new PlatformError(ID, "image initializeUpload returned no uploadUrl");
    const bytes = await assetBytes(deps, a);
    await request(ID, deps, init.value.uploadUrl, {
      method: "PUT",
      raw: bytes,
      headers: { authorization: `Bearer ${await token()}`, "content-type": a.mime },
    });
    await waitAvailable("images", init.value.image);
    return init.value.image;
  }

  async function uploadVideo(a: Asset, owner: string): Promise<string> {
    const bytes = await assetBytes(deps, a);
    const thumb = a.thumbnail && a.thumbnail.kind === "image" ? a.thumbnail : undefined;
    const init = await api<InitVideo>(`/videos?action=initializeUpload`, {
      method: "POST",
      json: { initializeUploadRequest: { owner, fileSizeBytes: bytes.byteLength, uploadCaptions: false, uploadThumbnail: !!thumb } },
    });
    const v = init?.value;
    if (!v?.video || !v.uploadInstructions?.length) throw new PlatformError(ID, "video initializeUpload returned no upload instructions");
    const etags: string[] = [];
    for (const part of v.uploadInstructions) {
      const res = await request<Response>(ID, deps, part.uploadUrl, {
        method: "PUT",
        raw: bytes.subarray(part.firstByte, part.lastByte + 1),
        headers: { "content-type": "application/octet-stream" },
        rawResponse: true,
      });
      if (!res.ok) throw new PlatformError(ID, `video part upload: ${res.status}`, res.status, false);
      const etag = res.headers.get("etag");
      if (!etag) throw new PlatformError(ID, "video part upload returned no ETag", res.status, false);
      etags.push(etag);
    }
    if (thumb && v.thumbnailUploadUrl) {
      // Best effort: LinkedIn generates a thumbnail if this fails.
      try {
        await request(ID, deps, v.thumbnailUploadUrl, { method: "PUT", raw: await assetBytes(deps, thumb), headers: { "content-type": thumb.mime }, retries: 2 });
      } catch {
        /* ignore */
      }
    }
    await api(`/videos?action=finalizeUpload`, {
      method: "POST",
      json: { finalizeUploadRequest: { video: v.video, uploadToken: v.uploadToken ?? "", uploadedPartIds: etags } },
    });
    await waitAvailable("videos", v.video);
    return v.video;
  }

  async function darkPost(c: AdCreativeInput, media: string, org: string, link: string): Promise<string> {
    return createEntity(
      "/posts",
      {
        author: org,
        commentary: littleText(fit(c.copy.body, info.copyLimits.body)),
        visibility: "PUBLIC",
        distribution: { feedDistribution: "NONE", targetEntities: [], thirdPartyDistributionChannels: [] },
        content: { media: { title: fit(c.copy.headline, info.copyLimits.headline), id: media } },
        contentLandingPage: link,
        contentCallToActionLabel: CTA[c.copy.cta] ?? "LEARN_MORE",
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: true,
        adContext: { dscAdAccount: accountUrn, dscStatus: "ACTIVE", dscName: c.key.slice(0, 255) },
      },
      "dark post",
    );
  }

  // ---------- cleanup ----------

  async function bestEffort(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch {
      /* cleanup must not mask the original error */
    }
  }

  async function del(path: string) {
    return api(path, { method: "DELETE", restliMethod: "DELETE", retries: 2 });
  }

  // ---------- status ----------

  function creativeStatus(c: Creative): CampaignStatus {
    const review = c.review?.status;
    if (review === "REJECTED") return "rejected";
    if (["ARCHIVED", "CANCELED", "REMOVED", "PENDING_DELETION"].includes(c.intendedStatus ?? "")) return "ended";
    if (c.intendedStatus === "PAUSED" || c.intendedStatus === "DRAFT") return "paused";
    if (review === "PENDING" || review === "NEEDS_REVIEW") return "in_review";
    if (c.isServing) return "active";
    if (c.servingHoldReasons?.includes("UNDER_REVIEW")) return "in_review";
    if (review === "APPROVED") return "active";
    return "unknown";
  }

  return {
    id: ID,

    async launch(spec: LaunchSpec): Promise<Launched> {
      // ---- validate everything before anything is created ----
      if (!spec.identity?.ref) throw new PlatformError(ID, "LinkedIn needs the app's organization (identity.ref = urn:li:organization:{id})");
      const ref = spec.identity.ref.trim();
      const org = /^\d+$/.test(ref) ? `urn:li:organization:${ref}` : ref;
      if (!/^urn:li:organization:\d+$/.test(org)) throw new PlatformError(ID, `identity.ref must be urn:li:organization:{id}, got ${ref}`);
      if (!spec.creatives.length) throw new PlatformError(ID, "no creatives");
      if (spec.dailyBudgetUsd < info.minDailyUsd) throw new PlatformError(ID, `daily budget $${spec.dailyBudgetUsd} is below LinkedIn's $${info.minDailyUsd} minimum`);
      for (const c of spec.creatives) {
        if (!c.asset) throw new PlatformError(ID, `creative ${c.key}: LinkedIn sponsored content needs an image or video`);
        checkAsset(c.asset);
      }
      const kinds = new Set(spec.creatives.map((c) => c.asset!.kind));
      if (kinds.size > 1) throw new PlatformError(ID, "a LinkedIn campaign can't mix image and video ads; launch them as separate campaigns");
      if (!spec.targeting.countries.length) throw new PlatformError(ID, "no countries to target");

      const geos: string[] = [];
      for (const cc of spec.targeting.countries) {
        const g = await geoUrn(cc);
        if (!geos.includes(g)) geos.push(g);
      }
      const locales = [...new Set(spec.targeting.languages.map((l) => LOCALES[l.toLowerCase().slice(0, 2)]).filter((l): l is string => !!l))];
      if (!locales.length) locales.push("en_US");
      const functions = spec.targeting.audience === "business" ? await jobFunctionUrns(spec.targeting.interests) : [];
      const [lang = "en", localeCountry = "US"] = locales[0]!.split("_");

      const and: Array<{ or: Record<string, string[]> }> = [
        { or: { "urn:li:adTargetingFacet:locations": geos } },
        { or: { "urn:li:adTargetingFacet:interfaceLocales": locales.map((l) => `urn:li:locale:${l}`) } },
      ];
      if (functions.length) and.push({ or: { "urn:li:adTargetingFacet:jobFunctions": functions } });

      const start = nowMs();
      const startDate = new Date(start).toISOString().slice(0, 10);
      const posts: string[] = [];
      const creatives: string[] = [];
      let groupId: string | undefined;
      let campaignId: string | undefined;
      let campaignActive = false;

      try {
        // 1. Media + dark posts (nothing here can spend money).
        const postByKey: Record<string, string> = {};
        for (const c of spec.creatives) {
          const a = c.asset!;
          const media = a.kind === "image" ? await uploadImage(a, org) : await uploadVideo(a, org);
          const post = await darkPost(c, media, org, spec.link);
          posts.push(post);
          postByKey[c.key] = post;
        }

        // 2. Campaign group + campaign, both DRAFT.
        groupId = lastSegment(
          await createEntity(
            `/adAccounts/${account}/adCampaignGroups`,
            { account: accountUrn, name: spec.campaignName.slice(0, 100), status: "DRAFT", runSchedule: { start } },
            "campaign group",
          ),
        );
        campaignId = lastSegment(
          await createEntity(
            `/adAccounts/${account}/adCampaigns`,
            {
              account: accountUrn,
              campaignGroup: `urn:li:sponsoredCampaignGroup:${groupId}`,
              name: spec.campaignName.slice(0, 100),
              type: "SPONSORED_UPDATES",
              objectiveType: "WEBSITE_VISIT",
              // Automated bidding for clicks (LinkedIn bills CPM for MAX_CLICK); the daily budget caps spend.
              costType: "CPM",
              optimizationTargetType: "MAX_CLICK",
              unitCost: usd(0),
              dailyBudget: usd(spec.dailyBudgetUsd),
              locale: { country: localeCountry, language: lang },
              targetingCriteria: { include: { and } },
              runSchedule: { start },
              creativeSelection: "OPTIMIZED",
              audienceExpansionEnabled: false,
              offsiteDeliveryEnabled: false,
              politicalIntent: "NOT_POLITICAL",
              status: "DRAFT",
            },
            "campaign",
          ),
        );

        // 3. Creatives (serve only once the campaign is ACTIVE).
        const ads: Record<string, string> = {};
        for (const c of spec.creatives) {
          const urn = await createEntity(
            `/adAccounts/${account}/creatives`,
            { campaign: `urn:li:sponsoredCampaign:${campaignId}`, content: { reference: postByKey[c.key] }, intendedStatus: "ACTIVE", name: c.key.slice(0, 255) },
            "creative",
          );
          const creativeUrn = urn.startsWith("urn:") ? urn : `urn:li:sponsoredCreative:${urn}`;
          creatives.push(creativeUrn);
          ads[c.key] = creativeUrn;
        }

        // 4. Activate: group first, campaign last.
        await patch(groupPath(groupId), { status: "ACTIVE" });
        await patch(campaignPath(campaignId), { status: "ACTIVE" });
        campaignActive = true;

        return {
          platform: ID,
          campaignId,
          refs: { account, campaignGroup: groupId, startDate, posts: posts.join(",") },
          ads,
        };
      } catch (err) {
        if (!campaignActive) {
          // DRAFT campaigns and their creatives can be deleted outright.
          for (const cr of creatives) await bestEffort(() => del(`/adAccounts/${account}/creatives/${enc(cr)}`));
          if (campaignId) {
            const id = campaignId;
            await bestEffort(() => del(campaignPath(id)));
          }
          if (groupId) {
            const id = groupId;
            await bestEffort(() => del(groupPath(id)));
          }
          for (const p of posts) await bestEffort(() => del(`/posts/${enc(p)}`));
        }
        if (err instanceof PlatformError) throw err;
        throw new PlatformError(ID, `launch failed: ${redact((err as Error)?.message ?? String(err))}`);
      }
    },

    async stats(c: Launched): Promise<AdStats> {
      const campaignUrn = `urn:li:sponsoredCampaign:${c.campaignId}`;
      const [y, m, d] = (c.refs.startDate ?? "2020-01-01").split("-").map(Number);
      const range = `(start:(year:${y},month:${m},day:${d}))`;
      const base = `/adAnalytics?q=analytics&timeGranularity=ALL&dateRange=${range}&campaigns=${restliList([campaignUrn])}&fields=costInUsd,impressions,clicks,pivotValues`;

      const byCampaign = await api<{ elements?: AnalyticsRow[] }>(`${base}&pivot=CAMPAIGN`);
      const byCreativeRows = await api<{ elements?: AnalyticsRow[] }>(`${base}&pivot=CREATIVE`);
      const campaign = await api<Campaign>(campaignPath(c.campaignId));
      const creativeList = await api<{ elements?: Creative[] }>(`/adAccounts/${account}/creatives?q=criteria&campaigns=${restliList([campaignUrn])}&pageSize=100`, {
        restliMethod: "FINDER",
      });

      const num = (v: unknown) => {
        const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
        return Number.isFinite(n) ? n : 0;
      };
      const total = { spendUsd: 0, impressions: 0, clicks: 0 };
      for (const r of byCampaign?.elements ?? []) {
        total.spendUsd += num(r.costInUsd);
        total.impressions += num(r.impressions);
        total.clicks += num(r.clicks);
      }

      const keyByUrn = new Map(Object.entries(c.ads).map(([k, urn]) => [urn, k]));
      const byCreative: NonNullable<AdStats["byCreative"]> = {};
      for (const k of Object.keys(c.ads)) byCreative[k] = { spendUsd: 0, impressions: 0, clicks: 0 };
      for (const r of byCreativeRows?.elements ?? []) {
        const key = keyByUrn.get(r.pivotValues?.[0] ?? "");
        if (!key) continue;
        const s = byCreative[key]!;
        s.spendUsd += num(r.costInUsd);
        s.impressions += num(r.impressions);
        s.clicks += num(r.clicks);
      }

      const rejections: string[] = [];
      const creativeStatuses: CampaignStatus[] = [];
      for (const cr of creativeList?.elements ?? []) {
        const key = keyByUrn.get(cr.id);
        if (!key) continue;
        const st = creativeStatus(cr);
        byCreative[key]!.status = st;
        creativeStatuses.push(st);
        if (st === "rejected") rejections.push(`${key}: ${(cr.review?.rejectionReasons ?? []).join(", ") || "rejected"}`);
      }

      let status: CampaignStatus;
      const cs = campaign?.status ?? "";
      if (["COMPLETED", "ARCHIVED", "CANCELED", "REMOVED", "PENDING_DELETION"].includes(cs)) status = "ended";
      else if (cs === "PAUSED" || cs === "DRAFT") status = "paused";
      else if (cs === "ACTIVE") {
        if (creativeStatuses.length && creativeStatuses.every((s) => s === "rejected")) status = "rejected";
        else if (creativeStatuses.includes("active")) status = campaign.servingStatuses?.length && !campaign.servingStatuses.includes("RUNNABLE") ? "unknown" : "active";
        else if (creativeStatuses.includes("in_review")) status = "in_review";
        else if (campaign.servingStatuses?.includes("RUNNABLE")) status = "active";
        else status = "unknown";
      } else status = "unknown";

      const out: AdStats = { spendUsd: Math.round(total.spendUsd * 100) / 100, impressions: total.impressions, clicks: total.clicks, status, byCreative };
      if (rejections.length) out.rejection = rejections.join("; ");
      return out;
    },

    async pause(c: Launched) {
      await patch(campaignPath(c.campaignId), { status: "PAUSED" });
    },

    async resume(c: Launched) {
      await patch(campaignPath(c.campaignId), { status: "ACTIVE" });
    },

    async setDailyBudget(c: Launched, amountUsd: number) {
      if (!(amountUsd >= info.minDailyUsd)) throw new PlatformError(ID, `daily budget $${amountUsd} is below LinkedIn's $${info.minDailyUsd} minimum`);
      await patch(campaignPath(c.campaignId), { dailyBudget: usd(amountUsd) });
    },
  };
}
