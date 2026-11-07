/**
 * The contract between day2's ad autopilot and each ad platform.
 *
 * day2 runs ads from its own ad account on each platform (the spend is
 * billed to the customer's credits). Each platform module in
 * ./platforms/<id>.ts exports:
 *
 *   export const info: PlatformInfo;
 *   export function credentialsFromEnv(env: Record<string, string | undefined>): <Creds> | null;
 *   export function create(creds: <Creds>, deps?: PlatformDeps): AdPlatform;
 *
 * and talks to the platform's official REST API directly — deterministic
 * calls, no agent in the loop where money moves.
 */

export type PlatformId = "meta" | "tiktok" | "linkedin" | "google" | "snapchat" | "pinterest" | "reddit" | "x";

export type Ratio = "9:16" | "1:1" | "4:5" | "16:9" | "1.91:1" | "2:3";

/** What a platform accepts for one placement. */
export type AssetSpec = {
  kind: "image" | "video";
  ratio: Ratio;
  width: number;
  height: number;
  minDurationSec?: number;
  maxDurationSec?: number;
  maxBytes: number;
  mimes: string[];
};

export type AssetSource = "screenshot" | "template" | "screen_recording" | "creatify" | "runway" | "upload" | "motion_template" | "heygen" | "luma" | "gemini_video" | "elevenlabs" | "openai_images";

/** A finished image or video, stored and served by day2. */
export type Asset = {
  id: string;
  kind: "image" | "video";
  ratio: Ratio;
  width: number;
  height: number;
  durationSec?: number;
  mime: string;
  bytes: number;
  /** Absolute path on day2's server (for uploads). */
  path: string;
  /** Public https URL served by day2 (for platforms that fetch by URL). */
  url: string;
  source: AssetSource;
  /** Made by generative AI (avatar, generated footage). */
  aiGenerated: boolean;
  /** Shows an AI-generated person (actor/avatar): needs disclosure in some markets. */
  aiPerson: boolean;
  /** For videos: a still of the same ratio (cover / thumbnail). */
  thumbnail?: Asset;
};

export type CallToAction = "learn_more" | "sign_up" | "download" | "get_started";

export type AdCopy = {
  headline: string;
  /** Primary text / caption. */
  body: string;
  /** Secondary line where the platform has one (e.g. Google description, Meta link description). */
  description?: string;
  cta: CallToAction;
};

/** One ad variant. `asset` is null for text-only ads (where the platform supports them). */
export type AdCreativeInput = {
  /** Stable key for this variant, e.g. "B-4-tiktok-v1" — returned in stats. */
  key: string;
  copy: AdCopy;
  asset: Asset | null;
  /** This ad's own tracked landing URL (…?d2=B-4.tiktok.v1). Use it instead of LaunchSpec.link when present. */
  link?: string;
};

export type Targeting = {
  /** ISO 3166-1 alpha-2, e.g. ["DE", "AT", "CH"]. */
  countries: string[];
  /** ISO 639-1, e.g. ["de"]. */
  languages: string[];
  ageMin: number;
  ageMax?: number;
  audience: "consumer" | "business";
  /** Free-text interests / job functions; adapters map what they can and ignore the rest. */
  interests: string[];
  /** For search ads (Google): what people type. */
  keywords: string[];
};

/** Who the ad shows as (a Facebook Page, a LinkedIn company page, a TikTok custom identity, …). */
export type Identity = {
  platform: PlatformId;
  /** Platform reference: Page id, organization URN, account id, identity id… */
  ref: string;
  displayName: string;
  /** Square logo (for platforms that create a custom identity). */
  logo?: Asset;
};

export type LaunchSpec = {
  appId: string;
  appName: string;
  /** Unique, human-readable: "day2 buddy B-4". */
  campaignName: string;
  /** Tracked landing URL — use exactly as given (each creative may carry its own `link`). */
  link: string;
  /** Daily budget in the ad account's currency (`currency`). */
  dailyBudget: number;
  /** ISO 4217 currency of the ad account, e.g. "USD", "EUR". */
  currency: string;
  /**
   * "clicks": optimise for landing-page clicks/visits (always possible).
   * "signups": optimise for the conversion in `conversion` (set up with
   * ensureConversions) — used once the platform has enough conversions.
   */
  optimizeFor: "clicks" | "signups";
  conversion?: ConversionSetup;
  targeting: Targeting;
  creatives: AdCreativeInput[];
  /** null when the platform needs none (info.identity === "none"). */
  identity: Identity | null;
  /** Some creative shows AI-generated people or footage: set the platform's AI-content label where it has one. */
  aiContent: boolean;
};

/** What day2 keeps to operate a launched campaign later. */
export type Launched = {
  platform: PlatformId;
  campaignId: string;
  /** Platform-internal ids (ad group / ad set / line item …) the adapter needs later. */
  refs: Record<string, string>;
  /** Creative key → the platform's ad id. */
  ads: Record<string, string>;
};

export type CampaignStatus = "active" | "paused" | "in_review" | "rejected" | "ended" | "unknown";

export type AdStats = {
  /** Lifetime spend in the ad account's currency. */
  spend: number;
  currency: string;
  impressions: number;
  clicks: number;
  status: CampaignStatus;
  /** Why the platform rejected an ad, when it did. */
  rejection?: string;
  /** Per creative key. */
  byCreative?: Record<string, { spend: number; impressions: number; clicks: number; status?: CampaignStatus }>;
};

export interface AdPlatform {
  readonly id: PlatformId;
  /** Creates campaign → ad group → ads (uploading assets as needed), ACTIVE. */
  launch(spec: LaunchSpec): Promise<Launched>;
  /** Lifetime results. */
  stats(c: Launched): Promise<AdStats>;
  pause(c: Launched): Promise<void>;
  resume(c: Launched): Promise<void>;
  /** In the ad account's currency. */
  setDailyBudget(c: Launched, amount: number): Promise<void>;
  /** Pauses or re-activates one ad (by its creative key) inside a launched campaign. */
  setAdActive(c: Launched, key: string, active: boolean): Promise<void>;
  /** The ad account this adapter operates: id, name, currency, whether it can spend. */
  accountInfo(): Promise<AdAccountInfo>;
  /**
   * For info.identity === "app_account": whether day2 can run ads as this
   * identity on this ad account right now (page role granted, profile
   * linked, promotable user…), and what's missing if not.
   */
  checkIdentity?(identity: Identity): Promise<{ ok: true } | { ok: false; problem: string }>;
  /**
   * Creates (or finds) what the platform needs to receive day2's sign-up
   * and activation conversions for this ad account — pixel / dataset /
   * conversion action / conversion rule. Idempotent.
   */
  ensureConversions?(): Promise<ConversionSetup>;
  /** Sends conversions (server-to-server), deduplicated by eventId on the platform where it supports that. */
  sendConversions?(setup: ConversionSetup, events: Conversion[]): Promise<{ sent: number; rejected: Array<{ eventId: string; why: string }> }>;
  /**
   * Only for info.identity === "custom": creates (or finds, by display
   * name) the identity the app's ads show as. day2 stores the result and
   * passes it in LaunchSpec.identity from then on.
   */
  ensureIdentity?(app: { appId: string; displayName: string; logo: Asset }): Promise<Identity>;
}

export type AdAccountInfo = { id: string; name: string; currency: string; canSpend: boolean; problem?: string };

/** What a platform needs to receive conversions, as created by ensureConversions. */
export type ConversionSetup = { platform: PlatformId; refs: Record<string, string> };

/** The platform click id captured when the visitor landed (fbclid, ttclid, gclid, li_fat_id, ScCid, epik, rdt_cid, twclid). */
export type ClickId = { param: string; value: string };

export type Conversion = {
  /** Stable id for deduplication, e.g. "dev-123:signup". */
  eventId: string;
  name: "signup" | "activated";
  at: string;
  click: ClickId;
  /** The landing page the visitor arrived on (no query string). */
  pageUrl: string;
  /** day2's hashed user id when known (never an email or name). */
  externalId?: string;
  /** The visitor's IP address and browser when they clicked (kept by day2 only 7 days; required by some platforms to match). */
  clientIp?: string;
  userAgent?: string;
};

export type PlatformInfo = {
  id: PlatformId;
  name: string;
  /** Accepted asset specs, preferred first. */
  formats: AssetSpec[];
  /** Can run an ad without an image or video (e.g. Google search ads). */
  textOnly: boolean;
  copyLimits: { headline: number; body: number; description?: number };
  /** The platform's practical minimum daily budget per campaign/ad group, in USD (converted for other currencies). */
  minDailyUsd: number;
  /** The URL parameter the platform appends to ad clicks (fbclid, ttclid, gclid, …). */
  clickIdParam: string;
  /**
   * "none": no identity needed. "custom": the adapter creates one from the
   * app's name and logo. "app_account": the app's own page/account must be
   * linked to day2 once (by its owner or day2's operator).
   */
  identity: "none" | "custom" | "app_account";
  /** For "app_account": what has to be linked, in one sentence. */
  identityHelp?: string;
  /** Who the platform reaches well. */
  audiences: Array<"consumer" | "business">;
  /** Environment variables day2's server needs for its own ad account. */
  env: string[];
  /** The API version this adapter was written against. */
  apiVersion: string;
};

export type PlatformDeps = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Reads an asset's bytes (defaults to the file at asset.path). */
  readAsset?: (asset: Asset) => Promise<Uint8Array>;
};

export class PlatformError extends Error {
  constructor(
    public platform: PlatformId,
    message: string,
    public status?: number,
    /** Worth retrying later (rate limits, outages). */
    public retryable = false,
  ) {
    super(`${platform}: ${message}`);
  }
}
