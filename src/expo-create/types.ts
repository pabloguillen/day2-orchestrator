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

export type PlanScreen = { id: string; name: string; route: string; purpose: string; key: boolean; elements: string[] };
export type PlanData = { name: string; fields: string[]; where: "device" | "server" };
export type PlanAction = { title: string; route: string; phrase?: string };

/** The product plan the owner approves before anything is drawn or built. */
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
  openQuestions: string[];
};

export type Mockup = { screenId: string; name: string; file: string; note: string };

export type Phase =
  | "plan"
  | "plan_review"
  | "mockups"
  | "mockup_review"
  | "scaffold"
  | "prewire"
  | "screens"
  | "data"
  | "polish"
  | "publish"
  | "onboard"
  | "done";

export const PHASES: Phase[] = ["plan", "plan_review", "mockups", "mockup_review", "scaffold", "prewire", "screens", "data", "polish", "publish", "onboard", "done"];

export const PHASE_LABEL: Record<Phase, string> = {
  plan: "Writing the product plan",
  plan_review: "Your OK on the plan",
  mockups: "Drawing the key screens",
  mockup_review: "Your OK on the screens",
  scaffold: "Setting up the Expo app",
  prewire: "Wiring in releases, field checks and privacy",
  screens: "Building the screens",
  data: "Adding data and state",
  polish: "Polishing and checking",
  publish: "Creating your private GitHub repo",
  onboard: "Adding it to day2",
  done: "Ready",
};

export type CreateStatus = "working" | "needs_you" | "done" | "failed" | "canceled";

export type CheckResult = "passed" | "failed" | "skipped";
export type StepCheck = { phase: Phase; attempt: number; typecheck: CheckResult; lint: CheckResult; devices: CheckResult; summary: string; at: string };

export type OwnerStep = { id: string; title: string; detail: string; command?: string; link?: { label: string; url: string }; done: boolean };

export type ExpoBuild = {
  id: string;
  accountId: string;
  /** Chosen up front: mockups, field key and the registered app share it. */
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
  /** The owner's comments on the plan, oldest first (each one makes a new revision). */
  planComments: string[];
  mockups: Mockup[];
  mockupComments: string[];
  /** The build agent couldn't get a step to pass its checks: the owner decides. */
  stuck?: { phase: Phase; reason: string };
  checks: StepCheck[];
  /** How to wire the native packages installed at prewire (Live's native foundations). */
  nativeInstructions?: string[];
  /** Attempts at the current build step (screens, data, polish). */
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
};
