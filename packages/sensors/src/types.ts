/**
 * day2 field contracts: what must be true in an app, checked on the user's
 * device. A contract that holds is counted; one that breaks is reported as
 * "expected X, actual Y" with the evidence — a fact, not a guess.
 *
 * Shared by the device library (this package) and day2's server (ingest,
 * contract generator), so both sides agree on the shapes.
 */

export const CONTRACTS_VERSION = 1;

/** What an action must lead to. All listed expectations must hold. */
export type Expectation =
  /** The route the user ends up on; `:param` matches one segment. */
  | { screen: string }
  /** A network call that must complete, e.g. "POST /api/orders"; status "2xx" by default. */
  | { request: string; status?: "2xx" | number }
  /** An element that must become visible (CSS selector on web, testID on mobile). */
  | { visible: string };

export type ContractSource = "code" | "declared" | "learned";

export type ActionContract = {
  id: string;
  kind: "action";
  /** `action:<name>` matches an element tagged `data-day2-action="<name>"`; anything else is a CSS selector. */
  target: string;
  expect: Expectation[];
  /** Milliseconds the result may take. Default 3000. */
  within?: number;
  source: ContractSource;
  /** Where in the app's code this came from, for the fix ("src/Cart.tsx:42"). */
  origin?: string;
};

export type ScreenContract = {
  id: string;
  kind: "screen";
  /** Route pattern, e.g. "/checkout" or "/orders/:id". */
  route: string;
  /** Elements that must be visible once the screen is ready. */
  require?: string[];
  /** The required elements must appear within this many ms. Default 3000. */
  readyWithin?: number;
  source: ContractSource;
  origin?: string;
};

export type SpeedContract = {
  id: string;
  kind: "speed";
  metric: "lcp" | "inp" | "screen_ready";
  /** Applies to one route pattern, or every route when absent. */
  route?: string;
  maxMs: number;
  source: ContractSource;
};

export type FlowContract = {
  id: string;
  kind: "flow";
  name: string;
  /** Route patterns, in order. */
  steps: string[];
  /** The whole flow must complete within this many ms of its first step. Default 15 minutes. */
  within?: number;
  source: ContractSource;
};

/** Checked by the app's own code: `day2.check(id, ok)` (e.g. total = sum of items). */
export type InvariantContract = {
  id: string;
  kind: "invariant";
  description: string;
  source: ContractSource;
};

export type Contract = ActionContract | ScreenContract | SpeedContract | FlowContract | InvariantContract;

export type ContractFile = {
  version: typeof CONTRACTS_VERSION;
  generatedAt: string;
  contracts: Contract[];
};

// ---------------------------------------------------------------------------
// What the device sends
// ---------------------------------------------------------------------------

/** Contracts every app gets without a contract file. */
export const BUILTIN = {
  crash: "builtin:stability.crash",
  error: "builtin:stability.error",
  freeze: "builtin:stability.freeze",
  serverError: "builtin:stability.server_error",
  link: "builtin:action.link",
  fits: "builtin:screen.fits",
  placeholder: "builtin:screen.placeholder",
  images: "builtin:screen.images",
  lcp: "builtin:speed.lcp",
  inp: "builtin:speed.inp",
  stuckLoading: "builtin:speed.loading",
} as const;

export type Breadcrumb = { at: number; kind: "screen" | "tap" | "request" | "error"; text: string };

export type Failure = {
  /** Contract id; for built-ins, the id plus where it applies (e.g. "builtin:screen.fits /checkout"). */
  contract: string;
  at: string;
  route: string;
  expected: unknown;
  actual: unknown;
  evidence?: {
    requests?: Array<{ call: string; status: number; ms: number }>;
    errors?: string[];
    detail?: Record<string, unknown>;
  };
  steps: string[];
};

export type GrowthEvent = {
  type: string;
  at: string;
  /** The app's user, hashed (`hashUser`), once the app called `identify`. */
  user?: string;
  /** `click`: the ad platform's click id from the landing URL (fbclid, ttclid, gclid…), for conversions. */
  acquisition?: { campaignId?: string; channel?: string; click?: { param: string; value: string; /** Added by day2's server, kept 7 days. */ ip?: string; ua?: string } };
  /** Small facts about the event: ≤ 8 keys (`^[a-z][a-z0-9_]{0,31}$`), strings ≤ 80 characters. Never personal data. */
  props?: Record<string, string | number | boolean>;
  /** Money the event brought (revenue): amount ≥ 0 and < 10 000, ISO 4217 currency. */
  value?: { amount: number; currency: string };
};

export type DeviceInfo = {
  /** Anonymous: random per session, or per device when the app opts in (after consent). */
  id: string;
  platform: "web" | "ios" | "android";
  os?: string;
  browser?: string;
  model?: string;
  viewport?: { w: number; h: number };
  locale?: string;
  theme?: "light" | "dark";
  textScale?: number;
  network?: string;
};

export type Batch = {
  v: 1;
  release?: string;
  device: DeviceInfo;
  /** Contract id → times it held since the last batch. */
  passes: Record<string, number>;
  failures: Failure[];
  events: GrowthEvent[];
  /** Live experiments this unit was exposed to: experiment id → variant (≤ 20). */
  variants?: Record<string, string>;
};

export const MAX_BATCH_BYTES = 64_000;

// ---------------------------------------------------------------------------
// Live config (docs/live.md): settings and experiments served to the app
// ---------------------------------------------------------------------------

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Who a setting, experiment, ad or message is for. All listed conditions must hold. */
export type Audience = {
  platforms?: ("ios" | "android")[];
  /** "de" matches "de-DE"; "pt-BR" only "pt-BR". */
  locales?: string[];
  /** Installed (first launch with day2) at most this many days ago. */
  newWithinDays?: number;
  /** Came from one of day2's ads. */
  fromAds?: boolean;
  /** The app's version is at least this ("1.4.0"; the release tag's version part is compared). */
  minRelease?: string;
  /** A stable share of units, 0–100. */
  percent?: number;
};

export type LiveExperiment = {
  id: string;
  keys: string[];
  /** Includes "control". */
  variants: Array<{ name: string; weight: number; values: Record<string, Json> }>;
  audience?: Audience;
};

export type AdCap = { perSession?: number; perDay?: number; minSecondsBetween?: number };
export type LiveAd = { format: "banner" | "interstitial" | "rewarded" | "native"; unitId: { ios?: string; android?: string }; cap: AdCap; audience?: Audience; enabled: boolean };

export type LiveMessage = {
  id: string;
  trigger: string;
  title: string;
  body: string;
  cta?: { label: string; route?: string; url?: string };
  cap: { total: number; perDay: number };
  audience?: Audience;
  locale?: Record<string, { title: string; body: string; cta?: string }>;
};

export type LiveReview = { afterEvents: Record<string, number>; minDaysSinceInstall: number; minDaysBetween: number; notAfterProblem: boolean };

export type LiveConfig = {
  v: 1;
  /** Increases on every change. */
  version: number;
  values: Record<string, Json>;
  experiments: LiveExperiment[];
  ads?: Record<string, LiveAd>;
  messages?: LiveMessage[];
  review?: LiveReview;
};
