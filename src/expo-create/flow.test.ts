import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileApps } from "../apps-store";
import { CreditsError, setPlan } from "../credits";
import type { BugReport } from "../types";
import { registeredNeeds } from "../live/native-foundations";
import { cancelCreate, getCreate, kick, resumeAll, reviewMockups, reviewPlan, settled, setOwnerStep, startCreate, unstick, type CreateDeps } from "./flow";
import { fileCreateStore } from "./store";
import type { CreateRequest, ExpoBuild } from "./types";

const ROOT = mkdtempSync(join(tmpdir(), "day2-expo-create-"));
const registryPath = join(ROOT, "apps.json");

const PLAN = {
  summary: "Track habits as “4 of the last 7 days” instead of streaks.",
  screens: [
    { id: "home", name: "Today", route: "/", purpose: "Check off today's habits", key: true, elements: ["habit list", "check button"] },
    { id: "log", name: "Log", route: "/log", purpose: "Log a habit", key: true, elements: ["form"] },
    { id: "settings", name: "Settings", route: "/settings", purpose: "Settings", key: false, elements: [] },
  ],
  data: [{ name: "Habit", fields: ["name", "days"], where: "device" }],
  firstMinute: ["Pick a habit", "Check it off"],
  monetization: { model: "subscription", placement: "After the third habit", notes: "" },
  actions: [{ title: "Log a habit", route: "/log", phrase: "Log a habit" }],
  accounts: false,
  openQuestions: [],
};
const planReply = (summary = PLAN.summary) => `Here it is.\nPLAN_JSON:\n\`\`\`json\n${JSON.stringify({ ...PLAN, summary })}\n\`\`\``;

type Fake = { deps: CreateDeps; calls: string[][]; builds: BugReport[]; prompts: string[]; pushed: string[] };

function fake(o: { tscFailures?: number; pushed?: string | null; field?: boolean } = {}): Fake {
  const calls: string[][] = [];
  const builds: BugReport[] = [];
  const prompts: string[] = [];
  const pushed: string[] = [];
  let tscFailures = o.tscFailures ?? 0;
  let planRound = 0;
  const deps: CreateDeps = {
    store: fileCreateStore(ROOT),
    accountId: "local",
    credits: { dir: ROOT },
    apps: fileApps(registryPath),
    repoDir: (id) => join(ROOT, "repos", id),
    mockupDir: (id) => join(ROOT, "mockups", id),
    agents: {
      async plan(prompt) {
        prompts.push(prompt);
        planRound++;
        return { text: planReply(planRound === 1 ? PLAN.summary : "Revised: habits with friends."), isError: false };
      },
      async mockup(prompt, out) {
        prompts.push(prompt);
        writeFileSync(out, "png");
        return { note: "The Today screen" };
      },
      async build(_cwd, report) {
        builds.push(report);
        return { finalText: "## What this adds\nScreens", isError: false, costUsd: 1, numTurns: 10 };
      },
    },
    async run(cmd, { cwd }) {
      calls.push(cmd);
      if (cmd.includes("create-expo-app@latest")) {
        const dir = cmd[3]!;
        mkdirSync(join(dir, "app"), { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { lint: "expo lint" }, dependencies: { expo: "~57.0.0" } }));
        writeFileSync(join(dir, "app.json"), JSON.stringify({ expo: { name: "x", slug: "x", scheme: "x", plugins: ["expo-router"] } }));
        writeFileSync(join(dir, "app", "index.tsx"), "export default () => null");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd[0] === "npx" && cmd[1] === "tsc") {
        if (tscFailures > 0) {
          tscFailures--;
          return { code: 2, stdout: "app/log.tsx(3,1): error TS2304: Cannot find name 'Foo'.", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd[0] === "npx" && cmd[1] === "expo" && cmd[2] === "install") {
        const p = join(cwd, "package.json");
        const pkg = JSON.parse(readFileSync(p, "utf-8"));
        for (const n of cmd.slice(3)) pkg.dependencies[n] = "~1.0.0";
        writeFileSync(p, JSON.stringify(pkg));
      }
      return { code: 0, stdout: cmd[0] === "git" && cmd[1] === "diff" ? "app/index.tsx\napp/log.tsx\n" : "", stderr: "" };
    },
    deviceChecks: async () => ({ status: "skipped", summary: "No simulators here.", key: null }),
    placeLibrary: async (dir) => {
      mkdirSync(join(dir, "day2"), { recursive: true });
      writeFileSync(join(dir, "day2", "native.js"), "// lib");
      return join(dir, "day2");
    },
    pushToGitHub: async (_dir, name) => {
      pushed.push(name);
      return o.pushed === undefined ? `me/${name}` : o.pushed;
    },
    field: { key: async (id) => `key-${id}`, endpoint: o.field === false ? null : "https://day2.example.com" },
    ownerName: "Pablo Guillen",
    local: true,
  };
  return { deps, calls, builds, prompts, pushed };
}

const request = (name: string): CreateRequest => ({ name, displayName: "Habit Loop", description: "A habit tracker for people who keep breaking streaks.", look: ["Calm"], platforms: ["ios", "android"], money: "subscription" });

async function state(f: Fake, id: string): Promise<ExpoBuild> {
  await settled(id);
  return (await getCreate(f.deps, id))!;
}

beforeAll(async () => {
  writeFileSync(registryPath, JSON.stringify({ apps: [] }));
  await setPlan({ dir: ROOT }, "growth", "monthly");
});
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("Create: a new Expo app", () => {
  test("plan → comment → approve → mockups → approve → built in three checked steps → repo → onboarded", async () => {
    const f = fake();
    const b0 = await startCreate(request("habit-loop"), f.deps);
    expect(b0).toMatchObject({ status: "working", phase: "plan", identifiers: { bundleId: "com.pabloguillen.habitloop", scheme: "habitloop" } });
    expect(b0.estimateCredits).toBeGreaterThan(0);

    let b = await state(f, b0.id);
    expect(b).toMatchObject({ status: "needs_you", phase: "plan_review", planRevision: 1 });
    expect(b.plan!.screens).toHaveLength(3);

    // A comment makes a new version, with the comment in the prompt.
    await reviewPlan(b.id, { decision: "comment", comment: "Add friends who see my progress" }, f.deps);
    b = await state(f, b.id);
    expect(b).toMatchObject({ phase: "plan_review", planRevision: 2, planComments: ["Add friends who see my progress"] });
    expect(b.plan!.summary).toBe("Revised: habits with friends.");
    expect(f.prompts.at(-1)).toContain("Add friends who see my progress");
    await expect(reviewMockups(b.id, { decision: "approve" }, f.deps)).rejects.toThrow(/aren't waiting/);

    await reviewPlan(b.id, { decision: "approve" }, f.deps);
    b = await state(f, b.id);
    expect(b).toMatchObject({ status: "needs_you", phase: "mockup_review" });
    expect(b.mockups.map((m) => m.screenId)).toEqual(["home", "log"]); // the key screens
    expect(existsSync(join(ROOT, "mockups", b.appId, "home-r0.png"))).toBe(true);

    await reviewMockups(b.id, { decision: "approve" }, f.deps);
    b = await state(f, b.id);
    expect(b.error).toBeUndefined();
    expect(b).toMatchObject({ status: "done", phase: "done", githubRepo: "me/habit-loop" });

    // Scaffolded with Expo's own tool, in steps, each checked.
    const create = f.calls.find((c) => c.includes("create-expo-app@latest"))!;
    expect(create).toEqual(["npx", "--yes", "create-expo-app@latest", join(ROOT, "repos", b.appId), "--template", "default", "--yes"]);
    // Release packages plus Live's native foundations, in the first build already.
    // (Other modules' registered needs, e.g. push or the review prompt, may come along in the same install.)
    const install = f.calls.find((c) => c.slice(0, 3).join(" ") === "npx expo install");
    expect(install).toBeDefined();
    for (const p of ["expo-updates", "expo-application", "@react-native-async-storage/async-storage"]) expect(install).toContain(p);
    expect(f.builds[2]!.description).toContain("Pass AsyncStorage to startDay2");
    expect(f.builds.map((r) => r.sourceId)).toEqual([`expo-create:${b.id}:screens`, `expo-create:${b.id}:data`, `expo-create:${b.id}:polish`]);
    expect(f.builds.every((r) => r.kind === "build")).toBe(true);
    expect(f.builds[2]!.description).toContain(`key: "key-${b.appId}"`);
    expect(f.builds[2]!.description).toContain("day2.identify(user.id)");
    expect(b.checks.map((c) => [c.phase, c.typecheck, c.lint, c.devices])).toEqual([
      ["screens", "passed", "passed", "skipped"],
      ["data", "passed", "passed", "skipped"],
      ["polish", "passed", "passed", "skipped"],
    ]);

    // Prewired: identifiers, releases, privacy, plan, mockups, field library.
    const dir = b.repoDir!;
    const appJson = JSON.parse(readFileSync(join(dir, "app.json"), "utf-8")).expo;
    expect(appJson).toMatchObject({ name: "Habit Loop", slug: "habit-loop", scheme: "habitloop", ios: { bundleIdentifier: "com.pabloguillen.habitloop" }, android: { package: "com.pabloguillen.habitloop" }, runtimeVersion: { policy: "fingerprint" }, plugins: ["expo-router"] });
    const eas = JSON.parse(readFileSync(join(dir, "eas.json"), "utf-8"));
    expect(eas).toMatchObject({ cli: { appVersionSource: "remote" }, build: { production: { autoIncrement: true, channel: "production" } }, submit: { production: { android: { track: "internal" } } } });
    expect(readFileSync(join(dir, "PRIVACY.md"), "utf-8")).toMatch(/day2:privacy-start v=[a-f0-9]{12}/);
    expect(readFileSync(join(dir, "PLAN.md"), "utf-8")).toContain("Revised: habits with friends.");
    expect(existsSync(join(dir, "design", "mockups", "home.png"))).toBe(true);
    expect(existsSync(join(dir, "day2", "native.js"))).toBe(true);
    expect(f.calls.filter((c) => c[0] === "git" && c.includes("commit")).length).toBe(5); // scaffold, prewire, 3 steps

    // Onboarded as a normal app, with follow-up tickets and the owner's steps.
    const apps = await f.deps.apps.list();
    expect(apps.find((a) => a.id === b.appId)).toMatchObject({ name: "habit-loop", connectionMethod: "github", githubRepo: "me/habit-loop", repoPath: dir });
    const backlog = JSON.parse(readFileSync(join(dir, "day2-backlog.json"), "utf-8"));
    const keys = backlog.tickets.map((t: { source: { key: string } }) => t.source.key);
    expect(keys).toContain("release:setup"); // updates.url waits for the EAS project
    expect(keys).toContain("assistant-actions:v1");
    expect(b.tickets).toHaveLength(2);
    expect(b.ownerSteps.map((s) => s.id)).toEqual(["expo", "first-build", "app-store", "play"]);
    expect(b.ownerSteps[1]!.command).toContain("eas-cli@latest build --platform all --profile production");
    const marked = await setOwnerStep(b.id, "expo", true, f.deps);
    expect(marked.ownerSteps[0]!.done).toBe(true);
    await expect(cancelCreate(b.id, f.deps)).rejects.toThrow(/already created/);
    await expect(startCreate(request("habit-loop"), f.deps)).rejects.toThrow(/already an app/);

    // Assistant actions are registered with Live's native foundations.
    expect(registeredNeeds().map((n) => n.module)).toEqual(expect.arrayContaining(["live", "assistant-actions"]));
  });

  test("a step that keeps failing its checks gets one fix attempt, then asks the owner", async () => {
    const f = fake({ tscFailures: 2, pushed: null, field: false });
    const b0 = await startCreate(request("recipe-box"), f.deps);
    await state(f, b0.id);
    await reviewPlan(b0.id, { decision: "approve" }, f.deps);
    await state(f, b0.id);
    await reviewMockups(b0.id, { decision: "approve" }, f.deps);
    let b = await state(f, b0.id);
    expect(b).toMatchObject({ status: "needs_you", phase: "screens", stuck: { phase: "screens" } });
    expect(b.stuck!.reason).toContain("Cannot find name 'Foo'");
    expect(f.builds).toHaveLength(2);
    expect(f.builds[1]!.agentNotes).toContain("Cannot find name 'Foo'"); // the fix attempt sees what failed

    await unstick(b.id, "continue", f.deps);
    b = await state(f, b.id);
    expect(b.status).toBe("done");
    expect(b.githubRepo).toBeUndefined();
    expect(f.builds.map((r) => r.sourceId.split(":").pop())).toEqual(["screens", "screens", "data", "polish"]);
    expect(f.builds[3]!.description).toContain("no public address yet");
    expect((await f.deps.apps.find(b.appId))!.connectionMethod).toBe("local_path");
    expect(readFileSync(join(b.repoDir!, "PRIVACY.md"), "utf-8")).not.toContain("day2:privacy-start");
  });

  test("cancel stops it; nothing more is built", async () => {
    const f = fake();
    const b0 = await startCreate(request("cancel-me"), f.deps);
    await state(f, b0.id);
    const c = await cancelCreate(b0.id, f.deps);
    expect(c.status).toBe("canceled");
    await expect(reviewPlan(b0.id, { decision: "approve" }, f.deps)).rejects.toThrow(/isn't waiting/);
    kick(b0.id, f.deps);
    expect((await state(f, b0.id)).status).toBe("canceled");
    expect(f.builds).toHaveLength(0);
  });

  test("after a restart, a working build carries on from its phase", async () => {
    const f = fake();
    const b0 = await startCreate(request("resumed-app"), f.deps);
    await state(f, b0.id);
    await reviewPlan(b0.id, { decision: "approve" }, f.deps);
    await state(f, b0.id);
    await reviewMockups(b0.id, { decision: "approve" }, f.deps);
    await state(f, b0.id);
    // As if the server had stopped during "data": back to working at that phase.
    const b = (await getCreate(f.deps, b0.id))!;
    await f.deps.store.save({ ...b, phase: "data", status: "working", attempt: 0 });
    const before = f.builds.length;
    const resumed = await resumeAll(f.deps.store, async (acc) => (acc === "local" ? f.deps : null));
    expect(resumed).toContain(b0.id);
    const after = await state(f, b0.id);
    expect(after.status).toBe("done");
    expect(f.builds.slice(before).map((r) => r.sourceId.split(":").pop())).toEqual(["data", "polish"]);
    expect(f.calls.some((c) => c[0] === "git" && c[1] === "reset")).toBe(true);
  });

  test("needs credits and a plan that includes creating apps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-expo-trial-"));
    const f = fake();
    try {
      await expect(startCreate(request("no-plan"), { ...f.deps, credits: { dir } })).rejects.toBeInstanceOf(CreditsError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
