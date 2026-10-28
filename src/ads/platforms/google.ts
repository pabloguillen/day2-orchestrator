import { assetBytes, fit, redact, request, tokenCache, type RequestInit2 } from "../http";
import {
  PlatformError,
  type AdAccountInfo,
  type AdCreativeInput,
  type AdPlatform,
  type AdStats,
  type Asset,
  type CallToAction,
  type CampaignStatus,
  type Conversion,
  type ConversionSetup,
  type LaunchSpec,
  type Launched,
  type PlatformDeps,
  type PlatformInfo,
} from "../types";

/**
 * Google Ads API (REST interface), written against v26 (released 2026-10-14).
 *
 * - Text-only creatives (asset null) launch as a Search campaign with one
 *   responsive search ad per creative and phrase-match keywords. Location
 *   is a campaign criterion; manual language targeting is no longer
 *   accepted on Search campaigns (Sept 2026), so languages are ignored there.
 * - Image creatives launch as a Demand Gen campaign with one
 *   DemandGenMultiAssetAd per image. Images are uploaded via AssetService
 *   first; location/language are ad-group criteria (Demand Gen campaigns
 *   with upgraded targeting reject campaign-level location criteria).
 * - Everything below the campaign is created in ONE atomic
 *   GoogleAdsService.Mutate with temporary (negative) resource names, with
 *   the campaign PAUSED; it's enabled only afterwards. If anything after the
 *   create fails, the campaign and its budget are removed.
 * - optimizeFor "clicks": Maximize clicks (TargetSpend). "signups": Maximize
 *   conversions, with a campaign-level custom conversion goal holding only
 *   day2's sign-up conversion action (from ensureConversions).
 * - Budgets/spend are in the account's currency (micros).
 * - Conversions: Data Manager API events:ingest first (needs the datamanager
 *   OAuth scope and the API enabled in the Cloud project); on 401/403 it
 *   falls back to Google Ads uploadClickConversions, which only works for
 *   projects allowlisted before 2026-06-15 (remembered per process when not).
 * - Videos need YouTube uploads and are out of scope.
 */

const PLATFORM = "google" as const;
const DEFAULT_VERSION = "v26";
const BASE = "https://googleads.googleapis.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif"];
const MAX_IMAGE_BYTES = 5_120 * 1024;

/** day2's conversion actions / custom goal in each account (found by these names). */
export const CONVERSION_NAMES = { signup: "day2 sign-up", activated: "day2 activation", goal: "day2 sign-up goal" } as const;
const CLICK_PARAMS = ["gclid", "gbraid", "wbraid"] as const;
const UPLOAD_BATCH = 2000;

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
  // Demand Gen enforces 5 USD/day (or equivalent); 10 is a practical floor for learning.
  minDailyUsd: 10,
  clickIdParam: "gclid",
  identity: "none",
  audiences: ["consumer", "business"],
  env: [
    "GOOGLE_ADS_CLIENT_ID",
    "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_REFRESH_TOKEN",
    "GOOGLE_ADS_CUSTOMER_ID",
    "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
    "GOOGLE_ADS_DEVELOPER_TOKEN",
    "GOOGLE_ADS_API_VERSION",
  ],
  apiVersion: DEFAULT_VERSION,
};

export type GoogleCreds = {
  /**
   * Optional: developer tokens were sunset on 2026-09-09 (access now belongs
   * to the OAuth client's Google Cloud project); sent only when set.
   */
  developerToken?: string;
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
  const clientId = env.GOOGLE_ADS_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_ADS_CLIENT_SECRET?.trim();
  const refreshToken = env.GOOGLE_ADS_REFRESH_TOKEN?.trim();
  const customerId = env.GOOGLE_ADS_CUSTOMER_ID ? digits(env.GOOGLE_ADS_CUSTOMER_ID) : "";
  if (!clientId || !clientSecret || !refreshToken || !/^\d{10}$/.test(customerId)) return null;
  const login = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? digits(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) : "";
  if (login && !/^\d{10}$/.test(login)) return null;
  const version = env.GOOGLE_ADS_API_VERSION?.trim() || DEFAULT_VERSION;
  if (!/^v\d+$/.test(version)) return null;
  return {
    developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim() || undefined,
    clientId,
    clientSecret,
    refreshToken,
    customerId,
    loginCustomerId: login || undefined,
    apiVersion: version,
  };
}

// ---------------------------------------------------------------------------

type MutateResponse = { mutateOperationResponses?: Array<Record<string, { resourceName?: string } | undefined>> };
type ServiceMutateResponse = { results?: Array<{ resourceName?: string }> };
type SearchResponse<T> = { results?: T[]; nextPageToken?: string };

type PolicyTopicEntry = { topic?: string; type?: string };
type Metrics = { costMicros?: string | number; impressions?: string | number; clicks?: string | number };
type CampaignRow = {
  campaign?: { resourceName?: string; status?: string; primaryStatus?: string; servingStatus?: string };
  customer?: { currencyCode?: string };
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
type CustomerRow = { customer?: { id?: string; descriptiveName?: string; currencyCode?: string; status?: string; manager?: boolean; testAccount?: boolean } };

/** A GoogleAdsFailure error inside an HTTP error or partialFailureError. */
type AdsError = { errorCode?: Record<string, string>; message?: string; location?: { fieldPathElements?: Array<{ fieldName?: string; index?: number }> } };
type UploadResponse = {
  partialFailureError?: { code?: number; message?: string; details?: Array<{ errors?: AdsError[] }> };
  results?: unknown[];
};

const CTA_TEXT: Record<CallToAction, string> = {
  learn_more: "Learn More",
  sign_up: "Sign Up",
  download: "Download Now",
  get_started: "Get Started",
};

/** Number of minor-unit digits of an ISO 4217 currency (USD 2, JPY 0, …). */
export function currencyDigits(currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency)) throw new PlatformError(PLATFORM, `invalid currency: ${currency}`);
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    throw new PlatformError(PLATFORM, `unknown currency: ${currency}`);
  }
}

/** Amount → micros, rounded to the currency's minimum unit (budgets must be a multiple of it). */
export function toMicros(amount: number, currency: string): string {
  if (!Number.isFinite(amount) || amount <= 0) throw new PlatformError(PLATFORM, `invalid daily budget: ${amount}`);
  const d = Math.min(currencyDigits(currency), 6);
  const units = Math.round(amount * 10 ** d);
  if (units <= 0) throw new PlatformError(PLATFORM, `daily budget ${amount} ${currency} rounds to zero`);
  return String(units * 10 ** (6 - d));
}

/** ISO timestamp → "yyyy-mm-dd hh:mm:ss+00:00" (UTC), as ClickConversion.conversion_date_time wants. */
export function conversionDateTime(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid timestamp: ${at}`);
  return `${d.toISOString().slice(0, 19).replace("T", " ")}+00:00`;
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

const errorCodeText = (e: AdsError) =>
  Object.values(e.errorCode ?? {})
    .filter(Boolean)
    .join(",");

// --- conversions transport helpers -----------------------------------------

const DATA_MANAGER_INGEST = "https://datamanager.googleapis.com/v1/events:ingest";

/** OAuth clients (≈ Cloud projects) found not allowlisted for uploadClickConversions, per process. */
const legacyNotAllowlisted = new Set<string>();
/** For tests. */
export function resetConversionRouteMemory(): void {
  legacyNotAllowlisted.clear();
}

class DataManagerUnavailable extends Error {
  constructor(
    public status: number,
    public reason: string,
  ) {
    super(`Data Manager API unavailable (${status} ${reason})`);
  }
}
class LegacyNotAllowlisted extends Error {}

const noRoute = (dmProblem: string) =>
  new PlatformError(
    PLATFORM,
    `no conversion route: the Data Manager API refused (${dmProblem}) and this project is not allowlisted for Google Ads API uploadClickConversions (closed to new adopters since 2026-06-15). Enable the Data Manager API in the Google Cloud project and reconnect Google Ads granting the datamanager scope.`,
    403,
  );

/**
 * Consent is only sent when the source event carries it. day2's Conversion
 * has no consent today, so nothing is claimed; Google treats missing
 * consent for EEA users as not consented.
 */
function eventConsent(e: Conversion): Row0["consent"] {
  const c = (e as Conversion & { consent?: { adUserData?: unknown; adPersonalization?: unknown } }).consent;
  if (!c) return undefined;
  const out: NonNullable<Row0["consent"]> = {};
  if (typeof c.adUserData === "boolean") out.adUserData = c.adUserData;
  if (typeof c.adPersonalization === "boolean") out.adPersonalization = c.adPersonalization;
  return Object.keys(out).length ? out : undefined;
}
type Row0 = { consent?: { adUserData?: boolean; adPersonalization?: boolean } };
function consentFor(r: Row0, granted: string, denied: string): Record<string, string> | undefined {
  if (!r.consent) return undefined;
  const out: Record<string, string> = {};
  if (r.consent.adUserData !== undefined) out.adUserData = r.consent.adUserData ? granted : denied;
  if (r.consent.adPersonalization !== undefined) out.adPersonalization = r.consent.adPersonalization ? granted : denied;
  return Object.keys(out).length ? out : undefined;
}

type RpcError = { message?: string; status?: string; reason?: string; violations: Array<{ field?: string; description?: string }> };
function parseRpcError(text: string): RpcError {
  try {
    const e = (JSON.parse(text) as { error?: { message?: string; status?: string; details?: Array<Record<string, unknown>> } }).error ?? {};
    const out: RpcError = { message: e.message, status: e.status, violations: [] };
    for (const d of e.details ?? []) {
      if (typeof d.reason === "string") out.reason ??= d.reason;
      const fv = d.fieldViolations;
      if (Array.isArray(fv)) out.violations.push(...(fv as RpcError["violations"]));
    }
    return out;
  } catch {
    return { violations: [] };
  }
}
const redactShort = (s: string) => redact(s).slice(0, 300);

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
    const h: Record<string, string> = { authorization: `Bearer ${await token()}` };
    if (creds.developerToken) h["developer-token"] = creds.developerToken;
    if (creds.loginCustomerId) h["login-customer-id"] = creds.loginCustomerId;
    return h;
  }

  /** Quota errors that didn't come back as HTTP 429 are retryable too; explain allowlist errors. */
  function normalize(err: unknown): never {
    if (err instanceof PlatformError && !err.retryable && /RESOURCE_EXHAUSTED|RESOURCE_TEMPORARILY_EXHAUSTED/.test(err.message)) {
      throw new PlatformError(PLATFORM, err.message.replace(/^google: /, ""), err.status, true);
    }
    throw err;
  }

  /** POST to `${api}${suffix}` (suffix like "/googleAds:search" or ":uploadClickConversions"). */
  async function call<T>(suffix: string, json: unknown, opts: Pick<RequestInit2, "retries"> = {}): Promise<T> {
    try {
      return await request<T>(PLATFORM, deps, `${api}${suffix}`, { method: "POST", headers: await headers(), json, ...opts });
    } catch (err) {
      normalize(err);
    }
  }
  const mutate = <T>(service: string, json: unknown) => call<T>(`/${service}:mutate`, json);

  async function search<T>(query: string): Promise<T[]> {
    const rows: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await call<SearchResponse<T>>("/googleAds:search", pageToken ? { query, pageToken } : { query });
      rows.push(...(r?.results ?? []));
      pageToken = r?.nextPageToken;
      if (!pageToken) break;
    }
    return rows;
  }

  let customerCache: NonNullable<CustomerRow["customer"]> | null = null;
  async function customer(): Promise<NonNullable<CustomerRow["customer"]>> {
    if (customerCache) return customerCache;
    const rows = await search<CustomerRow>(
      "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.status, customer.manager, customer.test_account FROM customer",
    );
    const c = rows[0]?.customer;
    if (!c?.currencyCode) throw new PlatformError(PLATFORM, `account ${cid} returned no currency`);
    customerCache = c;
    return c;
  }
  async function accountCurrency(): Promise<string> {
    return (await customer()).currencyCode!;
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
    const r = await mutate<ServiceMutateResponse>("assets", { operations });
    const out = new Map<string, string>();
    unique.forEach((a, i) => {
      const rn = r?.results?.[i]?.resourceName;
      if (!rn) throw new PlatformError(PLATFORM, `asset upload returned no resource name for ${a.id}`);
      out.set(a.id, rn);
    });
    return out;
  }

  async function setCampaignStatus(campaign: string, status: "ENABLED" | "PAUSED"): Promise<void> {
    await mutate("campaigns", { operations: [{ update: { resourceName: campaign, status }, updateMask: "status" }] });
  }

  async function removeCampaign(campaign: string, budget?: string): Promise<void> {
    const mutateOperations: unknown[] = [{ campaignOperation: { remove: campaign } }];
    if (budget) mutateOperations.push({ campaignBudgetOperation: { remove: budget } });
    await call("/googleAds:mutate", { mutateOperations });
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
        return await call<MutateResponse>("/googleAds:mutate", { mutateOperations }, { retries: 1 });
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

  /** Points a (paused) campaign's bidding at day2's custom sign-up goal only. */
  async function useSignupGoal(campaign: string, goal: string): Promise<void> {
    const rows = await search<{ campaignConversionGoal?: { resourceName?: string; biddable?: boolean } }>(
      `SELECT campaign_conversion_goal.resource_name, campaign_conversion_goal.biddable FROM campaign_conversion_goal WHERE campaign.resource_name = ${gaqlString(campaign)}`,
    );
    const mutateOperations: unknown[] = [
      {
        conversionGoalCampaignConfigOperation: {
          update: { resourceName: `${customerPath}/conversionGoalCampaignConfigs/${idOf(campaign)}`, customConversionGoal: goal },
          updateMask: "customConversionGoal",
        },
      },
    ];
    for (const r of rows) {
      const rn = r.campaignConversionGoal?.resourceName;
      if (rn && r.campaignConversionGoal?.biddable !== false) mutateOperations.push({ campaignConversionGoalOperation: { update: { resourceName: rn, biddable: false }, updateMask: "biddable" } });
    }
    await call("/googleAds:mutate", { mutateOperations });
  }

  async function launch(spec: LaunchSpec): Promise<Launched> {
    if (spec.creatives.length === 0) throw new PlatformError(PLATFORM, "no creatives");
    const images = spec.creatives.filter((c): c is AdCreativeInput & { asset: Asset } => c.asset?.kind === "image" && !!IMAGE_FIELD[c.asset.ratio]);
    const texts = spec.creatives.filter((c) => c.asset === null);
    const kind: "SEARCH" | "DEMAND_GEN" = images.length > 0 ? "DEMAND_GEN" : "SEARCH";
    const appName = spec.appName.trim();
    if (!appName) throw new PlatformError(PLATFORM, "appName is required");

    // Validate everything we can before any call that creates something.
    const budgetMicros = toMicros(spec.dailyBudget, spec.currency);
    const signupGoal = spec.optimizeFor === "signups" ? spec.conversion?.refs.goal : undefined;
    if (spec.optimizeFor === "signups" && !signupGoal) throw new PlatformError(PLATFORM, "optimizeFor signups needs LaunchSpec.conversion from ensureConversions()");
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

    const currency = await accountCurrency();
    if (currency !== spec.currency) throw new PlatformError(PLATFORM, `account ${cid} bills in ${currency}, but the budget is in ${spec.currency}`);
    const geos = await geoTargets(spec.targeting.countries);
    const langs = kind === "DEMAND_GEN" ? await languageConstants(spec.targeting.languages) : [];

    const stamp = now().toISOString();
    const budgetName = `${spec.campaignName} budget ${stamp}`;
    const assetNames = kind === "DEMAND_GEN" ? await uploadImages([...images.map((c) => c.asset), logo!], `${spec.campaignName} ${stamp}`) : new Map<string, string>();

    const budgetTmp = `${customerPath}/campaignBudgets/-1`;
    const campaignTmp = `${customerPath}/campaigns/-2`;
    const adGroupTmp = `${customerPath}/adGroups/-3`;

    const ops: Array<Record<string, unknown>> = [
      {
        campaignBudgetOperation: {
          create: { resourceName: budgetTmp, name: budgetName, amountMicros: budgetMicros, deliveryMethod: "STANDARD", explicitlyShared: false },
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
            // Clicks: Maximize clicks (TargetSpend). Sign-ups: Maximize conversions (goal set below).
            ...(signupGoal ? { maximizeConversions: {} } : { targetSpend: {} }),
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
      const finalUrls = [c.link ?? spec.link];
      let ad: Record<string, unknown>;
      if (kind === "SEARCH") {
        ad = {
          finalUrls,
          responsiveSearchAd: {
            headlines: headlinesFor(c, appName, 30, 15).map((text) => ({ text })),
            descriptions: descriptionsFor(c, appName, 90, 4).map((text) => ({ text })),
          },
        };
      } else {
        const a = c.asset!;
        ad = {
          name: fit(`${spec.campaignName} ${c.key}`, 255),
          finalUrls,
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
      if (signupGoal) await useSignupGoal(campaign, signupGoal);
      await setCampaignStatus(campaign, "ENABLED");
    } catch (err) {
      await removeCampaign(campaign, budget).catch(() => {});
      if (err instanceof PlatformError) throw err;
      throw new PlatformError(PLATFORM, `finishing campaign failed: ${(err as Error).message}`);
    }

    return {
      platform: PLATFORM,
      campaignId: idOf(campaign),
      refs: { customerId: cid, budget, campaign, adGroup, channel: kind, optimizeFor: signupGoal ? "signups" : "clicks" },
      ads,
    };
  }

  function refs(c: Launched): { campaign: string; budget: string; adGroup?: string } {
    const campaign = c.refs.campaign ?? `${customerPath}/campaigns/${c.campaignId}`;
    const budget = c.refs.budget;
    if (!budget) throw new PlatformError(PLATFORM, `campaign ${c.campaignId} has no budget ref`);
    return { campaign, budget, adGroup: c.refs.adGroup };
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
    const campRows = await search<CampaignRow>(
      `SELECT campaign.resource_name, campaign.status, campaign.primary_status, campaign.serving_status, customer.currency_code, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE campaign.resource_name = ${gaqlString(campaign)}`,
    );
    const adRows = await search<AdRow>(
      `SELECT ad_group_ad.resource_name, ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status, ad_group_ad.policy_summary.policy_topic_entries, metrics.cost_micros, metrics.impressions, metrics.clicks FROM ad_group_ad WHERE campaign.resource_name = ${gaqlString(campaign)}`,
    );
    const row = campRows[0];
    if (!row?.campaign) throw new PlatformError(PLATFORM, `campaign ${c.campaignId} not found`, 404);
    const currency = row.customer?.currencyCode;
    if (!currency) throw new PlatformError(PLATFORM, `campaign ${c.campaignId}: no account currency in report`);

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
      if (key) byCreative[key] = { spend: num(r.metrics?.costMicros) / 1e6, impressions: num(r.metrics?.impressions), clicks: num(r.metrics?.clicks), status: st };
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
      spend: num(row.metrics?.costMicros) / 1e6,
      currency,
      impressions: num(row.metrics?.impressions),
      clicks: num(row.metrics?.clicks),
      status,
      byCreative,
    };
    if (reasons.length) out.rejection = `Ad disapproved: ${[...new Set(reasons)].join(", ")}`;
    return out;
  }

  async function setAdActive(c: Launched, key: string, active: boolean): Promise<void> {
    const adId = c.ads[key];
    if (!adId) throw new PlatformError(PLATFORM, `campaign ${c.campaignId} has no ad for creative ${key}`);
    const { adGroup } = refs(c);
    if (!adGroup) throw new PlatformError(PLATFORM, `campaign ${c.campaignId} has no ad group ref`);
    await mutate("adGroupAds", {
      operations: [{ update: { resourceName: `${customerPath}/adGroupAds/${idOf(adGroup)}~${adId}`, status: active ? "ENABLED" : "PAUSED" }, updateMask: "status" }],
    });
  }

  async function accountInfo(): Promise<AdAccountInfo> {
    customerCache = null;
    const c = await customer();
    const out: AdAccountInfo = { id: cid, name: c.descriptiveName || cid, currency: c.currencyCode!, canSpend: true };
    const fail = (problem: string): AdAccountInfo => ({ ...out, canSpend: false, problem });
    if (c.manager) return fail("this is a manager (MCC) account; ads must run in one of its client accounts");
    if (c.status && c.status !== "ENABLED") return fail(`account status is ${c.status}`);
    if (c.testAccount) return fail("this is a test account; it never serves ads or spends");
    try {
      const billing = await search<{ billingSetup?: { status?: string } }>("SELECT billing_setup.status FROM billing_setup");
      if (!billing.some((b) => b.billingSetup?.status === "APPROVED")) return fail("no approved billing setup (add a payment method in Google Ads → Billing)");
    } catch (err) {
      // Some users may not read billing; the account status is still authoritative.
      if (err instanceof PlatformError && err.retryable) throw err;
    }
    return out;
  }

  async function ensureConversions(): Promise<ConversionSetup> {
    const names = [CONVERSION_NAMES.signup, CONVERSION_NAMES.activated];
    const rows = await search<{ conversionAction?: { resourceName?: string; name?: string; type?: string; status?: string } }>(
      `SELECT conversion_action.resource_name, conversion_action.name, conversion_action.type, conversion_action.status FROM conversion_action WHERE conversion_action.name IN (${names.map(gaqlString).join(", ")}) AND conversion_action.status != 'REMOVED'`,
    );
    const found = new Map<string, string>();
    for (const r of rows) {
      const a = r.conversionAction;
      if (!a?.resourceName || !a.name) continue;
      if (a.type !== "UPLOAD_CLICKS") throw new PlatformError(PLATFORM, `conversion action "${a.name}" exists with type ${a.type}, expected UPLOAD_CLICKS; rename or remove it`);
      found.set(a.name, a.resourceName);
    }
    const spec = (name: string, signup: boolean) => ({
      name,
      type: "UPLOAD_CLICKS",
      category: signup ? "SIGNUP" : "DEFAULT",
      status: "ENABLED",
      // Only sign-ups count toward bidding; activations are reported (secondary).
      primaryForGoal: signup,
      countingType: "ONE_PER_CLICK",
      clickThroughLookbackWindowDays: 30,
      valueSettings: { defaultValue: 1, alwaysUseDefaultValue: true },
    });
    const missing = names.filter((n) => !found.has(n));
    if (missing.length) {
      const r = await mutate<ServiceMutateResponse>("conversionActions", { operations: missing.map((n) => ({ create: spec(n, n === CONVERSION_NAMES.signup) })) });
      missing.forEach((n, i) => {
        const rn = r?.results?.[i]?.resourceName;
        if (!rn) throw new PlatformError(PLATFORM, `creating conversion action "${n}" returned no resource name`);
        found.set(n, rn);
      });
    }
    const signup = found.get(CONVERSION_NAMES.signup)!;
    const activated = found.get(CONVERSION_NAMES.activated)!;

    const goals = await search<{ customConversionGoal?: { resourceName?: string; conversionActions?: string[]; status?: string } }>(
      `SELECT custom_conversion_goal.resource_name, custom_conversion_goal.conversion_actions, custom_conversion_goal.status FROM custom_conversion_goal WHERE custom_conversion_goal.name = ${gaqlString(CONVERSION_NAMES.goal)} AND custom_conversion_goal.status != 'REMOVED'`,
    );
    let goal = goals[0]?.customConversionGoal?.resourceName;
    if (!goal) {
      const r = await mutate<ServiceMutateResponse>("customConversionGoals", {
        operations: [{ create: { name: CONVERSION_NAMES.goal, conversionActions: [signup], status: "ENABLED" } }],
      });
      goal = r?.results?.[0]?.resourceName;
      if (!goal) throw new PlatformError(PLATFORM, "creating the custom conversion goal returned no resource name");
    } else {
      const g = goals[0]!.customConversionGoal!;
      if (g.status !== "ENABLED" || g.conversionActions?.length !== 1 || g.conversionActions[0] !== signup) {
        await mutate("customConversionGoals", {
          operations: [{ update: { resourceName: goal, conversionActions: [signup], status: "ENABLED" }, updateMask: "conversionActions,status" }],
        });
      }
    }
    return { platform: PLATFORM, refs: { customerId: cid, signup, activated, goal } };
  }

  type Row = { eventId: string; action: string; param: (typeof CLICK_PARAMS)[number]; value: string; at: Date; consent?: { adUserData?: boolean; adPersonalization?: boolean } };
  type Result = { sent: number; rejected: Array<{ eventId: string; why: string }> };

  /**
   * Primary route: Data Manager API events:ingest (one request per
   * conversion action, ≤2000 events). Fast-fail validation errors that name
   * an event (events[N]) reject that event and the rest are resent once.
   */
  async function ingestDataManager(action: string, batch: Row[]): Promise<Result> {
    const destination: Record<string, unknown> = {
      operatingAccount: { accountType: "GOOGLE_ADS", accountId: cid },
      loginAccount: { accountType: "GOOGLE_ADS", accountId: creds.loginCustomerId ?? cid },
      productDestinationId: idOf(action),
    };
    const rejected: Result["rejected"] = [];
    let pending = batch;
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      const res = await request<Response>(PLATFORM, deps, DATA_MANAGER_INGEST, {
        method: "POST",
        headers: { authorization: `Bearer ${await token()}` },
        json: {
          destinations: [destination],
          events: pending.map((r) => {
            const consent = consentFor(r, "CONSENT_GRANTED", "CONSENT_DENIED");
            return {
              transactionId: r.eventId,
              eventTimestamp: r.at.toISOString(),
              eventSource: "WEB",
              adIdentifiers: { [r.param]: r.value },
              ...(consent ? { consent } : {}),
            };
          }),
        },
        rawResponse: true,
      });
      if (res.ok) return { sent: pending.length, rejected };
      const text = await res.text().catch(() => "");
      const err = parseRpcError(text);
      if (res.status === 401 || res.status === 403) throw new DataManagerUnavailable(res.status, err.reason ?? err.status ?? String(res.status));
      if (res.status !== 400 || attempt > 0) throw new PlatformError(PLATFORM, `Data Manager ${res.status} ${redactShort(err.message ?? text)}`, res.status);
      const bad = new Map<number, string>();
      for (const v of err.violations) {
        const m = /^events\[(\d+)\]/.exec(v.field ?? "");
        if (m) bad.set(Number(m[1]), [bad.get(Number(m[1])), `${v.field}: ${v.description ?? "invalid"}`].filter(Boolean).join("; "));
      }
      if (bad.size === 0) throw new PlatformError(PLATFORM, `Data Manager 400 ${redactShort(err.message ?? text)}`, 400);
      pending.forEach((r, i) => bad.has(i) && rejected.push({ eventId: r.eventId, why: bad.get(i)! }));
      pending = pending.filter((_, i) => !bad.has(i));
    }
    return { sent: 0, rejected };
  }

  /** Fallback: Google Ads API uploadClickConversions (only for allowlisted projects). */
  async function uploadLegacy(batch: Row[]): Promise<Result> {
    const rejected: Result["rejected"] = [];
    let r: UploadResponse;
    try {
      r = await call<UploadResponse>(":uploadClickConversions", {
        conversions: batch.map((b) => {
          const consent = consentFor(b, "GRANTED", "DENIED");
          return {
            conversionAction: b.action,
            conversionDateTime: conversionDateTime(b.at.toISOString()),
            [b.param]: b.value,
            orderId: b.eventId,
            ...(consent ? { consent } : {}),
          };
        }),
        partialFailure: true,
      });
    } catch (err) {
      if (err instanceof PlatformError && /CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE/.test(err.message)) {
        legacyNotAllowlisted.add(creds.clientId);
        throw new LegacyNotAllowlisted();
      }
      throw err;
    }
    const failed = new Map<number, string[]>();
    for (const d of r?.partialFailureError?.details ?? []) {
      for (const e of d.errors ?? []) {
        const idx = e.location?.fieldPathElements?.find((p) => p.fieldName === "conversions")?.index;
        if (idx === undefined) continue;
        const why = [errorCodeText(e), e.message].filter(Boolean).join(": ");
        failed.set(idx, [...(failed.get(idx) ?? []), why]);
      }
    }
    if (r?.partialFailureError && failed.size === 0) {
      // A partial failure we can't attribute: count nothing as sent rather than guess.
      return { sent: 0, rejected: batch.map((b) => ({ eventId: b.eventId, why: r.partialFailureError?.message ?? "upload failed" })) };
    }
    let sent = 0;
    batch.forEach((b, idx) => {
      const whys = failed.get(idx);
      // Already-uploaded conversions (same order id / click+time) are deduplicated, not lost.
      if (!whys || whys.every((w) => /ALREADY_EXISTS|DUPLICATE|ORDER_ID_ALREADY_IN_USE/.test(w))) sent++;
      else rejected.push({ eventId: b.eventId, why: whys.join("; ") });
    });
    return { sent, rejected };
  }

  async function sendConversions(setup: ConversionSetup, events: Conversion[]): Promise<Result> {
    const out: Result = { sent: 0, rejected: [] };
    const rows: Row[] = [];
    for (const e of events) {
      const action = e.name === "signup" ? setup.refs.signup : setup.refs.activated;
      const param = e.click?.param?.toLowerCase() as Row["param"];
      const at = new Date(e.at);
      if (!action) out.rejected.push({ eventId: e.eventId, why: `no conversion action for ${e.name}; run ensureConversions` });
      else if (!e.click?.value || !CLICK_PARAMS.includes(param)) out.rejected.push({ eventId: e.eventId, why: `not a Google click id (${e.click?.param ?? "none"})` });
      else if (Number.isNaN(at.getTime())) out.rejected.push({ eventId: e.eventId, why: `invalid time ${e.at}` });
      else rows.push({ eventId: e.eventId, action, param, value: e.click.value, at, consent: eventConsent(e) });
    }
    const byAction = new Map<string, Row[]>();
    for (const r of rows) byAction.set(r.action, [...(byAction.get(r.action) ?? []), r]);

    let useLegacy = false;
    let dmProblem = "";
    for (const [action, list] of byAction) {
      for (let i = 0; i < list.length; i += UPLOAD_BATCH) {
        const batch = list.slice(i, i + UPLOAD_BATCH);
        let res: Result;
        if (!useLegacy) {
          try {
            res = await ingestDataManager(action, batch);
            out.sent += res.sent;
            out.rejected.push(...res.rejected);
            continue;
          } catch (err) {
            if (!(err instanceof DataManagerUnavailable)) throw err;
            dmProblem = err.reason;
            useLegacy = true;
          }
        }
        if (legacyNotAllowlisted.has(creds.clientId)) throw noRoute(dmProblem);
        try {
          res = await uploadLegacy(batch);
        } catch (err) {
          if (err instanceof LegacyNotAllowlisted) throw noRoute(dmProblem);
          throw err;
        }
        out.sent += res.sent;
        out.rejected.push(...res.rejected);
      }
    }
    return out;
  }

  return {
    id: PLATFORM,
    launch,
    stats,
    pause: (c) => setCampaignStatus(refs(c).campaign, "PAUSED"),
    resume: (c) => setCampaignStatus(refs(c).campaign, "ENABLED"),
    async setDailyBudget(c, amount) {
      const { budget } = refs(c);
      if (!Number.isFinite(amount) || amount <= 0) throw new PlatformError(PLATFORM, `invalid daily budget: ${amount}`);
      const amountMicros = toMicros(amount, await accountCurrency());
      await mutate("campaignBudgets", { operations: [{ update: { resourceName: budget, amountMicros }, updateMask: "amountMicros" }] });
    },
    setAdActive,
    accountInfo,
    ensureConversions,
    sendConversions,
  };
}
