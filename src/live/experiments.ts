import { evaluateProportionExperiment } from "../experiments";
import { seeded } from "../growth-bets";
import type { NewTicketInput } from "../backlog";
import { mainCurrency, REVENUE_EVENT_SIGN, unitOf } from "../metrics/monetization-kpis";
import type { EventLike } from "../metrics/types";
import type { Audience, Json } from "../../packages/sensors/src/types";
import {
  ACTIVE_STATES,
  addLog,
  DEFAULT_MAX_DAYS,
  DEFAULT_MIN_PER_ARM,
  type ArmResult,
  type Experiment,
  type ExperimentResult,
  type Guardrail,
  type LiveState,
  type Metric,
  type Variant,
} from "./types";

/**
 * Live experiments: one primary metric, guardrails (crash rate always; D7
 * retention when the metric is money), a minimum sample per arm, a maximum
 * duration, and a decision with probabilities. Pure: events, crashes and
 * the clock come in, a new state goes out.
 *
 * Lifecycle: draft → (to_approve) → building (only when the code must read
 * new keys) → waiting (the update with the code is on its way) → running →
 * decided → promoted (winner becomes the default) or stopped.
 */

const DAY = 86_400_000;
export const KEY_RE = /^[a-z][a-z0-9_.-]{0,63}$/i;
const VARIANT_RE = /^[a-z][a-z0-9_-]{0,23}$/i;
/** P(better) needed to call a winner, and P(worse) to call it worse. */
export const DECIDE_AT = 0.95;
/** A guardrail is breached when the variant is this likely worse… */
export const GUARDRAIL_AT = 0.95;
/** …and crashes this much more (absolute share of users). */
export const CRASH_MARGIN = 0.01;
/** Arms need this many before a guardrail can stop an experiment early. */
export const GUARDRAIL_MIN_N = 50;

export const metricLabel = (m: Metric): string =>
  m.kind === "event" ? `share who ${m.event.replace(/_/g, " ")}` : m.kind === "retention_d7" ? "share who come back after a week" : "revenue per user";

export const isMoney = (m: Metric) => m.kind === "revenue_per_user";

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export type ExperimentInput = {
  title: string;
  hypothesis: string;
  keys: string[];
  variants: Variant[];
  metric: Metric;
  audience?: Audience;
  minPerArm?: number;
  maxDays?: number;
  createdBy: "day2" | "owner";
  ideaId?: string | null;
};

/** Checks an experiment's shape; returns what's wrong in plain words, or null. */
export function invalidExperiment(input: ExperimentInput, state: LiveState): string | null {
  if (!input.title?.trim()) return "An experiment needs a title.";
  if (!input.keys.length || input.keys.length > 10) return "An experiment changes 1 to 10 settings.";
  for (const k of input.keys) if (!KEY_RE.test(k)) return `"${k}" isn't a valid setting name (letters, digits, dots, dashes; starts with a letter).`;
  if (input.variants.length < 2 || input.variants.length > 5) return "An experiment needs control and 1 to 4 other versions.";
  const names = new Set<string>();
  for (const v of input.variants) {
    if (!VARIANT_RE.test(v.name)) return `"${v.name}" isn't a valid version name.`;
    if (names.has(v.name)) return `Two versions are called "${v.name}".`;
    names.add(v.name);
    if (!(v.weight > 0) || v.weight > 100) return "Each version needs a share between 1 and 100.";
    for (const k of Object.keys(v.values)) if (!input.keys.includes(k)) return `Version "${v.name}" sets "${k}", which the experiment doesn't change.`;
    if (JSON.stringify(v.values).length > 4000) return `Version "${v.name}" is too large.`;
  }
  if (!names.has("control")) return 'One version must be "control" (what users get today).';
  if (input.metric.kind === "event" && !/^[A-Za-z0-9_.-]{1,40}$/.test(input.metric.event)) return "The goal must be an event name the app sends.";
  const busy = state.experiments.filter((e) => ACTIVE_STATES.includes(e.state) || e.state === "to_approve").flatMap((e) => e.keys.map((k) => ({ k, id: e.id })));
  for (const k of input.keys) {
    const clash = busy.find((b) => b.k === k);
    if (clash) return `"${k}" is already being tested in ${clash.id}.`;
  }
  return null;
}

/** Keys the app's code reads (day2.value / useDay2Value), so experiments on them need no build. */
export function keysInCode(files: Array<{ file: string; text: string }>): Set<string> {
  const out = new Set<string>();
  const re = /\b(?:value|useDay2Value)\s*(?:<[^>()]*>)?\(\s*["'`]([A-Za-z][A-Za-z0-9_.-]{0,63})["'`]/g;
  for (const f of files) for (const m of f.text.matchAll(re)) out.add(m[1]!);
  return out;
}

export function addExperiment(state: LiveState, input: ExperimentInput, codeKeys: Set<string>, now: Date): { state: LiveState; experiment: Experiment } {
  const why = invalidExperiment(input, state);
  if (why) throw new Error(why);
  const at = now.toISOString();
  const experiment: Experiment = {
    id: `X-${state.nextExperiment}`,
    title: input.title.trim().slice(0, 120),
    hypothesis: input.hypothesis.trim().slice(0, 600),
    keys: input.keys,
    variants: input.variants.map((v) => ({ name: v.name, weight: v.weight, values: v.values })),
    ...(input.audience ? { audience: input.audience } : {}),
    metric: input.metric,
    guardrails: { crashRate: true, retentionD7: isMoney(input.metric) },
    configOnly: input.keys.every((k) => codeKeys.has(k)),
    state: "draft",
    createdBy: input.createdBy,
    createdAt: at,
    updatedAt: at,
    minPerArm: Math.max(30, Math.min(100_000, Math.round(input.minPerArm ?? DEFAULT_MIN_PER_ARM))),
    maxDays: Math.max(3, Math.min(90, Math.round(input.maxDays ?? DEFAULT_MAX_DAYS))),
    ticketId: null,
    cleanupTicketId: null,
    release: null,
    startedAt: null,
    endedAt: null,
    result: null,
    decision: null,
    stopReason: null,
    ideaId: input.ideaId ?? null,
  };
  return { state: { ...state, nextExperiment: state.nextExperiment + 1, experiments: [...state.experiments, experiment] }, experiment };
}

export const putExperiment = (s: LiveState, e: Experiment, now: Date): LiveState => ({ ...s, experiments: s.experiments.map((x) => (x.id === e.id ? { ...e, updatedAt: now.toISOString() } : x)) });

/** The current default for a key (what control gets), for tickets and the console. */
export const defaultOf = (s: LiveState, key: string): Json | undefined => s.values[key]?.value;

// ---------------------------------------------------------------------------
// Tickets: the code that reads the new settings, and the cleanup after
// ---------------------------------------------------------------------------

const show = (v: Json | undefined) => (v === undefined ? "(the app's current behaviour)" : JSON.stringify(v));

export function buildTicket(e: Experiment, s: LiveState, codeKeys: Set<string>): NewTicketInput & { source: { kind: "day2_proposal"; key: string } } {
  const fresh = e.keys.filter((k) => !codeKeys.has(k));
  return {
    title: `Read Live settings for ${e.id}: ${e.title}`.slice(0, 160),
    type: "feature",
    source: { kind: "day2_proposal", key: `live:build:${e.id}` },
    description: [
      `day2 wants to test this: ${e.hypothesis}`,
      "",
      `The app has to read ${fresh.length === 1 ? "a setting" : "these settings"} from day2's Live config instead of hard-coding ${fresh.length === 1 ? "it" : "them"}. The values come over the air; nothing in the code may know which version a user gets.`,
      "",
      ...fresh.map((k) => {
        const versions = e.variants.map((v) => `${v.name}: ${show(k in v.values ? v.values[k] : defaultOf(s, k))}`).join("; ");
        return `- \`${k}\` — read with \`day2.value("${k}", <today's value>)\` (or \`useDay2Value\` in a component). Versions in the test: ${versions}.`;
      }),
      "",
      "The fallback must be exactly what the app does today, so users outside the test (and offline) see no change.",
      "Build every version so it works and looks right in the app's own style; check each one on the virtual devices by passing a different fallback.",
      `Goal of the test: ${metricLabel(e.metric)}${e.metric.kind === "event" ? ` — the app must call day2.track("${e.metric.event}") where that happens, if it doesn't already` : ""}.`,
    ].join("\n"),
    doneWhen: [...fresh.map((k) => `The app reads "${k}" with day2.value or useDay2Value, falling back to today's behaviour`), "Every version works on iOS and Android", "The app builds and its tests pass"],
  };
}

export function cleanupTicket(e: Experiment, winner: string): NewTicketInput & { source: { kind: "day2_proposal"; key: string } } {
  const losers = e.variants.filter((v) => v.name !== winner).map((v) => v.name);
  return {
    title: `Clean up after ${e.id}: keep "${winner}"`.slice(0, 160),
    type: "improvement",
    source: { kind: "day2_proposal", key: `live:cleanup:${e.id}` },
    description: [
      `${e.id} (${e.title}) is decided: "${winner}" is kept, and it's now the default in Live.`,
      `Remove code paths that only served ${losers.map((l) => `"${l}"`).join(", ")} (anything branching on day2.variant("${e.id}")), and keep reading ${e.keys.map((k) => `"${k}"`).join(", ")} with day2.value so they can still be changed over the air.`,
      "Users must see no change.",
    ].join("\n"),
    doneWhen: ["No code is left that only a losing version used", "The settings are still read with day2.value", "The app builds and its tests pass"],
  };
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

export type Crash = { deviceId: string; at: string };

type Unit = { id: string; variant: string; at: number; devices: Set<string> };

/** Units exposed to the experiment (first exposure each), by variant. Intention to treat from the first exposure. */
export function exposedUnits(events: EventLike[], expId: string, since: string | null): Map<string, Unit> {
  const out = new Map<string, Unit>();
  for (const e of events) {
    if (e.type !== "exposure" || e.props?.exp !== expId || typeof e.props.variant !== "string") continue;
    if (since && e.at < since) continue;
    const id = unitOf(e);
    const at = Date.parse(e.at);
    const have = out.get(id);
    if (!have) out.set(id, { id, variant: e.props.variant, at, devices: new Set([e.deviceId]) });
    else {
      have.devices.add(e.deviceId);
      if (at < have.at) {
        have.at = at;
        have.variant = e.props.variant;
      }
    }
  }
  return out;
}

/** Bayesian bootstrap: P(mean of b > mean of a), deterministic for a given rng. For revenue per user (mostly zeros, a few large). */
export function probabilityMeanGreater(a: number[], b: number[], rng: () => number, draws = 2000): number {
  if (!a.length || !b.length) return 0.5;
  const weightedMean = (xs: number[]) => {
    let sw = 0;
    let s = 0;
    for (const x of xs) {
      const w = -Math.log(Math.max(rng(), Number.EPSILON));
      sw += w;
      s += w * x;
    }
    return s / sw;
  };
  let wins = 0;
  for (let i = 0; i < draws; i++) if (weightedMean(b) > weightedMean(a)) wins++;
  return wins / draws;
}

const share = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : null);

export type MeasureInput = { events: EventLike[]; crashes: Crash[]; now: Date };

/** The experiment's numbers and verdict right now (it doesn't change the experiment). */
export function measure(e: Experiment, input: MeasureInput): ExperimentResult {
  const now = input.now.getTime();
  const units = exposedUnits(input.events, e.id, e.startedAt);
  const byUser = new Map<string, EventLike[]>();
  const byDevice = new Map<string, EventLike[]>();
  for (const ev of input.events) {
    if (ev.userId) (byUser.get(ev.userId) ?? byUser.set(ev.userId, []).get(ev.userId)!).push(ev);
    (byDevice.get(ev.deviceId) ?? byDevice.set(ev.deviceId, []).get(ev.deviceId)!).push(ev);
  }
  const eventsOf = (u: Unit) => (u.id.startsWith("u_") ? (byUser.get(u.id) ?? []) : (byDevice.get(u.id) ?? []));
  const crashedDevices = new Map<string, number[]>();
  for (const c of input.crashes) (crashedDevices.get(c.deviceId) ?? crashedDevices.set(c.deviceId, []).get(c.deviceId)!).push(Date.parse(c.at));
  const currency = mainCurrency(input.events);

  const arms = new Map<string, { units: Unit[] }>();
  for (const v of e.variants) arms.set(v.name, { units: [] });
  for (const u of units.values()) arms.get(u.variant)?.units.push(u);

  const converted = (u: Unit): boolean => {
    const evs = eventsOf(u);
    if (e.metric.kind === "event") {
      const type = e.metric.event;
      return evs.some((x) => x.type === type && Date.parse(x.at) >= u.at);
    }
    return evs.some((x) => x.type !== "exposure" && Date.parse(x.at) >= u.at + 7 * DAY && Date.parse(x.at) < u.at + 8 * DAY);
  };
  const d7Eligible = (u: Unit) => now - u.at >= 8 * DAY;
  const money = (u: Unit): number => {
    let sum = 0;
    for (const x of eventsOf(u)) {
      const sign = REVENUE_EVENT_SIGN[x.type];
      if (sign && x.value && x.value.currency === currency && Date.parse(x.at) >= u.at) sum += sign * x.value.amount;
    }
    return sum;
  };
  const crashed = (u: Unit) => [...u.devices].some((d) => (crashedDevices.get(d) ?? []).some((t) => t >= u.at));

  type Raw = { name: string; units: Unit[]; outcome: boolean[] | number[]; crashes: boolean[]; d7: boolean[] };
  const raws: Raw[] = e.variants.map((v) => {
    const us = arms.get(v.name)!.units;
    const outcome = e.metric.kind === "revenue_per_user" ? us.map(money) : e.metric.kind === "retention_d7" ? us.filter(d7Eligible).map(converted) : us.map(converted);
    return { name: v.name, units: us, outcome, crashes: us.map(crashed), d7: us.filter(d7Eligible).map((u) => eventsOf(u).some((x) => x.type !== "exposure" && Date.parse(x.at) >= u.at + 7 * DAY && Date.parse(x.at) < u.at + 8 * DAY)) };
  });
  const control = raws.find((r) => r.name === "control")!;
  const rng = seeded(`${e.id}:${units.size}`);

  const probBetter = (r: Raw): number => {
    if (e.metric.kind === "revenue_per_user") return probabilityMeanGreater(control.outcome as number[], r.outcome as number[], rng);
    const c = evaluateProportionExperiment(control.outcome as boolean[], r.outcome as boolean[], rng, { minNPerArm: 1, monteCarloDraws: 4000 });
    return c.sufficientPower ? c.posteriorProbabilityTreatmentBetter : 0.5;
  };
  const value = (r: Raw): number | null =>
    e.metric.kind === "revenue_per_user" ? (r.outcome.length ? (r.outcome as number[]).reduce((a, b) => a + b, 0) / r.outcome.length : null) : share(r.outcome as boolean[]);

  const armResults: ArmResult[] = raws.map((r) => ({
    name: r.name,
    n: r.units.length,
    value: value(r),
    probBetter: r === control ? null : r.outcome.length && control.outcome.length ? probBetter(r) : null,
    crashRate: share(r.crashes),
    d7: share(r.d7),
    d7n: r.d7.length,
  }));

  // Guardrails, checked as soon as arms have a few users.
  let guardrail: Guardrail | null = null;
  for (const r of raws) {
    if (r === control || guardrail) continue;
    if (r.units.length >= Math.min(GUARDRAIL_MIN_N, e.minPerArm) && control.units.length >= Math.min(GUARDRAIL_MIN_N, e.minPerArm)) {
      const p = evaluateProportionExperiment(control.crashes, r.crashes, rng, { minNPerArm: 1, monteCarloDraws: 4000 }).posteriorProbabilityTreatmentBetter;
      const vr = share(r.crashes)!;
      const cr = share(control.crashes)!;
      if (p >= GUARDRAIL_AT && vr - cr >= CRASH_MARGIN) guardrail = { what: "crash_rate", variant: r.name, value: vr, control: cr, prob: p };
    }
    if (!guardrail && e.guardrails.retentionD7 && r.d7.length >= Math.max(30, e.minPerArm / 2) && control.d7.length >= Math.max(30, e.minPerArm / 2)) {
      const p = 1 - evaluateProportionExperiment(control.d7, r.d7, rng, { minNPerArm: 1, monteCarloDraws: 4000 }).posteriorProbabilityTreatmentBetter;
      if (p >= GUARDRAIL_AT) guardrail = { what: "retention_d7", variant: r.name, value: share(r.d7)!, control: share(control.d7)!, prob: p };
    }
  }

  const sampleN = (r: Raw) => r.outcome.length;
  const enough = raws.every((r) => sampleN(r) >= e.minPerArm);
  const days = e.startedAt ? (now - Date.parse(e.startedAt)) / DAY : 0;
  const others = armResults.filter((a) => a.name !== "control");
  const best = others.reduce<ArmResult | null>((b, a) => (b === null || (a.probBetter ?? 0) > (b.probBetter ?? 0) ? a : b), null);
  let verdict: ExperimentResult["verdict"] = "collecting";
  let winner: string | null = null;
  if (guardrail) {
    verdict = "worse";
    winner = "control";
  } else if (enough && best && (best.probBetter ?? 0) >= DECIDE_AT) {
    verdict = "better";
    winner = best.name;
  } else if (enough && others.every((a) => (a.probBetter ?? 1) <= 1 - DECIDE_AT)) {
    verdict = "worse";
    winner = "control";
  } else if (days >= e.maxDays) {
    verdict = "no_clear_change";
    winner = "control";
  }
  const result: ExperimentResult = { at: input.now.toISOString(), arms: armResults, verdict, winner, guardrail, enough, currency: e.metric.kind === "revenue_per_user" ? currency : null, note: "" };
  return { ...result, note: describeResult(e, result) };
}

// ---------------------------------------------------------------------------
// Plain words
// ---------------------------------------------------------------------------

const pct = (x: number | null) => (x === null ? "–" : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);
export const formatValue = (m: Metric, x: number | null, currency: string | null) =>
  x === null ? "–" : m.kind === "revenue_per_user" ? `${x.toFixed(2)} ${currency ?? ""}`.trim() : pct(x);

export function describeResult(e: Experiment, r: ExperimentResult): string {
  const c = r.arms.find((a) => a.name === "control");
  const fmt = (x: number | null) => formatValue(e.metric, x, r.currency);
  const label = metricLabel(e.metric);
  if (r.guardrail) {
    const g = r.guardrail;
    return g.what === "crash_rate"
      ? `"${g.variant}" crashed for ${pct(g.value)} of users vs ${pct(g.control)} with control (${Math.round(g.prob * 100)}% sure it's worse) — stopped to protect users.`
      : `"${g.variant}" kept fewer users after a week: ${pct(g.value)} vs ${pct(g.control)} (${Math.round(g.prob * 100)}% sure) — money isn't worth losing users, so it's stopped.`;
  }
  const arms = r.arms
    .filter((a) => a.name !== "control")
    .map((a) => `"${a.name}" ${fmt(a.value)} (${a.n} users${a.probBetter !== null ? `, ${Math.round(a.probBetter * 100)}% likely better` : ""})`)
    .join("; ");
  const base = `${label[0]!.toUpperCase()}${label.slice(1)}: control ${fmt(c?.value ?? null)} (${c?.n ?? 0} users); ${arms}.`;
  if (r.verdict === "better") return `"${r.winner}" is better. ${base}`;
  if (r.verdict === "worse") return `The new version${r.arms.length > 2 ? "s are" : " is"} worse than control. ${base}`;
  if (r.verdict === "no_clear_change") return `No clear change after ${e.maxDays} days${r.enough ? "" : ` (fewer than ${e.minPerArm} users per version)`}; control stays. ${base}`;
  return `Collecting: ${r.enough ? "enough users, not yet a clear answer" : `needs ${e.minPerArm} users per version`}. ${base}`;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** The winner becomes the default; the experiment leaves the config. Returns the cleanup ticket when code must go. */
export function promote(state: LiveState, id: string, by: "day2" | "owner", now: Date): { state: LiveState; cleanup: ReturnType<typeof cleanupTicket> | null } {
  const e = state.experiments.find((x) => x.id === id);
  if (!e) throw new Error(`No experiment ${id}.`);
  if (e.state !== "decided" && e.state !== "running") throw new Error(`${id} can't be kept now (it's ${e.state}).`);
  const winner = e.decision?.winner ?? e.result?.winner ?? null;
  if (!winner) throw new Error(`${id} has no winner yet.`);
  const at = now.toISOString();
  const won = e.variants.find((v) => v.name === winner)!;
  const values = { ...state.values };
  for (const [k, v] of Object.entries(won.values)) values[k] = { value: v, by: "experiment", at, note: `Kept from ${id} ("${winner}")` };
  const next: Experiment = {
    ...e,
    state: "promoted",
    endedAt: at,
    decision: e.decision ?? { verdict: e.result?.verdict ?? "no_clear_change", winner, at, by, note: e.result?.note ?? "" },
  };
  let s = putExperiment({ ...state, values }, next, now);
  const changed = Object.keys(won.values).length;
  s = addLog(
    s,
    now,
    winner === "control"
      ? `${id} ended: control stays (${by === "day2" ? "day2" : "you"} decided). ${e.result?.note ?? ""}`.trim()
      : `${id}: "${winner}" is now everyone's default (${changed} setting${changed === 1 ? "" : "s"}; ${by === "day2" ? "day2" : "you"} decided). ${e.result?.note ?? ""}`.trim(),
    id,
  );
  // Code paths that only a losing version used go: only when code was built for the test.
  return { state: s, cleanup: e.configOnly ? null : cleanupTicket(e, winner) };
}

export function stop(state: LiveState, id: string, reason: string, now: Date): { state: LiveState; cleanup: ReturnType<typeof cleanupTicket> | null } {
  const e = state.experiments.find((x) => x.id === id);
  if (!e) throw new Error(`No experiment ${id}.`);
  if (e.state === "promoted" || e.state === "stopped") throw new Error(`${id} has already ended.`);
  const built = !e.configOnly && (e.state === "waiting" || e.state === "running" || e.state === "decided");
  let s = putExperiment(state, { ...e, state: "stopped", endedAt: now.toISOString(), stopReason: reason }, now);
  s = addLog(s, now, `${id} stopped: ${reason} Everyone gets control.`, id);
  return { state: s, cleanup: built ? cleanupTicket(e, "control") : null };
}
