import { assetBytes, fit, request, tokenCache, type RequestInit2 } from "../http";
import {
  PlatformError,
  type AdCreativeInput,
  type AdPlatform,
  type AdStats,
  type Asset,
  type CallToAction,
  type CampaignStatus,
  type LaunchSpec,
  type Launched,
  type PlatformDeps,
  type PlatformInfo,
} from "../types";

/**
 * Google Ads API (REST interface), written against v26 (released 2026-10-14).
 *
 * - Text-only creatives (asset null) launch as a Search campaign with one
 *   responsive search ad per creative and phrase-match keywords from
 *   spec.targeting.keywords. Location/language: campaign criteria.
 * - Image creatives launch as a Demand Gen campaign with one
 *   DemandGenMultiAssetAd per image. Images are uploaded via AssetService
 *   first; location/language are ad-group criteria (Demand Gen campaigns
 *   with upgraded targeting reject campaign-level location criteria).
 * - Everything below the campaign is created in ONE atomic
 *   GoogleAdsService.Mutate with temporary (negative) resource names, with
 *   the campaign PAUSED; it's enabled only afterwards. If enabling fails the
 *   campaign and its budget are removed.
 * - Videos need YouTube uploads and are out of scope.
 *
 * Money: budgets are written in micros of the account currency; the adapter
 * refuses to create or change budgets unless the account currency is USD.
 */

const PLATFORM = "google" as const;
const DEFAULT_VERSION = "v26";
const BASE = "https://googleads.googleapis.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif"];
const MAX_IMAGE_BYTES = 5_120 * 1024;

export const info: PlatformInfo = {
  id: PLATFORM,
  name: "Google Ads",
  formats: [
    // Demand Gen marketing images (min 600x314), square (min 300x300), portrait (min 480x600).
    { kind: "image", ratio: "1.91:1", width: 1200, height: 628, maxBytes: MAX_IMAGE_BYTES, mimes: IMAGE_MIMES },
    { kind: "image", ratio: "1:1", width: 1200, height: 1200, maxBytes: MAX_IMAGE_BYTES, mimes: IMAGE_MIMES },
    { kind: "image", ratio: "4:5", width: 960, height: 1200, maxBytes: MAX_IMAGE_BYTES, mimes: IMAGE_MIMES },
  ],
  textOnly: true,
  copyLimits: { headline: 30, body: 90, description: 90 },
  minDailyUsd: 10,
  identity: "none",
  audiences: ["consumer", "business"],
  env: [
    "GOOGLE_ADS_DEVELOPER_TOKEN",
    "GOOGLE_ADS_CLIENT_ID",
    "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_REFRESH_TOKEN",
    "GOOGLE_ADS_CUSTOMER_ID",
    "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
    "GOOGLE_ADS_API_VERSION",
  ],
  apiVersion: DEFAULT_VERSION,
};

export type GoogleCreds = {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Digits only, the account the campaigns live in. */
  customerId: string;
  /** Digits only, the manager (MCC) account used for access, if any. */
  loginCustomerId?: string;
  apiVersion: string;
};

const digits = (s: string) => s.replace(/[\s-]/g, "");

export function credentialsFromEnv(env: Record<string, string | undefined>): GoogleCreds | null {
  const developerToken = env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim();
  const clientId = env.GOOGLE_ADS_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_ADS_CLIENT_SECRET?.trim();
  const refreshToken = env.GOOGLE_ADS_REFRESH_TOKEN?.trim();
  const customerId = env.GOOGLE_ADS_CUSTOMER_ID ? digits(env.GOOGLE_ADS_CUSTOMER_ID) : "";
  if (!developerToken || !clientId || !clientSecret || !refreshToken || !/^\d{10}$/.test(customerId)) return null;
  const login = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? digits(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) : "";
  if (login && !/^\d{10}$/.test(login)) return null;
  const version = env.GOOGLE_ADS_API_VERSION?.trim() || DEFAULT_VERSION;
  if (!/^v\d+$/.test(version)) return null;
  return { developerToken, clientId, clientSecret, refreshToken, customerId, loginCustomerId: login || undefined, apiVersion: version };
}

// ---------------------------------------------------------------------------

type MutateResponse = { mutateOperationResponses?: Array<Record<string, { resourceName?: string } | undefined>> };
type ServiceMutateResponse = { results?: Array<{ resourceName?: string }> };
type SearchResponse<T> = { results?: T[]; nextPageToken?: string };

type PolicyTopicEntry = { topic?: string; type?: string };
type CampaignRow = {
  campaign?: { resourceName?: string; status?: string; primaryStatus?: string; servingStatus?: string };
  metrics?: Metrics;
};
type AdRow = {
  adGroupAd?: {
    resourceName?: string;
    status?: string;
    ad?: { id?: string };
    policySummary?: { approvalStatus?: string; reviewStatus?: string; policyTopicEntries?: PolicyTopicEntry[] };
  };
  metrics?: Metrics;
};
type Metrics = { costMicros?: string | number; impressions?: string | number; clicks?: string | number };

const CTA_TEXT: Record<CallToAction, string> = {
  learn_more: "Learn More",
  sign_up: "Sign Up",
  download: "Download Now",
  get_started: "Get Started",
};

/** USD → micros, rounded to whole cents (budgets must be a multiple of the currency's minimum unit). */
export function usdToMicros(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) throw new PlatformError(PLATFORM, `invalid daily budget: ${usd}`);
  return String(Math.round(usd * 100) * 10_000);
}

/** Escapes a value for a single-quoted GAQL string literal. */
const gaqlString = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const idOf = (resourceName: string) => resourceName.split("/").pop() ?? resourceName;

function uniqueCi(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const t = raw.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

const stripEnd = (s: string) => s.trim().replace(/[\s.!?,;:…–-]+$/, "");

/** Headlines from the creative's own copy only (no invented claims). */
export function headlinesFor(c: AdCreativeInput, appName: string, max: number, limit: number): string[] {
  const cta = CTA_TEXT[c.copy.cta];
  const app = appName.trim();
  return uniqueCi([c.copy.headline, app, cta, `${app} – ${cta}`, `Try ${app}`].map((h) => fit(h, max))).slice(0, limit);
}

export function descriptionsFor(c: AdCreativeInput, appName: string, max: number, limit: number): string[] {
  const cta = CTA_TEXT[c.copy.cta];
  return uniqueCi(
    [c.copy.body, c.copy.description ?? "", `${stripEnd(c.copy.headline)}. ${cta}.`, `${stripEnd(appName)}. ${cta}.`].map((d) => (d.trim() ? fit(d, max) : "")),
  ).slice(0, limit);
}

/** Keywords Google accepts: ≤80 chars, ≤10 words, no ellipses or odd symbols. */
export function cleanKeywords(list: string[]): string[] {
  return uniqueCi(
    list
      .map((k) => k.toLowerCase().replace(/[^\p{L}\p{N}\s&'.-]/gu, " ").replace(/\s+/g, " ").trim())
      .filter((k) => k.length > 0 && k.length <= 80 && k.split(" ").length <= 10),
  );
}

const IMAGE_FIELD: Partial<Record<Asset["ratio"], string>> = {
  "1.91:1": "marketingImages",
  "1:1": "squareMarketingImages",
  "4:5": "portraitMarketingImages",
  "9:16": "tallPortraitMarketingImages",
};

// ---------------------------------------------------------------------------

export function create(creds: GoogleCreds, deps: PlatformDeps = {}): AdPlatform {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const version = creds.apiVersion || DEFAULT_VERSION;
  const cid = creds.customerId;
  const customerPath = `customers/${cid}`;
  const api = `${BASE}/${version}/${customerPath}`;

  const token = tokenCache(async () => {
    const r = await request<{ access_token?: string; expires_in?: number }>(PLATFORM, deps, TOKEN_URL, {
      method: "POST",
      form: { grant_type: "refresh_token", client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: creds.refreshToken },
    });
    if (!r?.access_token) throw new PlatformError(PLATFORM, "OAuth refresh returned no access token", 401);
    return { accessToken: r.access_token, expiresInSec: Number(r.expires_in ?? 3600) };
  }, () => now().getTime());

  async function headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = { authorization: `Bearer ${await token()}`, "developer-token": creds.developerToken };
    if (creds.loginCustomerId) h["login-customer-id"] = creds.loginCustomerId;
    return h;
  }

  /** Marks quota errors that didn't come back as HTTP 429 as retryable too. */
  function normalize(err: unknown): never {
    if (err instanceof PlatformError && !err.retryable && /RESOURCE_EXHAUSTED|RESOURCE_TEMPORARILY_EXHAUSTED/.test(err.message)) {
      throw new PlatformError(PLATFORM, err.message.replace(/^google: /, ""), err.status, true);
    }
    throw err;
  }

  async function call<T>(path: string, json: unknown, opts: Pick<RequestInit2, "retries"> = {}): Promise<T> {
    try {
      return await request<T>(PLATFORM, deps, `${api}/${path}`, { method: "POST", headers: await headers(), json, ...opts });
    } catch (err) {
      normalize(err);
    }
  }

  async function search<T>(query: string): Promise<T[]> {
    const rows: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await call<SearchResponse<T>>("googleAds:search", pageToken ? { query, pageToken } : { query });
      rows.push(...(r?.results ?? []));
      pageToken = r?.nextPageToken;
      if (!pageToken) break;
    }
    return rows;
  }

  let currencyChecked = false;
  async function assertUsd(): Promise<void> {
    if (currencyChecked) return;
    const rows = await search<{ customer?: { currencyCode?: string } }>("SELECT customer.currency_code FROM customer");
    const cur = rows[0]?.customer?.currencyCode;
    if (cur !== "USD") throw new PlatformError(PLATFORM, `account ${cid} bills in ${cur ?? "an unknown currency"}, expected USD; refusing to set budgets`);
    currencyChecked = true;
  }

  async function geoTargets(countries: string[]): Promise<string[]> {
    const codes = [...new Set(countries.map((c) => c.trim().toUpperCase()))];
    if (codes.length === 0) throw new PlatformError(PLATFORM, "no target countries");
    const bad = codes.filter((c) => !/^[A-Z]{2}$/.test(c));
    if (bad.length) throw new PlatformError(PLATFORM, `invalid country codes: ${bad.join(", ")}`);
    const rows = await search<{ geoTargetConstant?: { resourceName?: string; countryCode?: string } }>(
      `SELECT geo_target_constant.resource_name, geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.target_type = 'Country' AND geo_target_constant.status = 'ENABLED' AND geo_target_constant.country_code IN (${codes.map(gaqlString).join(", ")})`,
    );
    const byCode = new Map<string, string>();
    for (const r of rows) {
      const g = r.geoTargetConstant;
      if (g?.resourceName && g.countryCode) byCode.set(g.countryCode.toUpperCase(), g.resourceName);
    }
    const missing = codes.filter((c) => !byCode.has(c));
    if (missing.length) throw new PlatformError(PLATFORM, `no geo target constant for countries: ${missing.join(", ")}`);
    return codes.map((c) => byCode.get(c)!);
  }

  /** Unknown languages are skipped (no language criterion = all languages). */
  async function languageConstants(languages: string[]): Promise<string[]> {
    const codes = [...new Set(languages.map((l) => l.trim().toLowerCase()).filter((l) => /^[a-z]{2,3}$/.test(l)))];
    if (codes.length === 0) return [];
    const rows = await search<{ languageConstant?: { resourceName?: string; code?: string } }>(
      `SELECT language_constant.resource_name, language_constant.code FROM language_constant WHERE language_constant.targetable = TRUE AND language_constant.code IN (${codes.map(gaqlString).join(", ")})`,
    );
    return rows.map((r) => r.languageConstant?.resourceName).filter((r): r is string => !!r);
  }

  async function uploadImages(assets: Asset[], label: string): Promise<Map<string, string>> {
    const unique = [...new Map(assets.map((a) => [a.id, a])).values()];
    const operations = await Promise.all(
      unique.map(async (a) => {
        if (!IMAGE_MIMES.includes(a.mime)) throw new PlatformError(PLATFORM, `unsupported image type ${a.mime} for asset ${a.id}`);
        const bytes = await assetBytes(deps, a);
        if (bytes.byteLength > MAX_IMAGE_BYTES) throw new PlatformError(PLATFORM, `image ${a.id} is larger than 5120 KB`);
        return { create: { name: fit(`${label} ${a.id}`, 128), type: "IMAGE", imageAsset: { data: Buffer.from(bytes).toString("base64") } } };
      }),
    );
    const r = await call<ServiceMutateResponse>("assets:mutate", { operations });
    const out = new Map<string, string>();
    unique.forEach((a, i) => {
      const rn = r?.results?.[i]?.resourceName;
      if (!rn) throw new PlatformError(PLATFORM, `asset upload returned no resource name for ${a.id}`);
      out.set(a.id, rn);
    });
    return out;
  }

  async function setCampaignStatus(campaign: string, status: "ENABLED" | "PAUSED"): Promise<void> {
    await call("campaigns:mutate", { operations: [{ update: { resourceName: campaign, status }, updateMask: "status" }] });
  }

  async function removeCampaign(campaign: string, budget?: string): Promise<void> {
    const mutateOperations: unknown[] = [{ campaignOperation: { remove: campaign } }];
    if (budget) mutateOperations.push({ campaignBudgetOperation: { remove: budget } });
    await call("googleAds:mutate", { mutateOperations });
  }

  /**
   * The create mutate is not idempotent: 429 is retried (rejected before
   * processing), but on 5xx / network errors the outcome is unknown, so we
   * look for what we may have created (by the unique budget name) and
   * remove it before rethrowing.
   */
  async function createAll(mutateOperations: unknown[], budgetName: string): Promise<MutateResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call<MutateResponse>("googleAds:mutate", { mutateOperations }, { retries: 1 });
      } catch (err) {
        if (!(err instanceof PlatformError)) throw err;
        if (err.status === 429 && attempt < 2) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        if (err.retryable && err.status !== 429) {
          try {
            const rows = await search<{ campaign?: { resourceName?: string }; campaignBudget?: { resourceName?: string } }>(
              `SELECT campaign.resource_name, campaign_budget.resource_name FROM campaign WHERE campaign_budget.name = ${gaqlString(budgetName)} AND campaign.status != 'REMOVED'`,
            );
            for (const row of rows) if (row.campaign?.resourceName) await removeCampaign(row.campaign.resourceName, row.campaignBudget?.resourceName);
          } catch {
            /* best effort: anything left is PAUSED and spends nothing */
          }
        }
        throw err;
      }
    }
  }

  async function launch(spec: LaunchSpec): Promise<Launched> {
    if (spec.creatives.length === 0) throw new PlatformError(PLATFORM, "no creatives");
    const images = spec.creatives.filter((c): c is AdCreativeInput & { asset: Asset } => c.asset?.kind === "image" && !!IMAGE_FIELD[c.asset.ratio]);
    const texts = spec.creatives.filter((c) => c.asset === null);
    const kind: "SEARCH" | "DEMAND_GEN" = images.length > 0 ? "DEMAND_GEN" : "SEARCH";
    const appName = spec.appName.trim();
    if (!appName) throw new PlatformError(PLATFORM, "appName is required");

    // Validate everything we can before any call that creates something.
    let keywords: string[] = [];
    let logo: Asset | undefined;
    if (kind === "SEARCH") {
      if (texts.length === 0) throw new PlatformError(PLATFORM, "no usable creatives (images or text-only)");
      if (texts.length > 3) throw new PlatformError(PLATFORM, "Search ad groups allow at most 3 responsive search ads");
      keywords = cleanKeywords(spec.targeting.keywords);
      if (keywords.length === 0) throw new PlatformError(PLATFORM, "Search campaigns need at least one keyword");
      for (const c of texts) {
        if (headlinesFor(c, appName, 30, 15).length < 3 || descriptionsFor(c, appName, 90, 4).length < 2) {
          throw new PlatformError(PLATFORM, `creative ${c.key}: not enough distinct headlines/descriptions`);
        }
      }
    } else {
      // Demand Gen multi-asset ads require a 1:1 logo. day2 has no logo for
      // identity "none", so use Identity.logo when given, else the first
      // square creative image.
      logo = spec.identity?.logo ?? images.find((c) => c.asset.ratio === "1:1")?.asset;
      if (!logo || logo.ratio !== "1:1") throw new PlatformError(PLATFORM, "Demand Gen ads need a square (1:1) logo: pass Identity.logo or a 1:1 image creative");
    }

    await assertUsd();
    const geos = await geoTargets(spec.targeting.countries);
    const langs = await languageConstants(spec.targeting.languages);

    const stamp = now().toISOString();
    const budgetName = `${spec.campaignName} budget ${stamp}`;
    const assetNames = kind === "DEMAND_GEN" ? await uploadImages([...images.map((c) => c.asset), logo!], `${spec.campaignName} ${stamp}`) : new Map<string, string>();

    const budgetTmp = `${customerPath}/campaignBudgets/-1`;
    const campaignTmp = `${customerPath}/campaigns/-2`;
    const adGroupTmp = `${customerPath}/adGroups/-3`;

    const ops: Array<Record<string, unknown>> = [
      {
        campaignBudgetOperation: {
          create: { resourceName: budgetTmp, name: budgetName, amountMicros: usdToMicros(spec.dailyBudgetUsd), deliveryMethod: "STANDARD", explicitlyShared: false },
        },
      },
      {
        campaignOperation: {
          create: {
            resourceName: campaignTmp,
            name: spec.campaignName,
            status: "PAUSED",
            advertisingChannelType: kind,
            campaignBudget: budgetTmp,
            // Maximize clicks (TargetSpend): suitable for traffic without conversion tracking.
            targetSpend: {},
            containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
            geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" },
            ...(kind === "SEARCH"
              ? { networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false, targetPartnerSearchNetwork: false } }
              : {}),
          },
        },
      },
    ];
    const targetingCriteria = [...geos.map((g) => ({ location: { geoTargetConstant: g } })), ...langs.map((l) => ({ language: { languageConstant: l } }))];
    if (kind === "SEARCH") for (const t of targetingCriteria) ops.push({ campaignCriterionOperation: { create: { campaign: campaignTmp, ...t } } });
    ops.push({
      adGroupOperation: {
        create: { resourceName: adGroupTmp, name: fit(`${spec.campaignName} ad group`, 255), campaign: campaignTmp, status: "ENABLED", ...(kind === "SEARCH" ? { type: "SEARCH_STANDARD" } : {}) },
      },
    });
    if (kind === "DEMAND_GEN") for (const t of targetingCriteria) ops.push({ adGroupCriterionOperation: { create: { adGroup: adGroupTmp, ...t } } });
    else for (const text of keywords) ops.push({ adGroupCriterionOperation: { create: { adGroup: adGroupTmp, status: "ENABLED", keyword: { text, matchType: "PHRASE" } } } });

    const adCreatives = kind === "SEARCH" ? texts : images;
    const firstAdOp = ops.length;
    for (const c of adCreatives) {
      let ad: Record<string, unknown>;
      if (kind === "SEARCH") {
        ad = {
          finalUrls: [spec.link],
          responsiveSearchAd: {
            headlines: headlinesFor(c, appName, 30, 15).map((text) => ({ text })),
            descriptions: descriptionsFor(c, appName, 90, 4).map((text) => ({ text })),
          },
        };
      } else {
        const a = c.asset!;
        ad = {
          name: fit(`${spec.campaignName} ${c.key}`, 255),
          finalUrls: [spec.link],
          demandGenMultiAssetAd: {
            [IMAGE_FIELD[a.ratio]!]: [{ asset: assetNames.get(a.id)! }],
            logoImages: [{ asset: assetNames.get(logo!.id)! }],
            headlines: headlinesFor(c, appName, 40, 5).map((text) => ({ text })),
            descriptions: descriptionsFor(c, appName, 90, 5).map((text) => ({ text })),
            businessName: fit(appName, 25),
          },
        };
      }
      ops.push({ adGroupAdOperation: { create: { adGroup: adGroupTmp, status: "ENABLED", ad } } });
    }

    const res = await createAll(ops, budgetName);
    const results = res?.mutateOperationResponses ?? [];
    const budget = results[0]?.campaignBudgetResult?.resourceName;
    const campaign = results[1]?.campaignResult?.resourceName;
    const adGroup = results.find((r) => r.adGroupResult)?.adGroupResult?.resourceName;
    if (!budget || !campaign || !adGroup) {
      if (campaign) await removeCampaign(campaign, budget).catch(() => {});
      throw new PlatformError(PLATFORM, "mutate response is missing created resource names");
    }
    const ads: Record<string, string> = {};
    adCreatives.forEach((c, i) => {
      const rn = results[firstAdOp + i]?.adGroupAdResult?.resourceName;
      if (rn) ads[c.key] = rn.split("~").pop() ?? rn;
    });

    try {
      if (Object.keys(ads).length !== adCreatives.length) throw new PlatformError(PLATFORM, "mutate response is missing ad resource names");
      await setCampaignStatus(campaign, "ENABLED");
    } catch (err) {
      await removeCampaign(campaign, budget).catch(() => {});
      if (err instanceof PlatformError) throw err;
      throw new PlatformError(PLATFORM, `enabling campaign failed: ${(err as Error).message}`);
    }

    return { platform: PLATFORM, campaignId: idOf(campaign), refs: { customerId: cid, budget, campaign, adGroup, channel: kind }, ads };
  }

  function refs(c: Launched): { campaign: string; budget: string } {
    const campaign = c.refs.campaign ?? `${customerPath}/campaigns/${c.campaignId}`;
    const budget = c.refs.budget;
    if (!budget) throw new PlatformError(PLATFORM, `campaign ${c.campaignId} has no budget ref`);
    return { campaign, budget };
  }

  const num = (v: string | number | undefined) => (v === undefined ? 0 : Number(v) || 0);

  function adStatus(a: NonNullable<AdRow["adGroupAd"]>): CampaignStatus {
    if (a.status === "REMOVED") return "ended";
    if (a.policySummary?.approvalStatus === "DISAPPROVED") return "rejected";
    if (a.status === "PAUSED") return "paused";
    if (a.policySummary?.reviewStatus === "REVIEW_IN_PROGRESS" && !String(a.policySummary.approvalStatus ?? "").startsWith("APPROVED")) return "in_review";
    if (a.status === "ENABLED") return "active";
    return "unknown";
  }

  async function stats(c: Launched): Promise<AdStats> {
    const { campaign } = refs(c);
    const [campRows, adRows] = [
      await search<CampaignRow>(
        `SELECT campaign.resource_name, campaign.status, campaign.primary_status, campaign.serving_status, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE campaign.resource_name = ${gaqlString(campaign)}`,
      ),
      await search<AdRow>(
        `SELECT ad_group_ad.resource_name, ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status, ad_group_ad.policy_summary.policy_topic_entries, metrics.cost_micros, metrics.impressions, metrics.clicks FROM ad_group_ad WHERE campaign.resource_name = ${gaqlString(campaign)}`,
      ),
    ];
    const row = campRows[0];
    if (!row?.campaign) throw new PlatformError(PLATFORM, `campaign ${c.campaignId} not found`, 404);

    const keyByAd = new Map(Object.entries(c.ads).map(([k, id]) => [id, k]));
    const byCreative: NonNullable<AdStats["byCreative"]> = {};
    const statuses: CampaignStatus[] = [];
    const reasons: string[] = [];
    for (const r of adRows) {
      const a = r.adGroupAd;
      if (!a) continue;
      const st = adStatus(a);
      if (a.status !== "REMOVED") statuses.push(st);
      if (st === "rejected") {
        const topics = (a.policySummary?.policyTopicEntries ?? []).filter((t) => t.type === "PROHIBITED" || t.type === "FULLY_LIMITED" || !t.type).map((t) => t.topic ?? "");
        reasons.push(...(topics.filter(Boolean).length ? topics.filter(Boolean) : ["policy violation"]));
      }
      const key = a.ad?.id ? keyByAd.get(a.ad.id) : undefined;
      if (key) byCreative[key] = { spendUsd: num(r.metrics?.costMicros) / 1e6, impressions: num(r.metrics?.impressions), clicks: num(r.metrics?.clicks), status: st };
    }

    const cs = row.campaign;
    let status: CampaignStatus;
    if (cs.status === "REMOVED" || cs.primaryStatus === "ENDED" || cs.servingStatus === "ENDED") status = "ended";
    else if (cs.status === "PAUSED") status = "paused";
    else if (statuses.length > 0 && statuses.every((s) => s === "rejected")) status = "rejected";
    else if (statuses.includes("active")) status = "active";
    else if (statuses.includes("in_review") || cs.primaryStatus === "PENDING") status = "in_review";
    else if (cs.status === "ENABLED") status = "active";
    else status = "unknown";

    const out: AdStats = {
      spendUsd: num(row.metrics?.costMicros) / 1e6,
      impressions: num(row.metrics?.impressions),
      clicks: num(row.metrics?.clicks),
      status,
      byCreative,
    };
    if (reasons.length) out.rejection = `Ad disapproved: ${[...new Set(reasons)].join(", ")}`;
    return out;
  }

  return {
    id: PLATFORM,
    launch,
    stats,
    pause: (c) => setCampaignStatus(refs(c).campaign, "PAUSED"),
    resume: (c) => setCampaignStatus(refs(c).campaign, "ENABLED"),
    async setDailyBudget(c, usd) {
      const { budget } = refs(c);
      const amountMicros = usdToMicros(usd);
      await assertUsd();
      await call("campaignBudgets:mutate", { operations: [{ update: { resourceName: budget, amountMicros }, updateMask: "amountMicros" }] });
    },
  };
}
