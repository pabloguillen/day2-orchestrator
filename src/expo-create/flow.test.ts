import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileApps } from "../apps-store";
import { BACKLOG_FILENAME, loadBacklog } from "../backlog";
import { monthlyEstimate, type HostingDeps } from "../hosting";
import { fakeSupabase } from "../hosting/fake-supabase";
import { ticketMaker } from "../hosting/runtime";
import { fileHostingSecrets, fileHostingStore } from "../hosting/store";
import { OPERATOR } from "../hosting/test-kit";
import { publicBuild } from "./routes";
import { CreditsError, setPlan } from "../credits";
import type { BugReport } from "../types";
import { registeredNeeds } from "../live/native-foundations";
import { addComment, approveFlow, cancelCreate, deleteComment, getCreate, kick, requestChanges, resumeAll, settled, setOwnerStep, setScreenApproved, startCreate, unstick, type CreateDeps } from "./flow";
import { fileCreateStore } from "./store";
import type { CreateRequest, ExpoBuild } from "./types";

const ROOT = mkdtempSync(join(tmpdir(), "day2-expo-create-"));
const registryPath = join(ROOT, "apps.json");

const SCREENS = [
  { id: "welcome", name: "Welcome", route: "/welcome", flow: "onboarding", purpose: "Say what it does", key: false, elements: ["headline", "start button"], states: ["filled"], links: [{ label: "Tap Start", to: "today" }] },
  { id: "today", name: "Today", route: "/", flow: "main", purpose: "Check off today's habits", key: true, elements: ["habit list", "check button"], states: ["empty", "filled"], links: [{ label: "Tap +", to: "log" }, { label: "Tap the gear", to: "settings" }] },
  { id: "today-empty", name: "Today, no habits yet", route: "/", flow: "states", stateOf: "today", state: "empty", purpose: "First run", key: false, elements: ["empty state"], states: ["empty"], links: [{ label: "Tap Add your first habit", to: "log" }] },
  { id: "log", name: "Log a habit", route: "/log", flow: "main", purpose: "Log a habit", key: false, elements: ["form"], states: ["filled"], links: [{ label: "Tap Save", to: "today" }] },
  { id: "settings", name: "Settings", route: "/settings", flow: "settings", purpose: "Settings", key: false, elements: [], states: ["filled"], links: [{ label: "Tap Back", to: "today" }] },
];
const PLAN = {
  summary: "Track habits as “4 of the last 7 days” instead of streaks.",
  language: "en",
  screens: SCREENS,
  data: [{ name: "Habit", fields: ["name", "days"], where: "device" }],
  functions: [],
  firstMinute: ["Pick a habit", "Check it off"],
  monetization: { model: "subscription", placement: "After the third habit", notes: "" },
  actions: [{ title: "Log a habit", route: "/log", phrase: "Log a habit" }],
  accounts: false,
  openQuestions: [],
};
const reply = (p: unknown) => `Here it is.\nPLAN_JSON:\n\`\`\`json\n${JSON.stringify(p)}\n\`\`\``;
const DS = {
  name: "Calm sage",
  colors: ["background", "surface", "text", "muted", "primary", "onPrimary", "accent", "border", "danger", "success"].map((role, i) => ({ role, hex: `#${String(i).repeat(6)}`, use: role })),
  fonts: { heading: "-apple-system, ui-rounded", body: "-apple-system, Roboto" },
  type: [
    { name: "title", size: 28, weight: 700, lineHeight: 34 },
    { name: "body", size: 17, weight: 400, lineHeight: 22 },
    { name: "caption", size: 13, weight: 400, lineHeight: 18 },
  ],
  spacing: [4, 8, 16, 24],
  radius: { small: 8, medium: 14, large: 24 },
  components: [{ name: "Primary button", spec: "52pt, primary" }],
  voice: "Warm.",
};

/** Hosting's dependencies against an in-memory Supabase (tickets go to the new app's backlog, like on the server). */
function hostingFake(o: { configured?: boolean } = {}) {
  const sb = fakeSupabase();
  const data = mkdtempSync(join(ROOT, "hosting-"));
  const deps = (app: Parameters<NonNullable<CreateDeps["hosting"]>>[0]): HostingDeps => ({
    store: fileHostingStore(join(data, "hosting")),
    secrets: fileHostingSecrets(join(data, "hosting")),
    operator: o.configured === false ? null : OPERATOR,
    api: sb.api,
    ticket: ticketMaker(app),
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    expoToken: async () => null,
    sleep: async () => undefined,
    waitMs: 60_000,
  });
  return { sb, deps, store: fileHostingStore(join(data, "hosting")) };
}

/** What the build agent writes in the hosted backend step. */
const HOSTED_FILES: Record<string, string> = {
  "supabase/migrations/20261104120000_lists.sql": "create table public.lists (id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid(), name text not null, photo text);\nalter table public.lists enable row level security;\ncreate policy \"own\" on public.lists for all using ((select auth.uid()) = user_id);\n",
  "supabase/functions/notify/index.ts": "Deno.serve(() => new Response('ok'))\n",
  "src/backend/hosted.ts": "// supabase-js implementation\nexport function hostedBackend() { return {} as never; }\n",
};

type Fake = { deps: CreateDeps; calls: string[][]; builds: BugReport[]; prompts: { plan: string[]; style: string[]; screen: string[] }; drawn: string[]; pushed: string[] };

/** The screen being drawn, from the drawing prompt's data block. */
const screenOf = (prompt: string) => {
  const data = JSON.parse(prompt.split("<<<UNTRUSTED_PLAN_START>>>\n")[1]!.split("\n<<<UNTRUSTED_PLAN_END>>>")[0]!);
  return data.screen as { id: string; links: Array<{ label: string; to: string }> };
};

function fake(o: { tscFailures?: number; pushed?: string | null; field?: boolean; revise?: (prompt: string) => unknown; failDrawing?: string[]; shots?: boolean; plan?: unknown; hosting?: CreateDeps["hosting"]; backendFiles?: Record<string, string>; onDevices?: (cwd: string) => void } = {}): Fake {
  const calls: string[][] = [];
  const builds: BugReport[] = [];
  const prompts = { plan: [] as string[], style: [] as string[], screen: [] as string[] };
  const drawn: string[] = [];
  const pushed: string[] = [];
  let tscFailures = o.tscFailures ?? 0;
  const failing = [...(o.failDrawing ?? [])];
  const deps: CreateDeps = {
    store: fileCreateStore(ROOT),
    accountId: "local",
    credits: { dir: ROOT },
    apps: fileApps(registryPath),
    repoDir: (id) => join(ROOT, "repos", id),
    mockupDir: (id) => join(ROOT, "mockups", id),
    agents: {
      async plan(prompt) {
        prompts.plan.push(prompt);
        return { text: reply(prompts.plan.length > 1 && o.revise ? o.revise(prompt) : (o.plan ?? PLAN)), isError: false };
      },
      async style(prompt) {
        prompts.style.push(prompt);
        return { text: `DESIGN_JSON:\n\`\`\`json\n${JSON.stringify(prompts.style.length > 1 ? { ...DS, name: "Warmer sage" } : DS)}\n\`\`\``, isError: false };
      },
      async screen(prompt) {
        prompts.screen.push(prompt);
        const s = screenOf(prompt);
        if (failing.includes(s.id)) {
          failing.splice(failing.indexOf(s.id), 1);
          return { text: "I couldn't.", isError: false };
        }
        const android = prompt.includes("Android (Material 3");
        drawn.push(android ? `${s.id}.android` : s.id);
        return { text: `NOTE: The ${s.id} screen\n<<<HTML\n<body><h1>${s.id}</h1>${s.links.map((l) => `<button data-goto="${l.to}" data-label="${l.label}">${l.label}</button>`).join("")}<button data-goto="nowhere">x</button></body>\nHTML>>>`, isError: false };
      },
      async build(cwd, report) {
        builds.push(report);
        if (report.sourceId.endsWith(":backend") && o.backendFiles) {
          for (const [p, c] of Object.entries(o.backendFiles)) {
            mkdirSync(join(cwd, p, ".."), { recursive: true });
            writeFileSync(join(cwd, p), c);
          }
        }
        return { finalText: "## What this adds\nScreens", isError: false, costUsd: 1, numTurns: 10 };
      },
    },
    render: {
      async screen(html, png) {
        writeFileSync(png, "png");
        return [...html.matchAll(/data-goto="([^"]+)" data-label="([^"]*)"/g), ...html.matchAll(/data-goto="(nowhere)"()/g)].map((m, i) => ({ to: m[1]!, label: m[2]!, x: 0.1, y: 0.1 * i, w: 0.5, h: 0.05 }));
      },
      async page(_html, png) {
        writeFileSync(png, "png");
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
        writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
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
    deviceChecks: async (i) => (o.onDevices?.(i.cwd), o.shots ? { status: "passed", summary: "Ran on iPhone 17.", key: i.key } : { status: "skipped", summary: "No simulators here.", key: null }),
    deviceShots: (_appId, key) => {
      const file = join(ROOT, "shots", `${key}.png`);
      mkdirSync(join(ROOT, "shots"), { recursive: true });
      writeFileSync(file, "shot");
      return [
        { platform: "ios", name: "screen-today", rel: "ios/after/screen-today.png", file },
        { platform: "ios", name: "launch", rel: "ios/after/launch.png", file },
      ];
    },
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
    ...(o.hosting ? { hosting: o.hosting } : {}),
  };
  return { deps, calls, builds, prompts, drawn, pushed };
}

const request = (name: string, platforms: CreateRequest["platforms"] = ["ios", "android"]): CreateRequest => ({ name, displayName: "Habit Loop", description: "A habit tracker for people who keep breaking streaks.", look: ["Calm"], platforms, money: "subscription" });

async function state(f: Fake, id: string): Promise<ExpoBuild> {
  await settled(id);
  return (await getCreate(f.deps, id))!;
}

const prevSecretsKey = process.env.DAY2_SECRETS_KEY;
beforeAll(async () => {
  process.env.DAY2_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
  writeFileSync(registryPath, JSON.stringify({ apps: [] }));
  await setPlan({ dir: ROOT }, "growth", "monthly");
});
afterAll(() => {
  if (prevSecretsKey === undefined) delete process.env.DAY2_SECRETS_KEY;
  else process.env.DAY2_SECRETS_KEY = prevSecretsKey;
  rmSync(ROOT, { recursive: true, force: true });
});

describe("Create: the screen flow first", () => {
  test("planning and design prompts carry what day2 knows and what worked for similar apps", async () => {
    const f = fake();
    f.deps.knowledge = async () => "## Starting points from similar apps\n- Free trial length: 7 won in 4 apps";
    const b0 = await startCreate(request("knows-things", ["ios"]), f.deps);
    await state(f, b0.id);
    expect(f.prompts.plan[0]).toContain("Starting points from similar apps");
    expect(f.prompts.style[0]).toContain("Free trial length: 7");
    expect(f.prompts.screen[0]).toContain("the reply format asked above still applies");
  });

  test("screen list → design system → every screen → map; comments, early approval, a second version redraws only what changed", async () => {
    const revised = { ...PLAN, screens: [...SCREENS.filter((s) => s.id !== "settings").map((s) => (s.id === "welcome" ? { ...s, purpose: "Changed by the agent" } : s.id === "today" ? { ...s, links: [{ label: "Tap +", to: "log" }, { label: "Tap the bell", to: "reminders" }] } : s)), { id: "reminders", name: "Reminders", route: "/reminders", flow: "settings", purpose: "When to remind", key: false, elements: [], states: ["filled"], links: [] }] };
    const f = fake({ revise: () => revised });
    const b0 = await startCreate(request("habit-loop"), f.deps);
    expect(b0).toMatchObject({ status: "working", phase: "plan", v: 2, identifiers: { bundleId: "com.pabloguillen.habitloop", scheme: "habitloop" } });

    let b = await state(f, b0.id);
    expect(b.error).toBeUndefined();
    expect(b).toMatchObject({ status: "needs_you", phase: "flow_review" });
    // The design system first, then every screen in it — nothing built yet.
    expect(f.prompts.style).toHaveLength(1);
    expect(f.prompts.screen[0]).toContain(JSON.stringify(DS));
    expect(f.prompts.screen[0]).toContain("var(--color-primary)");
    expect(f.drawn).toEqual(["welcome", "today", "today-empty", "log", "settings"]);
    expect(f.calls.some((c) => c.includes("create-expo-app@latest"))).toBe(false);
    expect(f.builds).toHaveLength(0);
    const v1 = b.flow.versions[0]!;
    expect(v1).toMatchObject({ n: 1, changed: ["welcome", "today", "today-empty", "log", "settings"], style: { png: "style-v1.png" }, map: { png: "map-v1.png" } });
    const dir = join(ROOT, "mockups", b.appId, "flow");
    for (const file of ["style-v1.png", "style-v1.html", "map-v1.png", "map-v1.html", "v1-today.png", "v1-today.html"]) expect(existsSync(join(dir, file))).toBe(true);
    // The drawing carries the design system's tokens; hotspots only where the plan's links go.
    expect(readFileSync(join(dir, "v1-today.html"), "utf-8")).toContain("--color-primary: #444444");
    expect(v1.designs.find((d) => d.screenId === "today")!.hotspots.map((h) => [h.label, h.to])).toEqual([["Tap +", "log"], ["Tap the gear", "settings"]]);
    expect(readFileSync(join(dir, "map-v1.html"), "utf-8")).toContain("Tap Start → Today");

    // Comments (one pinned), one removed again; one screen approved early.
    b = await addComment(b.id, { screenId: "today", text: "Bigger check buttons", pin: { x: 0.5, y: 0.4 } }, f.deps);
    const extra = await addComment(b.id, { screenId: "log", text: "never mind" }, f.deps);
    b = await deleteComment(b.id, extra.flow.comments.at(-1)!.id, f.deps);
    expect(b.flow.comments).toHaveLength(1);
    b = await setScreenApproved(b.id, "welcome", true, f.deps);
    expect(b.flow.approved).toEqual(["welcome"]);
    await expect(addComment(b.id, { screenId: "welcome", text: "Change it" }, f.deps)).rejects.toThrow(/approved this screen/);
    await expect(requestChanges(b.id, { note: "", add: [], remove: ["welcome"] }, f.deps)).rejects.toThrow(/approved a screen/);

    // A round: add Reminders, remove Settings.
    f.drawn.length = 0;
    await requestChanges(b.id, { note: "", add: [{ name: "Reminders", purpose: "When to remind" }], remove: ["settings"] }, f.deps);
    b = await state(f, b.id);
    expect(b.error).toBeUndefined();
    expect(b).toMatchObject({ status: "needs_you", phase: "flow_review" });
    expect(f.prompts.plan.at(-1)).toContain("Bigger check buttons");
    expect(f.prompts.plan.at(-1)).toContain("must stay exactly as they are (do not change them, do not remove them): welcome");
    const v2 = b.flow.versions[1]!;
    // Only Today (commented, links changed) and the new Reminders are drawn again; Welcome stays (approved) even though the agent changed it.
    expect(f.drawn.sort()).toEqual(["reminders", "today"]);
    expect(v2.changed.sort()).toEqual(["reminders", "today"]);
    expect(v2.plan.screens.find((s) => s.id === "welcome")!.purpose).toBe("Say what it does");
    expect(v2.plan.screens.map((s) => s.id)).not.toContain("settings");
    expect(v2.designs.find((d) => d.screenId === "log")).toMatchObject({ drawnIn: 1, png: "v1-log.png" });
    expect(v2.designs.find((d) => d.screenId === "today")).toMatchObject({ drawnIn: 2, png: "v2-today.png" });
    expect(f.prompts.screen.at(-2)).toContain("Bigger check buttons");
    expect(f.prompts.screen.at(-2)).toContain("PREVIOUS_HTML"); // change only what's asked
    expect(b.flow.comments[0]!.doneIn).toBe(2);
    expect(v2.asked).toContain("1 comment");
    expect(v2.asked).toContain("add Reminders");
    expect(v1.plan.screens.map((s) => s.id)).toContain("settings"); // history kept

    // The owner approves the flow: only now is anything built.
    await approveFlow(b.id, f.deps);
    b = await state(f, b.id);
    expect(b.error).toBeUndefined();
    expect(b).toMatchObject({ status: "done", phase: "done", githubRepo: "me/habit-loop" });
    expect(f.builds.map((r) => r.sourceId.split(":").slice(2).join(":"))).toEqual(["theme", "screens", "backend", "polish"]);
    expect(b.checks.map((c) => c.phase)).toEqual(["theme", "screens", "backend", "polish"]);

    // The approved flow is in the repo, one to one.
    const repo = b.repoDir!;
    for (const file of ["design/screens/today.png", "design/screens/today.html", "design/screens/welcome.png", "design/style.png", "design/flow-map.png", "design/design-system.json", "design/flow.json", ".maestro/day2/screens.yaml", "src/theme/tokens.ts", "src/backend/adapter.ts", "src/backend/local.ts", "src/backend/hosted.ts", "src/backend/index.ts"]) expect(existsSync(join(repo, file))).toBe(true);
    expect(existsSync(join(repo, "design/screens/settings.png"))).toBe(false);
    expect(readFileSync(join(repo, ".maestro/day2/screens.yaml"), "utf-8")).toContain('openLink: "habitloop://reminders"');
    expect(readFileSync(join(repo, ".maestro/day2/screens.yaml"), "utf-8")).not.toContain("today-empty");
    expect(readFileSync(join(repo, ".gitignore"), "utf-8")).toContain("design/compare/");
    expect(readFileSync(join(repo, "src/theme/tokens.ts"), "utf-8")).toContain('"primary": "#444444"');
    expect(JSON.parse(readFileSync(join(repo, "design/flow.json"), "utf-8")).version).toBe(2);
    expect(f.builds[1]!.description).toContain("exactly as approved");
    expect(f.builds[2]!.description).toContain("Don't add any provider SDK");
    // Everything on the device: no backend needed, nothing hosted.
    expect(f.builds[2]!.description).toContain("this app needs no server");
    expect(b.hosting).toMatchObject({ state: "not_needed" });
    expect(publicBuild(b, { configured: true, defaultRegion: "eu-central-1" }).hostingDecision).toMatchObject({ needed: false, reasons: [], monthlyCredits: 0 });
    expect(f.builds[3]!.description).toContain(`key: "key-${b.appId}"`);

    // Prewired and onboarded as before.
    const appJson = JSON.parse(readFileSync(join(repo, "app.json"), "utf-8")).expo;
    expect(appJson).toMatchObject({ name: "Habit Loop", scheme: "habitloop", runtimeVersion: { policy: "fingerprint" } });
    const install = f.calls.find((c) => c.slice(0, 3).join(" ") === "npx expo install")!;
    for (const p of ["expo-updates", "expo-application", "@react-native-async-storage/async-storage"]) expect(install).toContain(p);
    expect(f.calls.filter((c) => c[0] === "git" && c.includes("commit")).length).toBe(6); // scaffold, prewire, 4 steps
    expect(b.ownerSteps.map((s) => s.id)).toEqual(["expo", "first-build", "app-store", "play"]);
    expect((await setOwnerStep(b.id, "expo", true, f.deps)).ownerSteps[0]!.done).toBe(true);
    await expect(cancelCreate(b.id, f.deps)).rejects.toThrow(/already created/);
    expect(registeredNeeds().map((n) => n.module)).toEqual(expect.arrayContaining(["live", "assistant-actions"]));
  });

  test("a comment on the style card changes the design system and redraws every screen not approved", async () => {
    const f = fake();
    const b0 = await startCreate(request("style-round", ["ios"]), f.deps);
    let b = await state(f, b0.id);
    b = await setScreenApproved(b.id, "log", true, f.deps);
    await addComment(b.id, { screenId: "style", text: "Warmer colors please" }, f.deps);
    f.drawn.length = 0;
    await requestChanges(b.id, { note: "", add: [], remove: [] }, f.deps);
    b = await state(f, b.id);
    expect(f.prompts.style.at(-1)).toContain("Warmer colors please");
    expect(f.prompts.plan).toHaveLength(1); // only the style was commented: no new screen list
    expect(b.flow.versions[1]!).toMatchObject({ n: 2, designSystem: { name: "Warmer sage" }, style: { png: "style-v2.png", drawnIn: 2 } });
    expect(f.drawn.sort()).toEqual(["settings", "today", "today-empty", "welcome"]);
  });

  test("a screen that couldn't be drawn blocks approval until it's drawn", async () => {
    const f = fake({ failDrawing: ["log", "log"] });
    const b0 = await startCreate(request("missing-one", ["ios"]), f.deps);
    let b = await state(f, b0.id);
    expect(b.flow.versions[0]!.designs.map((d) => d.screenId)).not.toContain("log");
    expect(b.log.at(-2)!.text).toContain("couldn't draw “Log a habit”");
    await expect(approveFlow(b.id, f.deps)).rejects.toThrow(/aren't drawn yet \(Log a habit\)/);
    await expect(setScreenApproved(b.id, "log", true, f.deps)).rejects.toThrow(/isn't drawn yet/);
    f.drawn.length = 0;
    await requestChanges(b.id, { note: "", add: [], remove: [] }, f.deps); // nothing asked: draws what's missing
    b = await state(f, b.id);
    expect(f.drawn).toEqual(["log"]);
    expect(b.flow.versions[1]!.designs).toHaveLength(5);
    await approveFlow(b.id, f.deps);
    expect((await state(f, b.id)).status).toBe("done");
  });

  test("Android is drawn separately only where it differs", async () => {
    const f = fake();
    SCREENS[3] = { ...SCREENS[3]!, androidDiffers: true } as unknown as (typeof SCREENS)[number];
    try {
      const b = await state(f, (await startCreate(request("android-too"), f.deps)).id);
      expect(f.drawn).toContain("log.android");
      expect(f.drawn.filter((d) => d.endsWith(".android"))).toEqual(["log.android"]);
      expect(b.flow.versions[0]!.designs.find((d) => d.screenId === "log")).toMatchObject({ androidPng: "v1-log.android.png" });
    } finally {
      delete (SCREENS[3] as { androidDiffers?: boolean }).androidDiffers;
    }
  });
});

describe("Create: building what was approved", () => {
  test("simulator screenshots go next to the drawings; the agent fixes clear mismatches once per step", async () => {
    const f = fake({ shots: true });
    const b0 = await startCreate(request("shots-app", ["ios"]), f.deps);
    await state(f, b0.id);
    await approveFlow(b0.id, f.deps);
    const b = await state(f, b0.id);
    expect(b.status).toBe("done");
    expect(f.builds.map((r) => r.sourceId.split(":").slice(2).join(":"))).toEqual(["theme", "screens", "screens:match", "backend", "backend:match", "polish", "polish:match"]);
    expect(f.builds[2]!.description).toContain("design/compare/today.ios.png");
    expect(f.builds[2]!.description).toContain("design/screens/today.png");
    const screens = b.comparisons.filter((c) => c.phase === "screens");
    expect(screens.length).toBe(2); // before and after the fix
    expect(screens.every((c) => c.fixed)).toBe(true);
    expect(screens[0]!.pairs).toEqual([{ screenId: "today", name: "Today", design: "v1-today.png", shot: "ios/after/screen-today.png", platform: "ios" }]);
    expect(b.comparisons.some((c) => c.phase === "theme")).toBe(false);
    expect(existsSync(join(b.repoDir!, "design", "compare", "today.ios.png"))).toBe(true);
  });

  test("a step that keeps failing its checks gets one fix attempt, then asks the owner", async () => {
    const f = fake({ tscFailures: 2, pushed: null, field: false });
    const b0 = await startCreate(request("recipe-box"), f.deps);
    await state(f, b0.id);
    await approveFlow(b0.id, f.deps);
    let b = await state(f, b0.id);
    expect(b).toMatchObject({ status: "needs_you", phase: "theme", stuck: { phase: "theme" } });
    expect(b.stuck!.reason).toContain("Cannot find name 'Foo'");
    expect(f.builds).toHaveLength(2);
    expect(f.builds[1]!.agentNotes).toContain("Cannot find name 'Foo'");

    await unstick(b.id, "continue", f.deps);
    b = await state(f, b.id);
    expect(b.status).toBe("done");
    expect(b.githubRepo).toBeUndefined();
    expect(f.builds.map((r) => r.sourceId.split(":").pop())).toEqual(["theme", "theme", "screens", "backend", "polish"]);
    expect(f.builds[4]!.description).toContain("no public address yet");
    expect((await f.deps.apps.find(b.appId))!.connectionMethod).toBe("local_path");
  });

  test("cancel stops it; nothing more is drawn or built", async () => {
    const f = fake();
    const b0 = await startCreate(request("cancel-me"), f.deps);
    await state(f, b0.id);
    const c = await cancelCreate(b0.id, f.deps);
    expect(c.status).toBe("canceled");
    await expect(approveFlow(b0.id, f.deps)).rejects.toThrow(/aren't waiting/);
    await expect(addComment(b0.id, { screenId: "today", text: "x y" }, f.deps)).rejects.toThrow(/aren't waiting/);
    kick(b0.id, f.deps);
    expect((await state(f, b0.id)).status).toBe("canceled");
    expect(f.builds).toHaveLength(0);
  });

  test("after a restart, drawing carries on with the screens not drawn yet, and building from its phase", async () => {
    const f = fake();
    const b0 = await startCreate(request("resumed-app"), f.deps);
    let b = await state(f, b0.id);
    // As if the server had stopped while drawing v1, after two screens.
    const v1 = b.flow.versions[0]!;
    await f.deps.store.save({ ...b, phase: "design", status: "working", flow: { ...b.flow, versions: [], draft: { ...v1, designs: v1.designs.slice(0, 2), changed: [], redraw: v1.plan.screens.map((s) => s.id), styleChanged: true } } });
    f.drawn.length = 0;
    expect(await resumeAll(f.deps.store, async (acc) => (acc === "local" ? f.deps : null))).toContain(b0.id);
    b = await state(f, b0.id);
    expect(f.drawn).toEqual(["today-empty", "log", "settings"]);
    expect(b).toMatchObject({ phase: "flow_review", flow: { versions: [{ n: 1 }] } });

    await approveFlow(b.id, f.deps);
    b = await state(f, b0.id);
    // As if the server had stopped during "backend".
    await f.deps.store.save({ ...b, phase: "backend", status: "working", attempt: 0 });
    const before = f.builds.length;
    await resumeAll(f.deps.store, async (acc) => (acc === "local" ? f.deps : null));
    const after = await state(f, b0.id);
    expect(after.status).toBe("done");
    expect(f.builds.slice(before).map((r) => r.sourceId.split(":").pop())).toEqual(["backend", "polish"]);
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

const HOSTED_PLAN = {
  ...PLAN,
  accounts: true,
  sharedData: true,
  countries: ["DE", "AT"],
  data: [
    { name: "Habit", fields: ["name", "days"], where: "device" },
    { name: "Shared list", fields: ["name", "photo"], where: "server" },
  ],
  functions: [{ name: "notify", purpose: "Tell friends about a new list" }],
};

describe("Create: the hosted backend", () => {
  test("needed and Supabase set up: the plan shows it; production and staging; migrations to staging, device checks against staging, then production", async () => {
    const h = hostingFake();
    let stagingAtDeviceCheck: string[] = [];
    let envAtDeviceCheck = "";
    const f = fake({
      plan: HOSTED_PLAN,
      hosting: h.deps,
      backendFiles: HOSTED_FILES,
      shots: true,
      onDevices: (cwd) => {
        const staging = [...h.sb.projects.values()].find((p) => p.name.endsWith("-staging"));
        stagingAtDeviceCheck = staging ? [...(h.sb.migrations.get(staging.ref) ?? [])] : [];
        envAtDeviceCheck = existsSync(join(cwd, ".env")) ? readFileSync(join(cwd, ".env"), "utf-8") : "";
      },
    });
    const b0 = await startCreate(request("shared-lists", ["ios"]), f.deps);
    let b = await state(f, b0.id);
    expect(f.prompts.plan[0]).toContain('"sharedData"');
    // At the flow approval: needed, why, where, and the monthly credits (separate from building).
    const decision = publicBuild(b, { configured: true, defaultRegion: "us-east-1" }).hostingDecision!;
    expect(decision).toEqual({ needed: true, reasons: ["accounts", "shared", "files", "server"], configured: true, region: "eu-central-1", place: "Frankfurt, Germany (EU)", monthlyCredits: monthlyEstimate().credits });
    expect(decision.monthlyCredits).toBeGreaterThan(0);
    expect(b.estimateCredits).not.toBe(decision.monthlyCredits);

    await approveFlow(b.id, f.deps);
    b = await state(f, b.id);
    expect(b.error).toBeUndefined();
    expect(b.status).toBe("done");
    const repo = b.repoDir!;

    // Prewire installed the hosted backend's native packages before the first store build.
    const install = f.calls.find((c) => c.slice(0, 3).join(" ") === "npx expo install")!;
    for (const p of ["expo-secure-store", "@react-native-async-storage/async-storage", "expo-apple-authentication"]) expect(install).toContain(p);

    // Two projects in day2's organization, in Frankfurt: production and staging.
    const projects = [...h.sb.projects.values()];
    expect(projects.map((p) => [p.name.endsWith("-staging") ? "staging" : "production", p.region]).sort()).toEqual([["production", "eu-central-1"], ["staging", "eu-central-1"]]);
    const prod = projects.find((p) => !p.name.endsWith("-staging"))!;
    const staging = projects.find((p) => p.name.endsWith("-staging"))!;

    // The agent got Hosting's brief, and the rules.
    const backend = f.builds.find((r) => r.sourceId.endsWith(":backend"))!;
    expect(backend.title).toContain("hosted backend");
    expect(backend.description).toContain("Frankfurt, Germany (EU)");
    expect(backend.description).toContain("signInWithOtp");
    expect(backend.description).toContain("enable row level security");
    expect(backend.description).not.toContain("Don't add any provider SDK");

    // Migrations: staging first (the device checks ran against it), then production.
    expect(stagingAtDeviceCheck).toEqual(["20261104120000"]);
    expect(envAtDeviceCheck).toContain(`EXPO_PUBLIC_SUPABASE_URL=https://${staging.ref}.supabase.co`);
    expect([...h.sb.migrations.get(prod.ref)!]).toEqual(["20261104120000"]);
    const hs = await h.store.state(b.appId);
    const order = hs.migrations.filter((m) => m.version === "20261104120000").map((m) => m.env);
    expect(order).toEqual(["staging", "production"]);
    // Edge functions to both.
    const deployed = h.sb.calls.filter((c) => c.op === "deployFunction").map((c) => c.args[0]);
    expect(deployed).toEqual([staging.ref, prod.ref]);

    // Env values: store builds → production, other profiles and .env → staging; the switch by env stays in index.ts.
    const eas = JSON.parse(readFileSync(join(repo, "eas.json"), "utf-8"));
    expect(eas.build.production.env.EXPO_PUBLIC_SUPABASE_URL).toBe(`https://${prod.ref}.supabase.co`);
    expect(eas.build.preview.env.EXPO_PUBLIC_SUPABASE_URL).toBe(`https://${staging.ref}.supabase.co`);
    expect(readFileSync(join(repo, ".env"), "utf-8")).toContain(`EXPO_PUBLIC_SUPABASE_KEY=sb_publishable_${staging.ref}`);
    expect(readFileSync(join(repo, "src/backend/index.ts"), "utf-8")).toContain("isHosted");
    expect(readFileSync(join(repo, "src/backend/local.ts"), "utf-8")).toContain("export function localBackend");
    expect(readFileSync(join(repo, "eas.json"), "utf-8")).not.toContain("TOPSECRET");

    // Done: hosted, with region and project; the hosted-backend ticket is done (built in this step).
    expect(b.hosting).toMatchObject({ state: "hosted", region: "eu-central-1", place: "Frankfurt, Germany (EU)", projectRef: prod.ref, stagingRef: staging.ref, monthlyCredits: monthlyEstimate().credits });
    const backlog = loadBacklog(join(repo, BACKLOG_FILENAME));
    expect(backlog.tickets.find((t) => t.source.key === "hosting:backend")).toMatchObject({ id: b.hosting!.ticketId, state: "done" });
    expect(backlog.tickets.some((t) => t.source.key === "create:host-with-day2")).toBe(false);
    expect(b.checks.find((c) => c.phase === "backend")).toMatchObject({ backend: "passed" });
    expect(b.log.some((l) => l.text.includes("The backend is live"))).toBe(true);
    expect(hs.enabled).toBe(true);

    // After a restart halfway through the hosting setup (production stopped after "healthy"): it carries on, no second project.
    await h.store.update(b.appId, (st) => {
      st.done.production = ["project", "healthy"];
      st.working = { env: "production", step: "keys", since: new Date().toISOString() };
    });
    await f.deps.store.save({ ...b, phase: "backend", status: "working", attempt: 0, hosting: { ...b.hosting!, state: "setting_up" } });
    const created = h.sb.calls.filter((c) => c.op === "createProject").length;
    await resumeAll(f.deps.store, async (acc) => (acc === "local" ? f.deps : null));
    const again = await state(f, b.id);
    expect(again).toMatchObject({ status: "done", hosting: { state: "hosted", projectRef: prod.ref } });
    expect(h.sb.calls.filter((c) => c.op === "createProject").length).toBe(created);
    expect((await h.store.state(b.appId)).done.production).toHaveLength(10);
  });

  test("a migration without row level security fails the step's checks before anything reaches production", async () => {
    const h = hostingFake();
    const bad = { ...HOSTED_FILES, "supabase/migrations/20261104120000_lists.sql": "create table public.lists (id uuid primary key);\n" };
    const f = fake({ plan: HOSTED_PLAN, hosting: h.deps, backendFiles: bad });
    const b0 = await startCreate(request("no-rls-app", ["ios"]), f.deps);
    await state(f, b0.id);
    await approveFlow(b0.id, f.deps);
    const b = await state(f, b0.id);
    expect(b).toMatchObject({ status: "needs_you", stuck: { phase: "backend" } });
    expect(b.stuck!.reason).toContain("row level security");
    expect(f.builds.filter((r) => r.sourceId.endsWith(":backend"))[1]!.agentNotes).toContain("lists");
    const prod = [...h.sb.projects.values()].find((p) => !p.name.endsWith("-staging"))!;
    expect(h.sb.migrations.get(prod.ref)?.size ?? 0).toBe(0);
  });

  test("needed but Supabase isn't set up: the in-memory backend stays, with a “Host with day2” follow-up and ticket", async () => {
    const h = hostingFake({ configured: false });
    const f = fake({ plan: HOSTED_PLAN, hosting: h.deps });
    const b0 = await startCreate(request("offline-lists", ["ios"]), f.deps);
    let b = await state(f, b0.id);
    expect(publicBuild(b, { configured: false, defaultRegion: "eu-central-1" }).hostingDecision).toMatchObject({ needed: true, configured: false, region: "eu-central-1" });
    await approveFlow(b.id, f.deps);
    b = await state(f, b.id);
    expect(b.status).toBe("done");
    expect(h.sb.calls).toHaveLength(0);
    const backend = f.builds.find((r) => r.sourceId.endsWith(":backend"))!;
    expect(backend.description).toContain("Don't add any provider SDK");
    expect(backend.description).toContain("Host with day2");
    expect(readFileSync(join(b.repoDir!, "src/backend/index.ts"), "utf-8")).toContain("export const backend: Backend = localBackend();");
    expect(b.hosting).toMatchObject({ state: "not_configured", region: "eu-central-1" });
    expect(b.hosting!.note).toContain("hosting isn't set up on this day2 server yet");
    const t = loadBacklog(join(b.repoDir!, BACKLOG_FILENAME)).tickets.find((x) => x.source.key === "create:host-with-day2")!;
    expect(t).toMatchObject({ title: "Host the backend with day2", state: "parked" });
    expect(b.hosting!.ticketId).toBe(t.id);
    expect(b.tickets).toContain(t.id);
    const install = f.calls.find((c) => c.slice(0, 3).join(" ") === "npx expo install")!;
    expect(install).not.toContain("expo-apple-authentication");
  });
});
