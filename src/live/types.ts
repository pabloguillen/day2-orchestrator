import type { Audience, Json } from "../../packages/sensors/src/types";

/**
 * Live (docs/live.md): settings and experiments inside the app, changed over
 * the air. One document per app (LiveState) holds the owner's and day2's
 * settings, the experiments with their results, ideas, the autonomy setting
 * and the decision log.
 */

export const LIVE_FILENAME = "day2-live.json";

export type { Audience, Json };

export type LiveValueEntry = {
  value: Json;
  /** What the setting is for, in plain words. */
  note?: string;
  by: "owner" | "day2" | "experiment";
  at: string;
};

export type Metric = { kind: "event"; event: string } | { kind: "retention_d7" } | { kind: "revenue_per_user" };

export type ExperimentState =
  /** Written down, not started. */
  | "draft"
  /** day2 proposed it and the owner wants to say yes first ("ask me first"). */
  | "to_approve"
  /** The app's code must read new settings: a backlog ticket for the build agent. */
  | "building"
  /** The code is merged; waiting for the over-the-air update with it to reach users. */
  | "waiting"
  | "running"
  /** Measured; waiting for the owner (or day2) to keep the winner. */
  | "decided"
  | "promoted"
  | "stopped";

export type Variant = { name: string; weight: number; values: Record<string, Json> };

export type ArmResult = {
  name: string;
  /** Users (or devices) who saw it. */
  n: number;
  /** Conversion share, D7 retention share or revenue per user. */
  value: number | null;
  /** Chance this variant beats control on the primary metric (null for control). */
  probBetter: number | null;
  crashRate: number | null;
  /** D7 retention (for money experiments' guardrail). */
  d7: number | null;
  d7n: number;
};

export type Guardrail = { what: "crash_rate" | "retention_d7"; variant: string; value: number; control: number; prob: number };

export type ExperimentResult = {
  at: string;
  arms: ArmResult[];
  verdict: "collecting" | "better" | "worse" | "no_clear_change";
  winner: string | null;
  guardrail: Guardrail | null;
  /** Every arm reached the minimum sample. */
  enough: boolean;
  currency: string | null;
  note: string;
};

export type Experiment = {
  /** "X-3" */
  id: string;
  title: string;
  hypothesis: string;
  keys: string[];
  variants: Variant[];
  audience?: Audience;
  metric: Metric;
  guardrails: { crashRate: true; retentionD7: boolean };
  /** The app's code already reads every key: no build needed. */
  configOnly: boolean;
  state: ExperimentState;
  createdBy: "day2" | "owner";
  createdAt: string;
  updatedAt: string;
  minPerArm: number;
  maxDays: number;
  ticketId: string | null;
  cleanupTicketId: string | null;
  /** The update or store build that carries the code (release keys, field-store releaseHealth). */
  release: { keys: string[]; label: string; at: string } | null;
  startedAt: string | null;
  endedAt: string | null;
  result: ExperimentResult | null;
  decision: { verdict: ExperimentResult["verdict"]; winner: string | null; at: string; by: "day2" | "owner"; note: string } | null;
  stopReason: string | null;
  ideaId: string | null;
};

export type Idea = {
  id: string;
  title: string;
  hypothesis: string;
  why: string;
  keys: string[];
  variants: Variant[];
  metric: Metric;
  audience?: Audience;
  createdAt: string;
  status: "new" | "used" | "dismissed";
  experimentId: string | null;
  /** From the owner's own words ("describe an experiment"). */
  fromOwner?: string;
};

export type LiveLog = { at: string; text: string; experiment?: string };

export type LiveSettings = {
  /** day2 decides (default for config-only experiments) or ask me first. */
  autonomy: "day2_decides" | "ask_first";
  /** At most this many experiments at once (building, waiting or running). */
  maxActive: number;
};

export type LiveState = {
  v: 1;
  values: Record<string, LiveValueEntry>;
  experiments: Experiment[];
  ideas: Idea[];
  settings: LiveSettings;
  nextExperiment: number;
  nextIdea: number;
  ideasAt: string | null;
  log: LiveLog[];
};

export const DEFAULT_SETTINGS: LiveSettings = { autonomy: "day2_decides", maxActive: 2 };
export const DEFAULT_MIN_PER_ARM = 200;
export const DEFAULT_MAX_DAYS = 28;
export const KEEP_LOG = 200;

export const emptyLiveState = (): LiveState => ({
  v: 1,
  values: {},
  experiments: [],
  ideas: [],
  settings: { ...DEFAULT_SETTINGS },
  nextExperiment: 1,
  nextIdea: 1,
  ideasAt: null,
  log: [],
});

/** Missing fields from older files are filled in. */
export function normalizeState(raw: unknown): LiveState {
  const e = emptyLiveState();
  if (!raw || typeof raw !== "object") return e;
  const r = raw as Partial<LiveState>;
  return {
    v: 1,
    values: r.values && typeof r.values === "object" ? r.values : {},
    experiments: Array.isArray(r.experiments) ? r.experiments : [],
    ideas: Array.isArray(r.ideas) ? r.ideas : [],
    settings: { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) },
    nextExperiment: Number.isInteger(r.nextExperiment) ? r.nextExperiment! : 1,
    nextIdea: Number.isInteger(r.nextIdea) ? r.nextIdea! : 1,
    ideasAt: typeof r.ideasAt === "string" ? r.ideasAt : null,
    log: Array.isArray(r.log) ? r.log : [],
  };
}

export function addLog(s: LiveState, at: Date, text: string, experiment?: string): LiveState {
  return { ...s, log: [{ at: at.toISOString(), text, ...(experiment ? { experiment } : {}) }, ...s.log].slice(0, KEEP_LOG) };
}

/** Experiments whose settings apps get (in config). */
export const SERVED_STATES: ExperimentState[] = ["waiting", "running", "decided"];
/** Experiments counting toward the limit. */
export const ACTIVE_STATES: ExperimentState[] = ["building", "waiting", "running", "decided"];
