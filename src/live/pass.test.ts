import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import { loadBacklog, saveBacklog, putTicket, findTicket } from "../backlog";
import { backlogFile } from "../backlog-work";
import type { EventLike } from "../metrics/types";
import type { ReleasesFile } from "../mobile-release/types";
import { DEFAULT_SETTINGS } from "../mobile-release/types";
import { parseIdeas, ideaPrompt, type IdeaDraft, type IdeaInput } from "./ideas";
import { livePass, releaseFor, startExperiment, type LivePassDeps } from "./pass";
import { registerNativeNeed, resetNativeNeeds } from "./native-foundations";
import { fileLiveStore, type LiveStore } from "./store";
import { addExperiment } from "./experiments";

const DAY = 86_400_000;
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function makeApp(opts: { deps?: Record<string, string>; code?: string } = {}): { app: AppEntry; store: LiveStore } {
  const dir = mkdtempSync(join(tmpdir(), "day2-live-pass-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "dotty", dependencies: { expo: "54.0.0", "react-native": "0.81.0", ...(opts.deps ?? { "expo-updates": "1", "@react-native-async-storage/async-storage": "2", "expo-application": "6" }) } }));
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "app", "index.tsx"), opts.code ?? 'export default function Home() { const t = useDay2Value("onboarding.title", "Welcome"); return t; }');
  const app = { id: "app_dotty", name: "Dotty", repoPath: dir, connectionMethod: "local", addedAt: "2026-10-01T00:00:00Z" } as AppEntry;
  return { app, store: fileLiveStore(async () => join(dir, "day2-live.json")) };
}

const IDEA: IdeaDraft = {
  title: "Shorter welcome",
  hypothesis: "If the welcome title is shorter, more people add their first dot.",
  why: "Only 20% add a dot on day one.",
  keys: ["onboarding.title"],
  variants: [
    { name: "control", weight: 50, values: {} },
    { name: "short", weight: 50, values: { "onboarding.title": "Hi" } },
  ],
  metric: { kind: "event", event: "dot_added" },
};

function deps(store: LiveStore, now: Date, over: Partial<LivePassDeps> = {}): LivePassDeps & { logs: string[]; prompts: IdeaInput[] } {
  const logs: string[] = [];
  const prompts: IdeaInput[] = [];
  return {
    store,
    events: async () => [],
    crashes: async () => [],
    releaseDevices: async () => 0,
    retention: async () => null,
    ideas: async (input) => {
      prompts.push(input);
      return { ideas: [IDEA], credits: 3 };
    },
    releases: () => ({ enabled: true, settings: DEFAULT_SETTINGS, shipped: null, current: null, history: [] }),
    log: (t) => logs.push(t),
    now,
    logs,
    prompts,
    ...over,
  };
}

/** Exposed users with a conversion rate per variant, after `t0`. */
function traffic(exp: string, t0: number, arms: Record<string, { n: number; rate: number }>): EventLike[] {
  const out: EventLike[] = [];
  for (const [variant, a] of Object.entries(arms))
    for (let i = 0; i < a.n; i++) {
      const userId = `u_${variant[0]}${String(i).padStart(31, "0")}`;
      const deviceId = `dev-${variant}-${i}`;
      out.push({ type: "exposure", at: new Date(t0 + i * 1000).toISOString(), deviceId, userId, props: { exp, variant } });
      if (i < a.n * a.rate) out.push({ type: "dot_added", at: new Date(t0 + i * 1000 + 5000).toISOString(), deviceId, userId });
    }
  return out;
}

beforeEach(() => resetNativeNeeds());

describe("Live's pass", () => {
  test("config-only idea: day2 thinks of it, starts it at once, decides with numbers and keeps the winner", async () => {
    const { app, store } = makeApp();
    const t0 = Date.parse("2026-11-01T00:00:00Z");
    const d = deps(store, new Date(t0));
    const r = await livePass(app, null, d);
    expect(r.ideas).toBe(1);
    expect(r.started).toEqual(["X-1"]);
    expect(r.ticketsCreated).toEqual([]);
    expect(d.prompts[0]!.code.liveKeys).toEqual(["onboarding.title"]);
    let s = await store.get(app.id);
    expect(s.experiments[0]).toMatchObject({ id: "X-1", state: "running", configOnly: true, createdBy: "day2" });
    expect(s.ideas[0]).toMatchObject({ status: "used", experimentId: "X-1" });

    // Two weeks later, with enough users: "short" wins and becomes the default.
    const events = traffic("X-1", t0 + DAY, { control: { n: 300, rate: 0.2 }, short: { n: 300, rate: 0.32 } });
    const later = deps(store, new Date(t0 + 14 * DAY), { events: async () => events, ideas: async () => ({ ideas: [], credits: 0 }) });
    const r2 = await livePass(app, null, later);
    expect(r2.decided).toEqual(["X-1"]);
    expect(r2.promoted).toEqual(["X-1"]);
    s = await store.get(app.id);
    expect(s.experiments[0]!.state).toBe("promoted");
    expect(s.values["onboarding.title"]).toMatchObject({ value: "Hi", by: "experiment" });
    expect(s.log.map((l) => l.text).join("\n")).toContain('X-1 decided: "short" is better.');
    expect(s.log[0]!.text).toContain("32%");
  });

  test("an experiment on a new setting: build ticket → merged → the update reaches users → running", async () => {
    const { app, store } = makeApp();
    const now = new Date("2026-11-01T00:00:00Z");
    await store.update(app.id, (s) => {
      const a = addExperiment(s, { ...IDEA, keys: ["paywall.trial_days"], variants: [{ name: "control", weight: 50, values: {} }, { name: "long", weight: 50, values: { "paywall.trial_days": 14 } }], createdBy: "owner" }, new Set(), now);
      return { state: a.state, result: null };
    });
    const started = await startExperiment(app, store, "X-1", { by: "owner", now });
    expect(started).toMatchObject({ state: "building", configOnly: false });
    const ticket = findTicket(loadBacklog(backlogFile(app)), started.ticketId!)!;
    expect(ticket.source.key).toBe("live:build:X-1");
    expect(ticket.description).toContain('day2.value("paywall.trial_days"');

    // Not merged yet: nothing happens.
    await livePass(app, null, deps(store, now, { ideas: undefined }));
    expect((await store.get(app.id)).experiments[0]!.state).toBe("building");

    // Merged and shipped as an update.
    const b = loadBacklog(backlogFile(app));
    saveBacklog(backlogFile(app), putTicket(b, { ...findTicket(b, ticket.id)!, state: "done" }));
    const releases: ReleasesFile = {
      enabled: true,
      settings: DEFAULT_SETTINGS,
      shipped: null,
      current: { id: "u1", kind: "update", sha: "abc", fromSha: null, changes: [{ sha: "abc", subject: "Read trial days", ticketId: ticket.id }], startedAt: now.toISOString(), status: "rolling_out", groupId: "g", updateIds: { ios: "3f2a9c1e-77aa-4b0e-9d2a-0123456789ab" }, runtimeVersion: "1", branch: "production", stage: 0, percent: 10, stageAt: now.toISOString(), baseline: {}, health: {}, log: [] },
      history: [],
    };
    const seen: string[][] = [];
    const d = deps(store, new Date(now.getTime() + DAY), { ideas: undefined, releases: () => releases, releaseDevices: async (keys) => (seen.push(keys), 3) });
    const r = await livePass(app, null, d);
    expect(r.started).toEqual(["X-1"]);
    expect(seen[0]).toEqual(["@3f2a9c1e"]);
    const e = (await store.get(app.id)).experiments[0]!;
    expect(e).toMatchObject({ state: "running", release: { keys: ["@3f2a9c1e"] } });
    expect((await store.get(app.id)).log[0]!.text).toContain("3 devices run over-the-air update @3f2a9c1e");
  });

  test("ask me first: day2's own experiments wait for the owner's OK", async () => {
    const { app, store } = makeApp();
    await store.update(app.id, (s) => ({ state: { ...s, settings: { ...s.settings, autonomy: "ask_first" } }, result: null }));
    const now = new Date("2026-11-01T00:00:00Z");
    const r = await livePass(app, null, deps(store, now));
    expect(r.started).toEqual([]);
    const s = await store.get(app.id);
    expect(s.experiments[0]!.state).toBe("to_approve");
    expect(s.log[0]!.text).toContain("waiting for your OK");
    // The owner says yes.
    const e = await startExperiment(app, store, "X-1", { by: "owner", now });
    expect(e.state).toBe("running");
  });

  test("native foundations: one ticket for everything missing, from every module that's on", async () => {
    const { app, store } = makeApp({ deps: {} });
    registerNativeNeed({ module: "money", packages: ["expo-iap"], plugins: ["expo-iap"], instructions: "Wire purchases.", whenNeeded: async () => true });
    registerNativeNeed({ module: "messages", packages: ["expo-notifications"], instructions: "Ask for push later.", whenNeeded: async () => false });
    const now = new Date("2026-11-01T00:00:00Z");
    const d = deps(store, now, { ideas: undefined });
    const r = await livePass(app, null, d);
    expect(r.ticketsCreated).toHaveLength(1);
    const t = findTicket(loadBacklog(backlogFile(app)), r.ticketsCreated[0]!)!;
    expect(t.title).toBe("Native foundations for live, money");
    expect(t.description).toContain("npx expo install @react-native-async-storage/async-storage expo-application expo-iap expo-updates");
    expect(t.description).not.toContain("expo-notifications");
    expect(d.logs[0]).toContain("one store release");
    // Next pass: no second ticket.
    expect((await livePass(app, null, deps(store, now, { ideas: undefined }))).ticketsCreated).toEqual([]);
  });

  test("not a React Native app: nothing to do", async () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-live-web-"));
    dirs.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15" } }));
    const app = { id: "w", name: "Web", repoPath: dir, connectionMethod: "local", addedAt: "" } as AppEntry;
    const r = await livePass(app, null, deps(fileLiveStore(async () => join(dir, "day2-live.json")), new Date()));
    expect(r).toMatchObject({ ticketsCreated: [], started: [], ideas: 0 });
  });

  test("release detection from the releases file", () => {
    const f: ReleasesFile = { enabled: true, settings: DEFAULT_SETTINGS, shipped: null, current: null, history: [] };
    expect(releaseFor(f, "D2-1")).toBeNull();
  });
});

describe("ideas", () => {
  test("the prompt is grounded in the app; answers are checked", () => {
    const p = ideaPrompt({
      appName: "Dotty",
      profile: { purpose: "Track dots", targetUsers: "Artists", featureMap: ["dots"], businessModel: "subscription", toneOfVoice: "playful", brand: null },
      code: { files: ["app/index.tsx"], liveKeys: ["onboarding.title"], excerpts: [] },
      values: { "onboarding.title": "Welcome" },
      numbers: { users: 420, events: [{ type: "dot_added", count: 900 }], revenuePerUser: 0.4, currency: "EUR" },
      leak: { state: "new", lost: 120, rate: 0.22 },
      tried: ["Shorter welcome"],
    });
    expect(p).toContain("Track dots");
    expect(p).toContain("onboarding.title");
    expect(p).toContain('Biggest retention leak: users in state "new" (120 lost last period, 22% come back)');
    expect(p).toContain("Already tried (don't repeat): Shorter welcome");
    const ideas = parseIdeas(`Sure! {"ideas": [${JSON.stringify(IDEA)}, {"title": "bad", "keys": ["x"], "variants": [{"name": "a", "values": {}}], "metric": {"kind": "event", "event": "x"}}, {"title": "no change", "keys": ["a.b"], "variants": [{"name": "control"}, {"name": "b", "values": {}}], "metric": {"kind": "retention_d7"}}]}`);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]).toMatchObject({ title: "Shorter welcome", keys: ["onboarding.title"], metric: { kind: "event", event: "dot_added" } });
    expect(parseIdeas("no json")).toEqual([]);
  });
});
