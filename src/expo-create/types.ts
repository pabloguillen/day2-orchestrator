/**
 * Create: a new native Expo app from the owner's description (docs/expo-apps.md).
 * Shared types of the flow, its store and its routes.
 */

export type Platform = "ios" | "android";
export type Money = "free" | "subscription" | "one_time" | "ads" | "undecided";
export const MONEY: Money[] = ["free", "subscription", "one_time", "ads", "undecided"];
export const LOOKS = ["Calm", "Playful", "Bold", "Minimal", "Professional"];

export type CreateRequest = {
  /** Lowercase slug, like habit-loop (repo name, app slug). */
  name: string;
  /** What the app is called on the phone ("Habit Loop"). */
  displayName: string;
  description: string;
  audience?: string;
  look?: string[];
  platforms: Platform[];
  money: Money;
  /** The owner's domain (habitloop.com) — the bundle id / package come from it. */
  domain?: string;
};

export type Identifiers = { bundleId: string; androidPackage: string; scheme: string; displayName: string; slug: string };

// ---------------------------------------------------------------------------
// The screen flow: every screen, where each button goes, grouped by flow
// ---------------------------------------------------------------------------

/** The flows screens are grouped into, in the order they're shown. */
export type FlowGroup = "onboarding" | "sign_in" | "main" | "settings" | "paywall" | "states";
export const FLOW_GROUPS: FlowGroup[] = ["onboarding", "sign_in", "main", "settings", "paywall", "states"];
export const FLOW_GROUP_LABEL: Record<FlowGroup, string> = {
  onboarding: "First launch",
  sign_in: "Sign in",
  main: "Main loop",
  settings: "Settings and profile",
  paywall: "Paywall",
  states: "Empty and error states",
};

export type ScreenState = "empty" | "loading" | "error" | "filled";
export const SCREEN_STATES: ScreenState[] = ["empty", "loading", "error", "filled"];

/** Where a button goes: "Tap Start" → screen id "sign-up". */
export type ScreenLink = { label: string; to: string };

export type PlanScreen = {
  id: string;
  name: string;
  /** Expo Router path; a state screen shares its screen's route. */
  route: string;
  purpose: string;
  /** The first screen of the main loop (the one users come back to). */
  key: boolean;
  elements: string[];
  flow: FlowGroup;
  /** The states this screen has (empty, loading, error, filled). */
  states: ScreenState[];
  links: ScreenLink[];
  /** A drawing of one state of another screen (e.g. Today with no habits yet). */
  stateOf?: string;
  state?: ScreenState;
  /** Android looks different enough to draw it separately (e.g. a system sheet). */
  androidDiffers?: boolean;
};
export type PlanData = { name: string; fields: string[]; where: "device" | "server" };
export type PlanAction = { title: string; route: string; phrase?: string };
export type PlanFunction = { name: string; purpose: string };

/** The product plan with its screen inventory, drawn before anything is built. */
export type ProductPlan = {
  summary: string;
  screens: PlanScreen[];
  data: PlanData[];
  /** What a new user sees and does in their first minute, step by step. */
  firstMinute: string[];
  monetization: { model: Money; placement: string; notes: string };
  /** The app's main actions (for Siri/Shortcuts and Android app shortcuts later). */
  actions: PlanAction[];
  accounts: boolean;
  /** Work that has to run on a server (behind the backend adapter). */
  functions: PlanFunction[];
  /** The app's language for every text ("en", "de"…). */
  language: string;
  openQuestions: string[];
  /** Users see each other's data (a shared list, a feed, messages) — needs a hosted backend. */
  sharedData?: boolean;
  /** Live updates while the app is open (chat, a shared list changing). */
  realtime?: boolean;
  /** Where most users are (ISO country codes): the backend's region is picked from it. */
  countries?: string[];
};

/** Why the app needs a hosted backend (Create's plan, docs/expo-apps.md "Hosting"). */
export type HostingReason = "accounts" | "shared" | "files" | "server" | "realtime";

/** The plan's decision, shown at the flow approval: needed, why, where and what it costs a month. */
export type HostingDecision = {
  needed: boolean;
  reasons: HostingReason[];
  /** The operator set up Supabase (SUPABASE_ACCESS_TOKEN, DAY2_SUPABASE_ORG_ID). */
  configured: boolean;
  region: string | null;
  place: string | null;
  /** Hosting's expected cost a month, in credits — billed monthly as Hosting, not as building. */
  monthlyCredits: number;
};

/** Where the build's hosted backend is (filled in at the backend step). */
export type BuildHosting = {
  /** hosted: on day2's Supabase; local: data on the phone (not needed, not configured, or setup stopped). */
  state: "not_needed" | "not_configured" | "setting_up" | "hosted" | "failed";
  region?: string;
  place?: string;
  projectRef?: string;
  url?: string;
  stagingRef?: string;
  monthlyCredits?: number;
  /** The hosted-backend ticket (hosted) or the "Host with day2" ticket (not configured, failed). */
  ticketId?: string;
  /** Plain-language status for the done page. */
  note?: string;
  error?: string;
};

/** The app's design system: derived from the look and feel before any screen is drawn. */
export type DesignSystem = {
  name: string;
  /** Roles: background, surface, text, muted, primary, onPrimary, accent, border, danger, success. */
  colors: Array<{ role: string; hex: string; use: string }>;
  fonts: { heading: string; body: string };
  type: Array<{ name: string; size: number; weight: number; lineHeight: number }>;
  /** The spacing scale in points (4, 8, 12, 16…). */
  spacing: number[];
  radius: { small: number; medium: number; large: number };
  components: Array<{ name: string; spec: string }>;
  voice: string;
};

/** A tappable area on a drawing, as fractions of the screen (0–1). */
export type Hotspot = { to: string; label: string; x: number; y: number; w: number; h: number };

/** One screen's drawing. Unchanged screens keep their drawing from the version that made it. */
export type ScreenDesign = {
  screenId: string;
  /** The version this drawing was made in. */
  drawnIn: number;
  png: string;
  html: string;
  androidPng?: string;
  androidHtml?: string;
  note: string;
  hotspots: Hotspot[];
};

/** v1, v2…: the whole screen flow at one point. */
export type FlowVersion = {
  n: number;
  at: string;
  plan: ProductPlan;
  designSystem: DesignSystem;
  /** The style card (the design system as its own picture). */
  style: { png: string; html: string; drawnIn: number };
  designs: ScreenDesign[];
  /** The flow map (all screens, arrows labelled with the action). */
  map?: { png: string; html: string };
  /** Screens drawn new in this version (everything in v1). */
  changed: string[];
  /** What the owner asked for (the change request that made this version). */
  asked?: string;
};

/** The owner's comment on one screen ("style" = the style card, "flow" = everything). */
export type FlowComment = {
  id: string;
  screenId: string;
  version: number;
  text: string;
  /** Where on the screen it's pinned (fractions, 0–1). */
  pin?: { x: number; y: number };
  at: string;
  /** The version that took it into account. */
  doneIn?: number;
};

export type ChangeRequest = { note: string; add: Array<{ name: string; purpose: string }>; remove: string[] };

export type ScreenFlow = {
  versions: FlowVersion[];
  /** The version being drawn (resumable: screens already drawn stay drawn). */
  draft?: FlowVersion & { redraw: string[]; styleChanged: boolean };
  comments: FlowComment[];
  /** Screens marked approved early: they don't change in later rounds. */
  approved: string[];
  /** The change request being worked on. */
  pending?: ChangeRequest & { commentIds: string[] };
};

/** A simulator screenshot next to the approved drawing, after a build step. */
export type ScreenComparison = {
  phase: Phase;
  attempt: number;
  /** The device-check report's key (its screenshots). */
  key: string;
  pairs: Array<{ screenId: string; name: string; design: string; shot: string; platform: Platform }>;
  /** The agent already fixed clear mismatches once in this step. */
  fixed?: boolean;
};

/** @deprecated The old key-screen drawings (builds from before the screen flow). */
export type Mockup = { screenId: string; name: string; file: string; note: string };

export type Phase =
  | "plan"
  | "style"
  | "design"
  | "flow_review"
  | "flow_revise"
  | "scaffold"
  | "prewire"
  | "theme"
  | "screens"
  | "backend"
  | "polish"
  | "publish"
  | "onboard"
  | "done";

export const PHASES: Phase[] = ["plan", "style", "design", "flow_review", "flow_revise", "scaffold", "prewire", "theme", "screens", "backend", "polish", "publish", "onboard", "done"];

export const PHASE_LABEL: Record<Phase, string> = {
  plan: "Writing the list of screens",
  style: "Choosing colors, type and components",
  design: "Drawing every screen",
  flow_review: "Your OK on the screens",
  flow_revise: "Changing the screens you asked for",
  scaffold: "Setting up the Expo app",
  prewire: "Wiring in releases, field checks and privacy",
  theme: "Turning the design into code",
  screens: "Building the screens as approved",
  backend: "Adding data and the backend",
  polish: "Polishing and wiring in day2",
  publish: "Creating your private GitHub repo",
  onboard: "Adding it to day2",
  done: "Ready",
};

export type CreateStatus = "working" | "needs_you" | "done" | "failed" | "canceled";

export type CheckResult = "passed" | "failed" | "skipped";
export type StepCheck = { phase: Phase; attempt: number; typecheck: CheckResult; lint: CheckResult; devices: CheckResult; summary: string; at: string; deviceKey?: string | null; backend?: CheckResult };

export type OwnerStep = { id: string; title: string; detail: string; command?: string; link?: { label: string; url: string }; done: boolean };

export type ExpoBuild = {
  id: string;
  accountId: string;
  /** Record format (2: the screen flow). Older records are migrated on read (store.ts). */
  v?: number;
  /** Chosen up front: drawings, field key and the registered app share it. */
  appId: string;
  at: string;
  updatedAt: string;
  request: CreateRequest;
  identifiers: Identifiers;
  phase: Phase;
  status: CreateStatus;
  /** Plain-language line for the progress page. */
  step: string;
  plan?: ProductPlan;
  planRevision: number;
  /** Kept from the old plan review (each comment made a new revision). */
  planComments: string[];
  /** The design system being drawn with (before v1 exists). */
  designSystem?: DesignSystem;
  flow: ScreenFlow;
  /** @deprecated Old key-screen drawings. */
  mockups: Mockup[];
  mockupComments: string[];
  /** Simulator screenshots next to the drawings, per build step. */
  comparisons: ScreenComparison[];
  /** The build agent couldn't get a step to pass its checks: the owner decides. */
  stuck?: { phase: Phase; reason: string };
  checks: StepCheck[];
  /** How to wire the native packages installed at prewire (Live's native foundations). */
  nativeInstructions?: string[];
  /** Attempts at the current build step (theme, screens, backend, polish). */
  attempt?: number;
  repoDir?: string;
  githubRepo?: string;
  /** Credits used so far. */
  credits: number;
  estimateCredits: number;
  /** Follow-up ticket ids in the new app's backlog. */
  tickets: string[];
  ownerSteps: OwnerStep[];
  log: Array<{ at: string; text: string }>;
  error?: string;
  /** The app's hosted backend (Hosting), once the backend step decided it. */
  hosting?: BuildHosting;
};
