import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import { withBacklog } from "../backlog";
import { backlogFile } from "../backlog-work";
import type { CreditCheck } from "../credits";
import type { DemoClient, DemoDeps } from "../hosting/demo";
import { fakeSupabase } from "../hosting/fake-supabase";
import { fileHostingSecrets, fileHostingStore } from "../hosting/store";
import { OPERATOR } from "../hosting/test-kit";
import { assetStore, localTenant } from "../tenant";
import { capturesDir, loadCaptureSet } from "./capture";
import type { CaptureRunDeps } from "./capture-run";
import { fakeCastDraft, fakeCastModel } from "./demo-cast/generate";
import { CAST_PURPOSE, placeholderPng } from "./demo-cast/images";
import type { DemoCast } from "./demo-cast/schema";
import { castDir, loadCast } from "./demo-cast/store";
import { DEMO_FLOW_KEY } from "./demo-flow";
import { maybeAutoCapture, setRealScreensTestHooks, settleRealScreens } from "./real-screens";
import {
  AUTO_APPROVER,
  autoApprovalCheck,
  backoffMs,
  castCheckPrompt,
  cleanupRealScreens,
  declineCast,
  emptyPipeline,
  ensureRealScreens,
  failStep,
  isDue,
  loadPipeline,
  ownerApproved,
  pipelineView,
  rearm,
  regenerateCast,
  retryOrphanDemos,
  retryRealScreens,
  realScreensTick,
  RETRY,
  setDemoCastPolicy,
  updatePipeline,
  type PipelineStep,
} from "./real-screens-auto";
import type { VisionRun } from "./vision";

/**
 * The real-screens pipeline (real-screens-auto.ts) against fakes only: a
 * fake Supabase (fake-supabase.ts) and demo client, the built-in cast model,
 * the app's bundled pictures, fake EAS / Android capture runners and a fake
 * vision run. Transitions, backoff, idempotency, single flight, the
 * automatic approval, triggers (growth, new version, migrations, first
 * post) and cleanup.
 */

let data: string;
const saved: Record<string, string | undefined> = {};
const ENV = { DAY2_SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"), DAY2_CREDITS: "off", DAY2_CAPTURE: undefined as string | undefined };
const t = localTenant();

type World = { fake: ReturnType<typeof fakeSupabase>; client: DemoClient; deps: DemoDeps; repo: string; captures: number; android: number; capture: "eas" | "eas_no_artifact" | "device"; version: string };
const worlds = new Map<string, World>();
let vision: VisionRun | null = null;
let credits: (s: string, usd: number) => CreditCheck = () => ({ ok: true, maxCredits: 0 });
let growth = true;
let android = { ok: false, why: "no emulator here" as string | null };

function repoFor(name: string, version = "1.0.2"): string {
  const r = mkdtempSync(join(tmpdir(), `day2-rsa-${name}-`));
  mkdirSync(join(r, "supabase", "migrations"), { recursive: true });
  cpSync(join(import.meta.dir, "..", "hosting", "fixtures", "dotty-migrations"), join(r, "supabase", "migrations"), { recursive: true });
  writeFileSync(join(r, "package.json"), JSON.stringify({ dependencies: { expo: "54.0.0", "react-native": "0.81.0", "@supabase/supabase-js": "2.0.0" } }));
  writeFileSync(join(r, "app.json"), JSON.stringify({ expo: { name, version, ios: { bundleIdentifier: "de.example.dotty" }, android: { package: "de.example.dotty" } } }));
  // The app's own demo pictures: every person and moment gets one (no image tool needed, nothing AI-made).
  mkdirSync(join(r, "src/assets/welcome"), { recursive: true });
  for (const n of ["avatar-mia.jpg", "avatar-jonas.jpg", "pizza.jpg", "park.jpg"]) writeFileSync(join(r, "src/assets/welcome", n), Buffer.alloc(5000, 1));
  spawnSync("git", ["init", "-q"], { cwd: r });
  return r;
}

const FLOW = "appId: ${APP_ID}\n- runFlow: sign-in\n# MAESTRO_DAY2_DEMO_EMAIL\n";
/** The flow PR "merged" (what syncCheckout brings into the checkout). */
function mergeFlow(dir: string, version?: string) {
  mkdirSync(join(dir, ".maestro/day2"), { recursive: true });
  writeFileSync(join(dir, ".maestro/day2/store-screens.yaml"), FLOW);
  writeFileSync(join(dir, ".maestro/day2/store-screens.json"), JSON.stringify({ screens: [{ name: "01-karte", shows: "Die Karte" }] }));
  if (version) bump(dir, version);
}
function bump(dir: string, version: string) {
  const j = JSON.parse(readFileSync(join(dir, "app.json"), "utf-8"));
  j.expo.version = version;
  writeFileSync(join(dir, "app.json"), JSON.stringify(j));
}

const demoValues = { url: "https://refdemo0000000000001.supabase.co", key: "sb_publishable_refdemo", login: { email: "demo-x@example.com", password: ["pass", "word", "7q"].join("-") }, ai: { aiGenerated: false, aiPerson: false } };

function captureRunner(w: World, o: { android?: boolean } = {}): CaptureRunDeps {
  const checkout = async () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-rsa-co-"));
    writeFileSync(join(dir, "app.json"), JSON.stringify({ expo: { version: w.version } }));
    writeFileSync(join(dir, "eas.json"), JSON.stringify({ build: { production: {} } }));
    mergeFlow(dir);
    return { dir, done: async () => rmSync(dir, { recursive: true, force: true }) };
  };
  if (o.android)
    return {
      mode: "local",
      checkout,
      demo: async () => demoValues,
      local: {
        target: async (p) => (p === "android" ? { platform: "android", device: "Pixel 8 (emulator)", id: "emulator-5554", build: async () => ({ app: "/x.apk" }), install: async () => {}, uninstall: async () => {}, launch: async () => {}, screenshot: async () => true, running: async () => true, crashesSince: async () => [] } : { skip: "no iPhone Simulator" }),
        flow: async (f) => {
          w.android++;
          writeFileSync(join(f.outDir, "day2-shot-01-karte.png"), placeholderPng(60, 130, "#00aa00"));
          return { ok: true, why: null };
        },
        run: async () => ({ code: 0 }),
      },
    };
  if (w.capture === "device") {
    return { mode: "local", checkout, demo: async () => demoValues, local: { target: async (p) => (p === "ios" && w.captures++, { skip: "the simulator didn't boot" }), flow: async () => ({ ok: false, why: "x" }), run: async () => ({ code: 0 }) } };
  }
  return {
    mode: "eas",
    checkout,
    demo: async () => demoValues,
    eas: {
      expoToken: async () => ["expo", "tok", "rsa"].join("_"),
      run: async (cmd) => {
        if (cmd.includes("workflow:run")) {
          w.captures++;
          return { code: 0, stdout: JSON.stringify({ id: `wr_${w.captures}`, status: "SUCCESS" }), stderr: "" };
        }
        if (cmd.includes("workflow:view")) return { code: 0, stdout: w.capture === "eas" ? JSON.stringify({ jobs: [{ artifacts: [{ name: "day2-screens", downloadUrl: "https://storage.googleapis.com/eas/a.png" }] }] }) : "{}", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      download: async (_url, out) => {
        writeFileSync(out, placeholderPng(60, 130, "#3366aa"));
        return { mime: "image/png", bytes: 10 };
      },
    },
  };
}

function world(id: string, o: { orgPlan?: string; failSql?: RegExp; capture?: World["capture"]; pauseRefused?: boolean } = {}): { app: AppEntry; w: World } {
  const repo = repoFor(id);
  const fake = fakeSupabase({ orgPlan: o.orgPlan, failSql: o.failSql, pauseRefused: o.pauseRefused });
  const users = new Map<string, string>();
  const client: DemoClient = {
    createUser: async (u) => (users.set(u.email, `00000000-0000-4000-8000-${String(users.size + 1).padStart(12, "0")}`), { id: users.get(u.email)! }),
    findUser: async (e) => (users.has(e) ? { id: users.get(e)! } : null),
    deleteUser: async () => undefined,
    insert: async () => undefined,
    remove: async () => undefined,
    upload: async () => undefined,
  };
  const dir = join(data, `hosting-${id}`);
  const deps: DemoDeps = { store: fileHostingStore(dir), secrets: fileHostingSecrets(dir), operator: OPERATOR, api: fake.api, ticket: async (i) => ({ id: "D2-1", state: "todo" as const, ...{ key: i.source.key } }), run: async () => ({ code: 0, stdout: "", stderr: "" }), expoToken: async () => null, sleep: async () => undefined, waitMs: 60_000, demoClient: () => client, planner: null };
  const w: World = { fake, client, deps, repo, captures: 0, android: 0, capture: o.capture ?? "eas", version: "1.0.2" };
  const app: AppEntry = { id, name: `App ${id}`, repoPath: repo, connectionMethod: "local_path", addedAt: new Date().toISOString() };
  worlds.set(id, w);
  return { app, w };
}

const statuses = (appId: string) => pipelineView(appId).steps.map((s) => `${s.id}:${s.status}`);
const count = (w: World, op: string) => w.fake.calls.filter((c) => c.op === op).length;
async function setTicket(app: AppEntry, patch: Record<string, unknown>) {
  await withBacklog(backlogFile(app), (b) => ({ backlog: { ...b, tickets: b.tickets.map((x) => (x.source.key === DEMO_FLOW_KEY ? { ...x, ...patch } : x)) }, result: null }));
}
async function run(app: AppEntry, trigger: Parameters<typeof ensureRealScreens>[2]["trigger"] = "tick") {
  const r = await ensureRealScreens(t, app, { trigger });
  await settleRealScreens(app.id);
  return r;
}

beforeAll(() => {
  data = mkdtempSync(join(tmpdir(), "day2-rsa-data-"));
  for (const [k, v] of Object.entries({ ...ENV, DAY2_DATA_DIR: data })) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setRealScreensTestHooks({
    castModel: fakeCastModel(21),
    planner: null,
    noImageKit: true,
    demoDeps: (app) => worlds.get(app.id)!.deps,
    capture: (app, o) => captureRunner(worlds.get(app.id)!, o),
    get vision() {
      return vision;
    },
    credits: (s, usd) => credits(s, usd),
    growthOn: () => growth,
    get android() {
      return android;
    },
    postWaitMs: 5_000,
  });
});
afterAll(() => {
  setRealScreensTestHooks({});
  rmSync(data, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the state machine, pure", () => {
  test("backoff doubles per attempt and is capped at a day", () => {
    expect(backoffMs("capture", 1)).toBe(RETRY.base.capture);
    expect(backoffMs("capture", 2)).toBe(2 * RETRY.base.capture);
    expect(backoffMs("capture", 3)).toBe(4 * RETRY.base.capture);
    expect(backoffMs("capture", 30)).toBe(RETRY.capMs);
  });

  test("a failed attempt waits (backoff), then needs attention after the last one; a fatal problem at once", () => {
    const now = new Date("2026-11-08T10:00:00Z");
    let r = emptyPipeline("a").steps.capture;
    r = failStep(r, "capture", "the simulator didn't boot", now);
    expect(r).toMatchObject({ status: "pending", attempts: 1, lastError: "the simulator didn't boot", nextRetryAt: new Date(now.getTime() + RETRY.base.capture).toISOString() });
    expect(isDue(r, now)).toBe(false);
    expect(isDue(r, new Date(now.getTime() + RETRY.base.capture))).toBe(true);
    for (let i = 1; i < RETRY.max; i++) r = failStep(r, "capture", "the simulator didn't boot", now);
    expect(r).toMatchObject({ status: "needs_attention", attempts: RETRY.max, nextRetryAt: null });
    expect(r.note).toContain(`tried ${RETRY.max} times`);
    expect(isDue(r, new Date(now.getTime() + 10 * 86_400_000))).toBe(false);
    expect(failStep(emptyPipeline("a").steps.backend, "backend", "no room", now, { fatal: true })).toMatchObject({ status: "needs_attention", attempts: 1, note: "no room" });
    // Re-armed: needs attention → pending (the daily re-arm keeps one more try).
    const s = emptyPipeline("a");
    s.steps.capture = r;
    expect(rearm(s, { attempts: RETRY.max - 1, onlyAttention: true }).steps.capture).toMatchObject({ status: "pending", attempts: RETRY.max - 1, nextRetryAt: null });
    expect(rearm(s, { from: "flow_merged" }).steps.capture.status).toBe("pending");
  });
});

describe("the automatic cast check", () => {
  const base = (): DemoCast => {
    const d = fakeCastDraft({ language: "de", seed: 9 });
    const img = (aiPerson: boolean) => ({ assetId: "as_x", file: "/tmp/x.jpg", source: "generated" as const, aiGenerated: true, aiPerson, tool: "openai_images" });
    return { version: 1, appId: "app_chk", language: "de", locale: "de-DE", createdAt: "2026-11-08T00:00:00Z", generator: "fake", seed: 9, status: "draft", approvedAt: null, approvedBy: null, ...d, people: d.people.map((p) => ({ ...p, avatar: img(true) })), moments: d.moments.map((m) => ({ ...m, photo: img(false) })), images: { source: "generated", note: "" } };
  };
  const answer = (j: unknown): VisionRun => async () => `Looked at them.\nCAST_CHECK_JSON: ${JSON.stringify(j)}`;

  test("passes only with the schema check, every picture there, and a clean vision check", async () => {
    const seen: number[] = [];
    const ok = await autoApprovalCheck(base(), { vision: async (o) => (seen.push(o.images.length), answer({ text: [], notAdult: [], other: [], ok: true })(o)) });
    expect(ok).toEqual({ ok: true, problems: [], vision: true });
    expect(seen[0]).toBe(base().people.length + base().moments.length);
    expect(castCheckPrompt(3)).toContain("adult");
  });

  test("text or logos, a face that may not be adult, no vision run, missing pictures, placeholders, a minor: no", async () => {
    expect((await autoApprovalCheck(base(), { vision: answer({ text: ["avatar:p2"], notAdult: [], ok: false }) })).problems.join()).toContain("text or logos in avatar:p2");
    expect((await autoApprovalCheck(base(), { vision: answer({ text: [], notAdult: ["avatar:p3"], ok: false }) })).problems.join()).toContain("may not look adult: avatar:p3");
    expect((await autoApprovalCheck(base(), { vision: async () => "no idea" })).problems.join()).toContain("no clear answer");
    expect((await autoApprovalCheck(base(), { vision: null })).problems.join()).toContain("can't look at the AI-made pictures");
    const missing = base();
    missing.moments[0]!.photo = null;
    expect((await autoApprovalCheck(missing, { vision: answer({ ok: true }) })).problems.join()).toContain("1 of");
    const ph = base();
    ph.people[0]!.avatar = { ...ph.people[0]!.avatar!, source: "placeholder", aiGenerated: false, aiPerson: false };
    expect((await autoApprovalCheck(ph, { vision: answer({ ok: true }) })).problems.join()).toContain("placeholders");
    const minor = base();
    minor.people[1]!.age = 16;
    const m = await autoApprovalCheck(minor, { vision: answer({ ok: true }) });
    expect(m.ok).toBe(false);
    expect(m.problems.join()).toContain("cast check");
  });
});

describe("the pipeline end to end (fakes)", () => {
  test("from nothing: cast → auto-approved → demo backend → flow ticket → waits for the flow PR; demo paused meanwhile", async () => {
    const { app, w } = world("app_e2e");
    await run(app, "growth_on");
    expect(statuses(app.id)).toEqual(["cast:done", "approve:done", "backend:done", "flow:done", "flow_merged:waiting", "capture:pending"]);
    const cast = (await loadCast(app.id, assetStore()))!;
    expect(cast).toMatchObject({ status: "approved", approvedBy: AUTO_APPROVER });
    expect(cast.images.source).toBe("bundled");
    expect(pipelineView(app.id).steps[4]!.note).toContain("Waiting for the flow PR");
    expect(count(w, "createProject")).toBe(1);
    expect(count(w, "pause")).toBe(1);
    expect((await w.deps.store.state(app.id)).demo).toMatchObject({ pausedAt: expect.any(String) });
  });

  test("idempotent and single-flight: again changes nothing; two calls at once share one run", async () => {
    const app = { ...worldApp("app_e2e") };
    const w = worlds.get(app.id)!;
    const a = ensureRealScreens(t, app, { trigger: "tick" });
    const b = ensureRealScreens(t, app, { trigger: "tick" });
    expect(a).toBe(b);
    await settleRealScreens(app.id);
    await run(app);
    expect(count(w, "createProject")).toBe(1);
    const tickets = (await withBacklog(backlogFile(app), (x) => ({ backlog: x, result: x }))).tickets.filter((x) => x.source.key === DEMO_FLOW_KEY);
    expect(tickets).toHaveLength(1);
    expect(statuses(app.id)).toEqual(["cast:done", "approve:done", "backend:done", "flow:done", "flow_merged:waiting", "capture:pending"]);
  });

  test("the flow PR: waiting names it; closed without merging needs attention; merged → captured on EAS → done", async () => {
    const app = worldApp("app_e2e");
    const w = worlds.get(app.id)!;
    await setTicket(app, { state: "to_approve", approval: { kind: "pr", number: 12, url: "https://github.com/x/y/pull/12" } });
    await run(app);
    expect(pipelineView(app.id).steps[4]).toMatchObject({ status: "waiting", note: expect.stringContaining("PR #12") });
    await setTicket(app, { state: "parked" });
    await run(app);
    expect(pipelineView(app.id).steps[4]).toMatchObject({ status: "needs_attention", note: expect.stringContaining("closed without merging") });
    // Merged: the flow is in the checkout. Retry (the owner, or the next daily re-arm).
    await setTicket(app, { state: "done" });
    mergeFlow(app.repoPath);
    await retryRealScreens(t, app);
    await settleRealScreens(app.id);
    expect(statuses(app.id)).toEqual(["cast:done", "approve:done", "backend:done", "flow:done", "flow_merged:done", "capture:done"]);
    expect(pipelineView(app.id).done).toBe(true);
    expect(w.captures).toBe(1);
    expect(pipelineView(app.id).steps[5]!.note).toMatch(/screens captured|Captured 1 screens/);
  });

  test("a new app version: the timer notices, captures again", async () => {
    const app = worldApp("app_e2e");
    const w = worlds.get(app.id)!;
    await (await realScreensTick(t, app)).run;
    expect(w.captures).toBe(1);
    bump(app.repoPath, "1.1.0");
    w.version = "1.1.0";
    const tick = await realScreensTick(t, app);
    expect(tick.trigger).toBe("new_version");
    await tick.run;
    await settleRealScreens(app.id);
    expect(w.captures).toBe(2);
    expect(statuses(app.id).at(-1)).toBe("capture:done");
  });

  test("the app's migrations change: the new one goes onto the demo project; a failing one needs attention and the old captures stay", async () => {
    const app = worldApp("app_e2e");
    const w = worlds.get(app.id)!;
    writeFileSync(join(app.repoPath, "supabase/migrations/29990101000000_badges.sql"), "create table if not exists dotty.badges (id uuid primary key);\n");
    const tick = await realScreensTick(t, app);
    expect(tick.trigger).toBe("migrations_changed");
    await tick.run;
    await settleRealScreens(app.id);
    expect(w.fake.sql.some((q) => q.query.includes("dotty.badges"))).toBe(true);
    expect(statuses(app.id)[2]).toBe("backend:done");
    // A migration that doesn't apply.
    const { app: app2, w: w2 } = world("app_mig", { failSql: /boom_table/ });
    mergeFlow(app2.repoPath);
    await (await realScreensTick(t, app2)).run;
    await settleRealScreens(app2.id);
    expect(pipelineView(app2.id).done).toBe(true);
    const before = loadCaptureSet(app2.id, "en-US") ?? loadCaptureSet(app2.id, "de-DE");
    expect(before).toBeTruthy();
    writeFileSync(join(app2.repoPath, "supabase/migrations/29990102000000_boom.sql"), "create table dotty.boom_table (id uuid);\n");
    const t2 = await realScreensTick(t, app2);
    await t2.run;
    await settleRealScreens(app2.id);
    const backend = pipelineView(app2.id).steps[2]!;
    const note = String(backend.note);
    expect(backend.status).toBe("needs_attention");
    expect(note).toContain("didn't apply");
    expect(note).toContain("Posts keep using the screens");
    expect(loadCaptureSet(app2.id, before!.locale)).toMatchObject({ capturedAt: before!.capturedAt });
    expect(w2.captures).toBe(1);
  });
});

function worldApp(id: string): AppEntry {
  const w = worlds.get(id)!;
  return { id, name: `App ${id}`, repoPath: w.repo, connectionMethod: "local_path", addedAt: "2026-11-01T00:00:00Z" };
}

describe("failures, backoff and capture fallbacks", () => {
  test("a capture that keeps failing: backoff (not retried before its time), then needs attention; Retry runs it again", async () => {
    const { app, w } = world("app_backoff", { capture: "device" });
    mergeFlow(app.repoPath);
    await run(app);
    const c = pipelineView(app.id).steps[5]!;
    expect(c).toMatchObject({ status: "pending", attempts: 1, lastError: expect.stringContaining("didn't boot"), nextRetryAt: expect.any(String) });
    await run(app);
    await run(app);
    expect(w.captures).toBe(1); // not before its time
    // Time passes: each due retry fails again until it needs attention.
    for (let i = 0; i < RETRY.max; i++) {
      updatePipeline(app.id, (s) => {
        if (s.steps.capture.nextRetryAt) s.steps.capture.nextRetryAt = new Date(Date.now() - 1000).toISOString();
      });
      await run(app);
    }
    expect(w.captures).toBe(RETRY.max);
    expect(pipelineView(app.id).steps[5]).toMatchObject({ status: "needs_attention", attempts: RETRY.max });
    await run(app);
    expect(w.captures).toBe(RETRY.max);
    w.capture = "eas";
    await retryRealScreens(t, app, "capture");
    await settleRealScreens(app.id);
    expect(pipelineView(app.id).steps[5]!.status).toBe("done");
  });

  test("EAS ran but its screenshots can't be downloaded: the Android emulator when the server has one, else upload + needs attention", async () => {
    const { app, w } = world("app_fallback", { capture: "eas_no_artifact" });
    mergeFlow(app.repoPath);
    android = { ok: false, why: "this server has no Android emulator (adb and emulator aren't installed)" };
    await run(app);
    const c = pipelineView(app.id).steps[5]!;
    expect(c).toMatchObject({ status: "needs_attention" });
    expect(c.note).toContain("Upload 3–8 screenshots");
    expect(c.note).toContain("no Android emulator");
    android = { ok: true, why: null };
    await retryRealScreens(t, app, "capture");
    await settleRealScreens(app.id);
    expect(pipelineView(app.id).steps[5]).toMatchObject({ status: "done", note: expect.stringContaining("Android emulator") });
    expect(w.android).toBe(1);
    android = { ok: false, why: "no emulator here" };
  });

  test("Supabase's plan limit: needs attention with the message, nothing created", async () => {
    const { app, w } = world("app_limit", { orgPlan: "free" });
    for (const n of ["a-demo", "b"]) await w.fake.api("x").createProject({ name: n, organization_slug: OPERATOR.orgSlug, db_pass: "x", region: "eu-central-1" });
    await run(app);
    const b = pipelineView(app.id).steps[2]!;
    expect(b).toMatchObject({ status: "needs_attention" });
    expect(b.note).toContain("no room for another project");
    expect(b.note).toContain("Free plan allows 2");
    expect(count(w, "createProject")).toBe(2);
  });

  test("credits: a step that would go over the app's cap needs attention and spends nothing", async () => {
    const { app } = world("app_credits");
    credits = (s) => (s === "content_generation" ? { ok: false, code: "app_cap", reason: "This app's monthly cap is reached.", maxCredits: 10 } : { ok: true, maxCredits: 0 });
    await run(app);
    expect(pipelineView(app.id).steps[0]).toMatchObject({ status: "needs_attention", note: expect.stringContaining("monthly cap") });
    expect(await loadCast(app.id, assetStore())).toBeNull();
    credits = () => ({ ok: true, maxCredits: 0 });
  });
});

describe("hosting costs", () => {
  test("a paid organization can't pause projects: day2 notes it and doesn't ask again for a day", async () => {
    const { app, w } = world("app_paid", { pauseRefused: true });
    await run(app);
    await run(app);
    expect(statuses(app.id)[2]).toBe("backend:done");
    expect(count(w, "pause")).toBe(1);
    expect(loadPipeline(app.id).log.map((l) => l.text).join()).toContain("can't be paused");
  });
});

describe("approval policy", () => {
  test("owner: waits for the owner's OK; Approve carries on", async () => {
    const { app } = world("app_owner");
    setDemoCastPolicy(app.id, "owner");
    await run(app);
    expect(pipelineView(app.id)).toMatchObject({ policy: "owner", current: "approve" });
    expect(pipelineView(app.id).steps[1]!.note).toContain("Waiting for your OK");
    await ownerApproved(t, app, "alice");
    await settleRealScreens(app.id);
    expect((await loadCast(app.id, assetStore()))!.approvedBy).toBe("alice");
    expect(statuses(app.id).slice(0, 4)).toEqual(["cast:done", "approve:done", "backend:done", "flow:done"]);
  });

  test("auto without an image tool or bundled pictures: placeholders are never approved automatically", async () => {
    const { app } = world("app_vision");
    // No bundled pictures: pretend the image tool made them (written as generated, AI-made).
    rmSync(join(app.repoPath, "src/assets/welcome"), { recursive: true, force: true });
    vision = async () => 'CAST_CHECK_JSON: {"text":["avatar:p1"],"notAdult":[],"other":[],"ok":false}';
    await run(app);
    // Without an image tool the pictures are placeholders: never auto-approved.
    expect(pipelineView(app.id).steps[1]).toMatchObject({ status: "waiting", note: expect.stringContaining("placeholders") });
    expect(pipelineView(app.id).autoApproval).toMatchObject({ ok: false });
    vision = null;
  });

  test("decline: day2 writes a new cast once by itself; a second decline waits for Regenerate", async () => {
    const { app } = world("app_decline");
    setDemoCastPolicy(app.id, "owner");
    await run(app);
    const first = (await loadCast(app.id, assetStore()))!;
    await (await declineCast(t, app)).run;
    await settleRealScreens(app.id);
    const second = (await loadCast(app.id, assetStore()))!;
    expect(second.createdAt).not.toBe(first.createdAt);
    expect(loadPipeline(app.id).declines).toBe(1);
    const r = await declineCast(t, app);
    expect(r.run).toBeNull();
    expect(pipelineView(app.id).steps[1]).toMatchObject({ status: "waiting", note: expect.stringContaining("Regenerate") });
    // Even "auto" never approves a cast the owner declined.
    setDemoCastPolicy(app.id, "auto");
    await run(app);
    expect((await loadCast(app.id, assetStore()))!.status).toBe("draft");
    await regenerateCast(t, app);
    await settleRealScreens(app.id);
    expect((await loadCast(app.id, assetStore()))!).toMatchObject({ status: "approved", approvedBy: AUTO_APPROVER });
  });
});

describe("triggers and cleanup", () => {
  test("the first How it works post kicks the whole pipeline (no seeded backend needed) and gets real screens", async () => {
    const { app, w } = world("app_first");
    mergeFlow(app.repoPath);
    const r = await maybeAutoCapture(t, app, { making: "how-it-works", wait: true });
    await settleRealScreens(app.id);
    expect(r).toBe("first_how_it_works");
    expect(pipelineView(app.id).done).toBe(true);
    expect(w.captures).toBe(1);
  });

  test("a post when real screens can't be made yet goes ahead, and says why", async () => {
    const { app } = world("app_post");
    setDemoCastPolicy(app.id, "owner");
    const logs: string[] = [];
    const r = await maybeAutoCapture(t, app, { making: "how-it-works", wait: true, log: (x) => logs.push(x) });
    await settleRealScreens(app.id);
    expect(r).toBeNull();
    expect(logs.join()).toContain("best screens day2 has");
    expect(loadPipeline(app.id).posts?.why).toContain("Approve the cast");
  });

  test("growth off: nothing runs; after 30 days the demo project and the cast's pictures are deleted", async () => {
    const { app, w } = world("app_off");
    await run(app);
    expect((await w.deps.store.state(app.id)).demo).toBeTruthy();
    expect((await assetStore().list(app.id, CAST_PURPOSE)).length).toBeGreaterThan(0);
    growth = false;
    const now = new Date();
    expect(await realScreensTick(t, app, { now })).toMatchObject({ trigger: null, cleaned: false, run: null });
    expect(loadPipeline(app.id).growthOffSince).toBe(now.toISOString());
    expect((await realScreensTick(t, app, { now: new Date(now.getTime() + 29 * 86_400_000) })).cleaned).toBe(false);
    expect((await realScreensTick(t, app, { now: new Date(now.getTime() + 30 * 86_400_000) })).cleaned).toBe(true);
    expect(count(w, "deleteProject")).toBe(1);
    expect((await w.deps.store.state(app.id)).demo).toBeNull();
    expect(await w.deps.secrets.get(app.id, "demo_login")).toBeNull();
    expect(await assetStore().list(app.id, CAST_PURPOSE)).toEqual([]);
    expect(existsSync(castDir(app.id))).toBe(false);
    expect(pipelineView(app.id).cleanup).toMatchObject({ reason: "growth_off" });
    // Growth back on: set up again from scratch.
    growth = true;
    await (await realScreensTick(t, app)).run;
    await settleRealScreens(app.id);
    expect(count(w, "createProject")).toBe(2);
    expect(pipelineView(app.id).cleanup).toBeNull();
  });

  test("app removed: project, cast, captures and state go; a project Supabase won't delete now is retried later", async () => {
    const { app, w } = world("app_removed");
    mergeFlow(app.repoPath);
    await run(app);
    expect(existsSync(capturesDir(app.id))).toBe(true);
    const r = await cleanupRealScreens(t, app, "removed");
    expect(r).toMatchObject({ error: null, deleted: expect.any(String) });
    expect(existsSync(capturesDir(app.id))).toBe(false);
    expect(existsSync(castDir(app.id))).toBe(false);
    expect(loadPipeline(app.id).lastRunAt).toBeNull();
    // Supabase down at removal time: remembered, deleted by the timer later.
    const { app: a2, w: w2 } = world("app_removed2");
    await run(a2);
    const api = w2.fake.api;
    let down = true;
    w2.deps.api = (tok) => {
      const real = api(tok);
      return { ...real, deleteProject: async (ref: string) => (down ? Promise.reject(new Error("Supabase DELETE: 503 unavailable")) : real.deleteProject(ref)) };
    };
    const r2 = await cleanupRealScreens(t, a2, "removed");
    expect(r2.error).toContain("503");
    down = false;
    expect(await retryOrphanDemos({ operator: OPERATOR, api: w2.deps.api })).toBe(1);
    expect(await retryOrphanDemos({ operator: OPERATOR, api: w2.deps.api })).toBe(0);
    expect(w2.fake.projects.size).toBe(0);
    void w;
  });

  test("the daily tick re-arms what needs attention for one more try", async () => {
    const { app } = world("app_daily", { orgPlan: "free" });
    const w = worlds.get(app.id)!;
    for (const n of ["x1", "x2"]) await w.fake.api("x").createProject({ name: n, organization_slug: OPERATOR.orgSlug, db_pass: "x", region: "eu-central-1" });
    const now = new Date();
    await (await realScreensTick(t, app, { now })).run;
    await settleRealScreens(app.id);
    expect(pipelineView(app.id).steps[2]!.status).toBe("needs_attention");
    // Same day: stays. Next day: one more try (still full → needs attention again).
    await (await realScreensTick(t, app, { now: new Date(now.getTime() + 3600_000) })).run;
    const creates = count(w, "createProject");
    const next = await realScreensTick(t, app, { now: new Date(now.getTime() + 86_400_000 + 1) });
    expect(next.trigger).toBe("daily");
    await next.run;
    await settleRealScreens(app.id);
    expect(pipelineView(app.id).steps[2]!.status).toBe("needs_attention");
    expect(count(w, "organization")).toBeGreaterThan(1);
    expect(count(w, "createProject")).toBe(creates);
  });
});

void ({} as PipelineStep);
