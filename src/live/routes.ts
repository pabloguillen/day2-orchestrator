import type { AppEntry } from "../apps-registry";
import type { CreditService } from "../credits";
import { APP_PROFILE_FILENAME, loadAppProfile } from "../onboarding";
import { resolve } from "node:path";
import { fieldStore, type Tenant } from "../tenant";
import type { Json } from "../../packages/sensors/src/types";
import { addExperiment, KEY_RE, metricLabel, promote, putExperiment, stop, type ExperimentInput } from "./experiments";
import { addIdeas, codeSummary, IDEAS_MAX_USD, leakFrom, numbersFrom, proposeIdeas, type IdeaInput } from "./ideas";
import { addTicket, codeKeysOf, startExperiment } from "./pass";
import { liveStore } from "./runtime";
import { addLog, type LiveSettings, type LiveState, type Metric, type Variant } from "./types";

/**
 * The Live API (/api/apps/:id/live/*), registered from api-server.ts with
 * one line. The console's Live page reads and changes everything here.
 */

type Handler = (req: Request, params: Record<string, string>, t: Tenant) => Promise<Response> | Response;

export type LiveRouteHelpers = {
  json: (data: unknown, init?: ResponseInit) => Response;
  requireApp: (t: Tenant, id: string) => Promise<AppEntry>;
  runWithCredits: <T>(t: Tenant, app: AppEntry, service: CreditService, description: string, maxCostUsd: number, fn: () => Promise<T>) => Promise<{ result: T; credits: number }>;
  httpError: (status: number, message: string) => Error;
};

const DAY = 86_400_000;
const MAX_VALUE_BYTES = 4000;

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = (await req.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function view(s: LiveState, codeKeys: Set<string>) {
  return {
    values: Object.entries(s.values)
      .map(([key, v]) => ({ key, ...v, inCode: codeKeys.has(key) }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    codeKeys: [...codeKeys].sort(),
    experiments: [...s.experiments].reverse().map((e) => ({ ...e, metricLabel: metricLabel(e.metric) })),
    ideas: s.ideas.filter((i) => i.status === "new"),
    settings: s.settings,
    log: s.log.slice(0, 50),
  };
}

function metricFrom(v: unknown): Metric | null {
  const m = (v ?? {}) as Record<string, unknown>;
  if (m.kind === "event" && typeof m.event === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(m.event)) return { kind: "event", event: m.event };
  if (m.kind === "retention_d7" || m.kind === "revenue_per_user") return { kind: m.kind };
  return null;
}

export function registerLiveRoutes(route: (method: string, pathname: string, handler: Handler) => void, h: LiveRouteHelpers): void {
  const { json, requireApp, httpError } = h;
  const store = () => liveStore();
  const fail = (err: unknown) => httpError(400, (err as Error).message);

  async function ideaInput(app: AppEntry, s: LiveState, codeKeys: Set<string>, ownerWords?: string): Promise<IdeaInput> {
    const now = Date.now();
    const events = await fieldStore()
      .events(app.id, new Date(now - 30 * DAY))
      .catch(() => []);
    const profile = loadAppProfile(resolve(app.repoPath, APP_PROFILE_FILENAME));
    return {
      appName: app.name,
      profile,
      code: codeSummary(app.repoPath, codeKeys),
      values: Object.fromEntries(Object.entries(s.values).map(([k, v]) => [k, v.value])),
      numbers: numbersFrom(events),
      leak: leakFrom(await fieldStore().retention(app.id).catch(() => null)),
      tried: s.experiments.map((e) => e.title),
      ...(ownerWords ? { ownerWords } : {}),
    };
  }

  const respond = async (app: AppEntry) => json(view(await store().get(app.id), codeKeysOf(app.repoPath)));

  route("GET", "/api/apps/:id/live", async (_req, p, t) => respond(await requireApp(t, p.id!)));

  route("PUT", "/api/apps/:id/live/values/:key", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    const key = decodeURIComponent(p.key!);
    if (!KEY_RE.test(key)) throw httpError(400, "A setting name has letters, digits, dots and dashes, and starts with a letter.");
    const b = await body(req);
    if (!("value" in b)) throw httpError(400, "Send the value.");
    const value = b.value as Json;
    if (JSON.stringify(value).length > MAX_VALUE_BYTES) throw httpError(400, "That value is too large (4 KB at most).");
    const now = new Date();
    await store().update(app.id, (s) => {
      if (s.experiments.some((e) => e.keys.includes(key) && ["building", "waiting", "running", "decided"].includes(e.state)))
        throw httpError(409, `"${key}" is being tested right now — stop or finish the experiment first.`);
      const note = typeof b.note === "string" ? b.note.slice(0, 200) : s.values[key]?.note;
      return { state: addLog({ ...s, values: { ...s.values, [key]: { value, by: "owner", at: now.toISOString(), ...(note ? { note } : {}) } } }, now, `You set "${key}" to ${JSON.stringify(value).slice(0, 80)}. Apps get it on their next launch.`), result: null };
    });
    return respond(app);
  });

  route("DELETE", "/api/apps/:id/live/values/:key", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    const key = decodeURIComponent(p.key!);
    const now = new Date();
    await store().update(app.id, (s) => {
      const { [key]: _gone, ...values } = s.values;
      return { state: addLog({ ...s, values }, now, `You removed "${key}": the app uses its own default again.`), result: null };
    });
    return respond(app);
  });

  route("PUT", "/api/apps/:id/live/settings", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    const b = await body(req);
    const now = new Date();
    await store().update(app.id, (s) => {
      const settings: LiveSettings = {
        autonomy: b.autonomy === "ask_first" || b.autonomy === "day2_decides" ? b.autonomy : s.settings.autonomy,
        maxActive: Number.isInteger(b.maxActive) && (b.maxActive as number) >= 0 && (b.maxActive as number) <= 5 ? (b.maxActive as number) : s.settings.maxActive,
      };
      const words = settings.autonomy === "ask_first" ? "day2 asks you before starting or keeping an experiment" : "day2 starts and keeps settings-only experiments by itself";
      return { state: addLog({ ...s, settings }, now, `Settings: ${words}; at most ${settings.maxActive} at once.`), result: null };
    });
    return respond(app);
  });

  // An experiment written out by the owner (structured).
  route("POST", "/api/apps/:id/live/experiments", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    const b = await body(req);
    const metric = metricFrom(b.metric);
    if (!metric) throw httpError(400, "Pick a goal: an event, coming back after a week, or revenue per user.");
    const input: ExperimentInput = {
      title: String(b.title ?? ""),
      hypothesis: String(b.hypothesis ?? ""),
      keys: Array.isArray(b.keys) ? b.keys.map(String) : [],
      variants: Array.isArray(b.variants) ? (b.variants as Variant[]) : [],
      metric,
      createdBy: "owner",
      ...(typeof b.minPerArm === "number" ? { minPerArm: b.minPerArm } : {}),
      ...(typeof b.maxDays === "number" ? { maxDays: b.maxDays } : {}),
    };
    const codeKeys = codeKeysOf(app.repoPath);
    try {
      await store().update(app.id, (s) => {
        const r = addExperiment(s, input, codeKeys, new Date());
        return { state: addLog(r.state, new Date(), `You wrote down ${r.experiment.id} ("${r.experiment.title}").`, r.experiment.id), result: r.experiment };
      });
    } catch (err) {
      throw fail(err);
    }
    return respond(app);
  });

  // "Describe an experiment": the owner's words, written up by the agent as a draft.
  route("POST", "/api/apps/:id/live/describe", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    const text = String((await body(req)).text ?? "").trim();
    if (text.length < 10) throw httpError(400, "Say in a sentence or two what you'd like to try.");
    const codeKeys = codeKeysOf(app.repoPath);
    const s0 = await store().get(app.id);
    const input = await ideaInput(app, s0, codeKeys, text.slice(0, 1500));
    const { result: drafts, credits } = await h.runWithCredits(t, app, "agent_work", "Live: write up an experiment", IDEAS_MAX_USD, () => proposeIdeas(input));
    const d = drafts[0];
    if (!d) throw httpError(422, "day2 couldn't turn that into an experiment — try naming what should change and what should get better.");
    const now = new Date();
    let id = "";
    try {
      id = await store().update(app.id, (s) => {
        const r = addExperiment(s, { ...d, createdBy: "owner" }, codeKeys, now);
        return { state: addLog(r.state, now, `Wrote up ${r.experiment.id} ("${r.experiment.title}") from your description — check it and press Start.`, r.experiment.id), result: r.experiment.id };
      });
    } catch (err) {
      throw fail(err);
    }
    return json({ ...view(await store().get(app.id), codeKeys), created: id, credits });
  });

  route("POST", "/api/apps/:id/live/ideas", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    const codeKeys = codeKeysOf(app.repoPath);
    const s0 = await store().get(app.id);
    const input = await ideaInput(app, s0, codeKeys);
    const { result: drafts, credits } = await h.runWithCredits(t, app, "agent_work", "Live: experiment ideas", IDEAS_MAX_USD, () => proposeIdeas(input));
    const now = new Date();
    await store().update(app.id, (s) => {
      const a = addIdeas({ ...s, ideasAt: now.toISOString() }, drafts, now);
      return { state: addLog(a.state, now, `Thought of ${a.ideas.length} experiment idea${a.ideas.length === 1 ? "" : "s"}.`), result: null };
    });
    return json({ ...view(await store().get(app.id), codeKeys), credits });
  });

  route("POST", "/api/apps/:id/live/ideas/:idea/:action", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    const action = p.action;
    if (action !== "use" && action !== "dismiss") throw httpError(404, "Unknown action.");
    const now = new Date();
    const codeKeys = codeKeysOf(app.repoPath);
    let created: string | null = null;
    try {
      created = await store().update(app.id, (s) => {
        const idea = s.ideas.find((i) => i.id === p.idea);
        if (!idea || idea.status !== "new") throw new Error("That idea is gone.");
        if (action === "dismiss") return { state: { ...s, ideas: s.ideas.map((i) => (i.id === idea.id ? { ...i, status: "dismissed" as const } : i)) }, result: null };
        const r = addExperiment(s, { title: idea.title, hypothesis: idea.hypothesis, keys: idea.keys, variants: idea.variants, metric: idea.metric, createdBy: "owner", ideaId: idea.id }, codeKeys, now);
        const ideas = r.state.ideas.map((i) => (i.id === idea.id ? { ...i, status: "used" as const, experimentId: r.experiment.id } : i));
        return { state: { ...r.state, ideas }, result: r.experiment.id };
      });
    } catch (err) {
      throw fail(err);
    }
    if (created) await startExperiment(app, store(), created, { by: "owner", now, codeKeys });
    return respond(app);
  });

  route("POST", "/api/apps/:id/live/experiments/:xid/:action", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    const id = p.xid!;
    const now = new Date();
    const codeKeys = codeKeysOf(app.repoPath);
    try {
      if (p.action === "start" || p.action === "approve") {
        await startExperiment(app, store(), id, { by: "owner", now, codeKeys });
      } else if (p.action === "stop") {
        const why = String((await body(req)).reason ?? "").trim().slice(0, 200);
        const cleanup = await store().update(app.id, (s) => {
          const r = stop(s, id, why ? `you stopped it (${why}).` : "you stopped it.", now);
          return { state: r.state, result: r.cleanup };
        });
        if (cleanup) {
          const tk = await addTicket(app, cleanup, now);
          await store().update(app.id, (s) => {
            const e = s.experiments.find((x) => x.id === id)!;
            return { state: putExperiment(s, { ...e, cleanupTicketId: tk.id }, now), result: null };
          });
        }
      } else if (p.action === "promote") {
        const b = await body(req);
        const cleanup = await store().update(app.id, (s) => {
          let cur = s;
          const e = cur.experiments.find((x) => x.id === id);
          // The owner may pick the winner (e.g. keep a version that's "no clear change" but they prefer).
          if (e && typeof b.winner === "string") {
            if (!e.variants.some((v) => v.name === b.winner)) throw new Error(`${id} has no version "${b.winner}".`);
            cur = putExperiment(cur, { ...e, decision: { verdict: e.result?.verdict ?? "no_clear_change", winner: b.winner, at: now.toISOString(), by: "owner", note: e.result?.note ?? "" } }, now);
          }
          const r = promote(cur, id, "owner", now);
          return { state: r.state, result: r.cleanup };
        });
        if (cleanup) {
          const tk = await addTicket(app, cleanup, now);
          await store().update(app.id, (s) => {
            const e = s.experiments.find((x) => x.id === id)!;
            return { state: putExperiment(s, { ...e, cleanupTicketId: tk.id }, now), result: null };
          });
        }
      } else if (p.action === "delete") {
        await store().update(app.id, (s) => {
          const e = s.experiments.find((x) => x.id === id);
          if (!e || (e.state !== "draft" && e.state !== "to_approve")) throw new Error("Only experiments that haven't started can be deleted.");
          return { state: addLog({ ...s, experiments: s.experiments.filter((x) => x.id !== id) }, now, `${id} deleted.`), result: null };
        });
      } else throw httpError(404, "Unknown action.");
    } catch (err) {
      if ((err as { status?: number }).status) throw err;
      throw fail(err);
    }
    return respond(app);
  });
}
