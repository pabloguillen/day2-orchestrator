import { resolve } from "node:path";
import type { AppEntry } from "../apps-registry";
import { createTicket, findTicket, rankBacklog, withBacklog, type Backlog, type NewTicketInput } from "../backlog";
import { backlogFile } from "../backlog-work";
import { CreditsError } from "../credits";
import { indexRepo } from "../distribution-loops";
import { appKind } from "../field-work";
import { loadReleases, RELEASES_FILENAME, storeKey, updateKey } from "../mobile-release/pass";
import type { ReleasesFile } from "../mobile-release/types";
import type { EventLike } from "../metrics/types";
import type { AppProfile } from "../onboarding";
import type { RetentionSnapshot } from "../retention";
import { addExperiment, buildTicket, keysInCode, measure, promote, putExperiment, stop, type Crash, type ExperimentInput } from "./experiments";
import { addIdeas, codeSummary, IDEAS_EVERY_DAYS, leakFrom, numbersFrom, type IdeaDraft, type IdeaInput } from "./ideas";
import { missingNative, nativeTicket, openNativeTicket } from "./native-foundations";
import type { LiveStore } from "./store";
import { ACTIVE_STATES, addLog, type Experiment, type LiveState } from "./types";

/**
 * Live's pass for one app (on the growth autopilot's timer): the native
 * foundations ticket when packages are missing, each experiment one step
 * along its lifecycle, and — when there's room — the next experiment from
 * the best idea. Idempotent; cheap when nothing changed.
 */

const DAY = 86_400_000;

export type LivePassDeps = {
  store: LiveStore;
  events: (since: Date) => Promise<EventLike[]>;
  crashes: (since: Date) => Promise<Crash[]>;
  /** Devices that reported any of these release keys since (field-store releaseHealth). */
  releaseDevices: (keys: string[], since: Date) => Promise<number>;
  retention: () => Promise<RetentionSnapshot | null>;
  /** The idea agent (paid from credits); absent = no new ideas this pass. */
  ideas?: (input: IdeaInput) => Promise<{ ideas: IdeaDraft[]; credits: number }>;
  /** The mobile releases file (default: the app's day2-mobile-releases.json). */
  releases?: () => ReleasesFile;
  log: (text: string, credits?: number) => void;
  now: Date;
};

export type LivePassReport = { ticketsCreated: string[]; started: string[]; decided: string[]; promoted: string[]; stopped: string[]; ideas: number; skipped: string[] };

/** The settings the app's code reads from Live (day2.value / useDay2Value). */
export function codeKeysOf(repoPath: string): Set<string> {
  const repo = indexRepo(repoPath);
  return keysInCode(repo.files.filter((f) => /\.(t|j)sx?$/.test(f) && !/(\.d\.ts|day2\/)/.test(f)).map((file) => ({ file, text: repo.read(file) })));
}

/** A ticket by its source key: the one already there, or a new one. */
export const addTicket = (app: AppEntry, input: NewTicketInput & { source: { key: string } }, now: Date) =>
  withBacklog(backlogFile(app), (b: Backlog) => {
    const have = b.tickets.find((t) => t.source.key === input.source.key);
    if (have) return { backlog: b, result: { ...have, created: false } };
    const r = createTicket(b, input, now);
    return { backlog: rankBacklog(r.backlog, now).backlog, result: { ...r.ticket, created: true } };
  });

/**
 * Starts an experiment (owner's Start or Approve, or day2's own): config-only
 * ones run at once; others get their build ticket first. With "ask me first",
 * day2's own experiments wait for the owner's OK.
 */
export async function startExperiment(app: AppEntry, store: LiveStore, id: string, opts: { by: "day2" | "owner"; now: Date; codeKeys?: Set<string> }): Promise<Experiment> {
  const codeKeys = opts.codeKeys ?? codeKeysOf(app.repoPath);
  const current = (await store.get(app.id)).experiments.find((e) => e.id === id);
  if (!current) throw new Error(`No experiment ${id}.`);
  if (current.state !== "draft" && current.state !== "to_approve") throw new Error(`${id} has already started.`);
  const s0 = await store.get(app.id);
  const configOnly = current.keys.every((k) => codeKeys.has(k));
  const askFirst = opts.by === "day2" && s0.settings.autonomy === "ask_first";
  let ticketId: string | null = null;
  if (!askFirst && !configOnly) ticketId = (await addTicket(app, buildTicket(current, s0, codeKeys), opts.now)).id;
  return store.update(app.id, (s) => {
    const e = s.experiments.find((x) => x.id === id)!;
    const at = opts.now.toISOString();
    const next: Experiment = askFirst
      ? { ...e, configOnly, state: "to_approve" }
      : configOnly
        ? { ...e, configOnly, state: "running", startedAt: at }
        : { ...e, configOnly, state: "building", ticketId };
    const text = askFirst
      ? `${id} ("${e.title}") is ready — waiting for your OK on the Live page.`
      : configOnly
        ? `${id} ("${e.title}") started: the app already reads ${e.keys.join(", ")}, so it reaches users with their next launch. Goal: ${e.metric.kind === "event" ? e.metric.event : e.metric.kind}.`
        : `${id} ("${e.title}") needs the app to read ${e.keys.filter((k) => !codeKeys.has(k)).join(", ")} — added ${ticketId} for the build agent; it starts once that update reaches users.`;
    return { state: addLog(putExperiment(s, next, opts.now), opts.now, text, id), result: { ...next } };
  });
}

/** The release that carries a ticket's change, when it's out (update rolling out or done; store build released). */
export function releaseFor(file: ReleasesFile, ticketId: string): { keys: string[]; label: string } | null {
  for (const r of [file.current, ...file.history]) {
    if (!r || !r.changes.some((c) => c.ticketId === ticketId)) continue;
    if (r.kind === "update" && (r.status === "rolling_out" || r.status === "done")) {
      const keys = Object.values(r.updateIds).filter((x): x is string => Boolean(x)).map(updateKey);
      if (keys.length) return { keys, label: `over-the-air update ${keys.join(", ")} (${r.percent}% of users)` };
    }
    if (r.kind === "store" && (r.status === "done" || Object.values(r.platforms).some((p) => p && (p.stage === "rolling_out" || p.stage === "released")))) {
      const keys = Object.values(r.builds).map((b) => storeKey(r.version, b?.buildNumber ?? null));
      return { keys: [...new Set(keys.length ? keys : [storeKey(r.version, null)])], label: `store release ${r.version}` };
    }
  }
  return null;
}

export async function livePass(app: AppEntry, profile: AppProfile | null, deps: LivePassDeps): Promise<LivePassReport> {
  const report: LivePassReport = { ticketsCreated: [], started: [], decided: [], promoted: [], stopped: [], ideas: 0, skipped: [] };
  if (appKind(app.repoPath) !== "react-native") return report;
  const now = deps.now;

  // 1. Native foundations: one ticket for everything native that's missing.
  const missing = await missingNative(app);
  if (missing.length) {
    const open = await withBacklog(backlogFile(app), (b) => ({ backlog: b, result: openNativeTicket(b) }));
    if (!open) {
      const t = await addTicket(app, nativeTicket(app, missing), now);
      if (t.created) {
        report.ticketsCreated.push(t.id);
        deps.log(`The app is missing ${missing.flatMap((m) => m.packages).join(", ")} — added ${t.id} so they reach users in one store release; after that, changes go over the air.`);
      }
    }
  }

  const codeKeys = codeKeysOf(app.repoPath);
  const backlog = await withBacklog(backlogFile(app), (b) => ({ backlog: b, result: b }));
  const releases = deps.releases?.() ?? loadReleases(resolve(app.repoPath, RELEASES_FILENAME));
  let state = await deps.store.get(app.id);
  const firstLogBefore = state.log[0];

  // 2. Each experiment one step along.
  const oldest = state.experiments.filter((e) => e.state === "running" || e.state === "waiting").map((e) => Date.parse(e.startedAt ?? e.updatedAt));
  const since = new Date(Math.min(now.getTime() - 30 * DAY, ...oldest) - DAY);
  let events: EventLike[] | null = null;
  let crashes: Crash[] | null = null;
  const loadEvents = async () => (events ??= await deps.events(since));
  const loadCrashes = async () => (crashes ??= await deps.crashes(since));
  const cleanups: Array<NewTicketInput & { source: { key: string } }> = [];

  for (const e0 of state.experiments) {
    let e = e0;
    if (e.state === "building") {
      const t = e.ticketId ? findTicket(backlog, e.ticketId) : undefined;
      if (!t) {
        const r = stop(state, e.id, `its build ticket ${e.ticketId} is gone.`, now);
        state = r.state;
        report.stopped.push(e.id);
        continue;
      }
      if (t.state === "parked") {
        const r = stop(state, e.id, `the code change (${t.id}) was declined.`, now);
        state = r.state;
        report.stopped.push(e.id);
        continue;
      }
      if (t.state !== "done") continue;
      e = { ...e, state: "waiting" };
      state = addLog(putExperiment(state, e, now), now, `${e.id}: ${t.id} is merged — waiting for the update with it to reach users.`, e.id);
    }
    if (e.state === "waiting") {
      const rel = e.ticketId ? releaseFor(releases, e.ticketId) : null;
      if (rel && !e.release) {
        e = { ...e, release: { ...rel, at: now.toISOString() } };
        state = putExperiment(state, e, now);
      }
      const exposures = (await loadEvents()).filter((x) => x.type === "exposure" && x.props?.exp === e.id);
      const devices = e.release ? await deps.releaseDevices(e.release.keys, new Date(Date.parse(e.release.at) - DAY)) : 0;
      if (exposures.length || devices > 0) {
        const first = exposures.map((x) => x.at).sort()[0] ?? now.toISOString();
        e = { ...e, state: "running", startedAt: first };
        state = addLog(putExperiment(state, e, now), now, `${e.id} is running: ${exposures.length ? "the first users have seen it" : `${devices} device${devices === 1 ? "" : "s"} run ${e.release!.label}`}.`, e.id);
        report.started.push(e.id);
      }
      continue;
    }
    if (e.state !== "running") continue;
    const result = measure(e, { events: await loadEvents(), crashes: await loadCrashes(), now });
    e = { ...e, result };
    state = putExperiment(state, e, now);
    if (result.guardrail) {
      const r = stop(state, e.id, result.note, now);
      state = r.state;
      if (r.cleanup) cleanups.push(r.cleanup);
      report.stopped.push(e.id);
      continue;
    }
    if (result.verdict === "collecting") continue;
    e = { ...e, state: "decided", decision: { verdict: result.verdict, winner: result.winner, at: now.toISOString(), by: "day2", note: result.note } };
    state = addLog(putExperiment(state, e, now), now, `${e.id} decided: ${result.note}`, e.id);
    report.decided.push(e.id);
    if (state.settings.autonomy === "day2_decides" && e.configOnly) {
      const r = promote(state, e.id, "day2", now);
      state = r.state;
      if (r.cleanup) cleanups.push(r.cleanup);
      report.promoted.push(e.id);
    }
  }
  const settled = state;
  // Merged into what's stored now (the owner may have changed something meanwhile).
  const cut = firstLogBefore ? settled.log.indexOf(firstLogBefore) : -1;
  const newLog = cut === -1 ? settled.log : settled.log.slice(0, cut);
  await deps.store.update(app.id, (cur) => ({
    state: {
      ...cur,
      experiments: cur.experiments.map((x) => settled.experiments.find((y) => y.id === x.id && y.updatedAt >= x.updatedAt) ?? x),
      values: { ...cur.values, ...Object.fromEntries(Object.entries(settled.values).filter(([k, v]) => v.by === "experiment" && cur.values[k]?.at !== v.at)) },
      log: [...newLog, ...cur.log].slice(0, 200),
    },
    result: null,
  }));
  for (const c of cleanups) {
    const t = await addTicket(app, c, now);
    report.ticketsCreated.push(t.id);
    await deps.store.update(app.id, (cur) => {
      const id = c.source.key.split(":").pop()!;
      const x = cur.experiments.find((y) => y.id === id);
      return { state: x ? addLog(putExperiment(cur, { ...x, cleanupTicketId: t.id }, now), now, `Added ${t.id} to remove code only the losing version used.`, id) : cur, result: null };
    });
  }

  // 3. The next experiment, when there's room.
  state = await deps.store.get(app.id);
  const active = state.experiments.filter((e) => ACTIVE_STATES.includes(e.state) || e.state === "to_approve").length;
  if (active >= state.settings.maxActive) return report;
  let fresh = state.ideas.filter((i) => i.status === "new" && !i.fromOwner);
  const ideasDue = !state.ideasAt || now.getTime() - Date.parse(state.ideasAt) >= IDEAS_EVERY_DAYS * DAY;
  if (!fresh.length && ideasDue && deps.ideas) {
    try {
      const evs = await loadEvents();
      const r = await deps.ideas({
        appName: app.name,
        profile,
        code: codeSummary(app.repoPath, codeKeys),
        values: Object.fromEntries(Object.entries(state.values).map(([k, v]) => [k, v.value])),
        numbers: numbersFrom(evs.filter((x) => Date.parse(x.at) >= now.getTime() - 30 * DAY)),
        leak: leakFrom(await deps.retention()),
        tried: state.experiments.map((x) => x.title),
      });
      const added = await deps.store.update(app.id, (cur) => {
        const a = addIdeas({ ...cur, ideasAt: now.toISOString() }, r.ideas, now);
        return { state: a.ideas.length ? addLog(a.state, now, `Thought of ${a.ideas.length} experiment idea${a.ideas.length === 1 ? "" : "s"} from the app's code and numbers.`) : a.state, result: a.ideas };
      });
      deps.log(added.length ? `Live: ${added.length} new experiment idea${added.length === 1 ? "" : "s"}.` : "Live: no experiment idea good enough this time.", r.credits);
      report.ideas = added.length;
      fresh = added;
    } catch (err) {
      const why = err instanceof CreditsError ? err.message : (err as Error).message;
      report.skipped.push(`live ideas: ${why}`);
      deps.log(`Live ideas skipped: ${why}`);
    }
  }
  // Settings the code already reads first: they start without a build.
  const pick = [...fresh].sort((a, b) => Number(b.keys.every((k) => codeKeys.has(k))) - Number(a.keys.every((k) => codeKeys.has(k))))[0];
  if (!pick) return report;
  let created: Experiment;
  try {
    created = await deps.store.update(app.id, (cur) => {
      const input: ExperimentInput = { title: pick.title, hypothesis: pick.hypothesis, keys: pick.keys, variants: pick.variants, metric: pick.metric, ...(pick.audience ? { audience: pick.audience } : {}), createdBy: "day2", ideaId: pick.id };
      const r = addExperiment(cur, input, codeKeys, now);
      const ideas = r.state.ideas.map((i) => (i.id === pick.id ? { ...i, status: "used" as const, experimentId: r.experiment.id } : i));
      return { state: { ...r.state, ideas }, result: r.experiment };
    });
  } catch (err) {
    await deps.store.update(app.id, (cur) => ({ state: { ...cur, ideas: cur.ideas.map((i) => (i.id === pick.id ? { ...i, status: "dismissed" as const } : i)) }, result: null }));
    report.skipped.push(`live idea ${pick.id}: ${(err as Error).message}`);
    return report;
  }
  const started = await startExperiment(app, deps.store, created.id, { by: "day2", now, codeKeys });
  if (started.ticketId) report.ticketsCreated.push(started.ticketId);
  if (started.state === "running") report.started.push(started.id);
  deps.log(`Live: ${started.id} "${started.title}" — ${started.state === "to_approve" ? "waiting for your OK" : started.state === "running" ? "running" : `building (${started.ticketId})`}.`);
  return report;
}
