import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { renderPage, renderScreen } from "../mockups";
import { chromiumPath } from "../simulation";
import { crc32, zip } from "../zip";
import { backendAdapterFiles, entities } from "./backend-adapter";
import { buildDesignSystemPrompt, buildScreenPrompt, designTokensCss, parseDesignSystem, parseScreenReply, styleCardHtml, themeTokensTs, withTokens } from "./design";
import { exportEntries } from "./export";
import { columns, flowMapHtml, layoutFlowMap, prototypeHtml } from "./flow-map";
import { affectedScreens, describeChange, draftFrom, enforceLocks, ensureAdded, parseChangeRequest, parseComment, screenFromShot, screensMaestroFlow } from "./screen-flow";
import type { CreateRequest, DesignSystem, FlowVersion, PlanScreen, ProductPlan } from "./types";

const scr = (id: string, over: Partial<PlanScreen> = {}): PlanScreen => ({ id, name: id[0]!.toUpperCase() + id.slice(1), route: `/${id}`, purpose: `The ${id}`, key: false, elements: [], flow: "main", states: ["filled"], links: [], ...over });
const SCREENS: PlanScreen[] = [
  scr("welcome", { flow: "onboarding", links: [{ label: "Tap Start", to: "signup" }] }),
  scr("signup", { name: "Sign up", flow: "sign_in", links: [{ label: "Tap Create account", to: "today" }] }),
  scr("today", { route: "/", key: true, links: [{ label: "Tap +", to: "log" }, { label: "Tap the gear", to: "settings" }, { label: "Tap Go pro", to: "paywall" }] }),
  scr("log", { links: [{ label: "Tap Save", to: "today" }] }),
  scr("settings", { flow: "settings", links: [{ label: "Tap Back", to: "today" }] }),
  scr("paywall", { flow: "paywall", links: [{ label: "Tap Not now", to: "today" }] }),
  scr("today-empty", { route: "/", flow: "states", stateOf: "today", state: "empty", states: ["empty"], links: [{ label: "Tap Add your first habit", to: "log" }] }),
];
const plan: ProductPlan = { summary: "Habits", screens: SCREENS, data: [{ name: "Habit", fields: ["name", "days done", "id"], where: "device" }, { name: "Friend invite", fields: ["email"], where: "server" }], firstMinute: [], monetization: { model: "subscription", placement: "", notes: "" }, actions: [], accounts: true, functions: [{ name: "send invite", purpose: "Emails a friend" }], language: "en", openQuestions: [] };
const req: CreateRequest = { name: "habit-loop", displayName: "Habit Loop", description: "Habits for streak breakers", platforms: ["ios", "android"], money: "subscription", look: ["Calm"] };
const DS: DesignSystem = {
  name: "Calm",
  colors: ["background", "surface", "text", "muted", "primary", "onPrimary", "accent", "border", "danger", "success"].map((role) => ({ role, hex: "#336699", use: role })),
  fonts: { heading: '"SF Pro Rounded", ui-rounded, sans-serif', body: "-apple-system, Roboto, sans-serif" },
  type: [
    { name: "largeTitle", size: 34, weight: 700, lineHeight: 41 },
    { name: "body", size: 17, weight: 400, lineHeight: 22 },
    { name: "caption", size: 12, weight: 400, lineHeight: 16 },
  ],
  spacing: [4, 8, 16],
  radius: { small: 6, medium: 12, large: 20 },
  components: [{ name: "Primary button", spec: "52pt" }],
  voice: "Kind",
};

describe("the design system", () => {
  test("prompt from the look and feel; parse fails closed; tokens, style card, app tokens", () => {
    const p = buildDesignSystemPrompt(req, plan, DS, ["Warmer"]);
    expect(p).toContain('"lookAndFeel":["Calm"]');
    expect(p).toContain('"Warmer"');
    const ok = `DESIGN_JSON:\n\`\`\`json\n${JSON.stringify(DS)}\n\`\`\``;
    expect(parseDesignSystem(ok)).toEqual(DS);
    expect(parseDesignSystem("nothing")).toBeNull();
    expect(parseDesignSystem(ok.replace('"role":"danger"', '"role":"nope"'))).toBeNull(); // a role missing
    expect(parseDesignSystem(ok.replace("-apple-system, Roboto, sans-serif", "x;}body{background:url(http://evil)"))).toBeNull(); // CSS injection
    const css = designTokensCss(DS);
    expect(css).toContain("--color-on-primary: #336699;");
    expect(css).toContain("--type-large-title-size: 34px;");
    expect(css).toContain("--space-2: 16px;");
    expect(styleCardHtml(DS, "Habit <Loop>")).toContain("Habit &lt;Loop&gt;");
    expect(themeTokensTs(DS)).toContain('"largeTitle": {\n    "fontSize": 34');
  });

  test("screen prompt: tokens only, real content, hotspots from the links; the reply's scripts are removed", () => {
    const p = buildScreenPrompt(req, plan, DS, SCREENS[2]!, { comments: [{ id: "c", screenId: "today", version: 1, text: "Bigger", pin: { x: 0.5, y: 0.25 }, at: "" }], previousHtml: "<body>old</body>" });
    expect(p).toContain("390×844");
    expect(p).toContain('data-goto="<the target screen\'s id>"');
    expect(p).toContain("Never lorem ipsum");
    expect(p).toContain("pinned at 50% from the left, 25% from the top");
    expect(p).toContain("PREVIOUS_HTML");
    expect(buildScreenPrompt(req, plan, DS, SCREENS[6]!)).toContain("This is the empty state of");
    expect(buildScreenPrompt(req, plan, DS, SCREENS[2]!, { android: true })).toContain("412×915");
    const r = parseScreenReply('NOTE: Today\n<<<HTML\n<body onload="x()"><div>Hi</div><script>alert(1)</script></body>\nHTML>>>')!;
    expect(r).toEqual({ html: "<body><div>Hi</div></body>", note: "Today" });
    expect(parseScreenReply("no html")).toBeNull();
    expect(withTokens("<div>x</div>", DS)).toMatch(/^<!doctype html><html><head><meta charset="utf-8"><style data-day2-tokens>/);
    expect(withTokens("<html><head><title>t</title></head><body></body></html>", DS)).toContain("<head><meta charset");
  });
});

describe("the flow map", () => {
  test("columns are taps from the entry; state screens sit under their screen", () => {
    const c = columns(SCREENS);
    expect(Object.fromEntries(c)).toEqual({ welcome: 0, signup: 1, today: 2, log: 3, settings: 3, paywall: 3, "today-empty": 2 });
    expect(columns([scr("a"), scr("b")]).get("b")).toBe(1); // unreachable: after the rest
  });

  test("one lane per flow, in order; arrows labelled with the action; back links dashed", () => {
    const L = layoutFlowMap(SCREENS);
    expect(L.lanes.map((l) => l.label)).toEqual(["First launch", "Sign in", "Main loop", "Settings and profile", "Paywall", "Empty and error states"]);
    const lane = (id: string) => L.lanes.find((l) => l.group === L.nodes.find((n) => n.id === id)!.group)!;
    for (const n of L.nodes) expect(n.y).toBeGreaterThanOrEqual(lane(n.id).y);
    expect(L.edges.find((e) => e.from === "welcome")!.label).toBe("Tap Start → Sign up");
    expect(L.edges.find((e) => e.from === "log")!.back).toBe(true);
    expect(L.edges.find((e) => e.from === "today" && e.to === "log")!.back).toBe(false);
    expect(L.edges).toHaveLength(SCREENS.reduce((n, s) => n + s.links.length, 0));
    expect(L.width).toBeGreaterThan(0);
    const html = flowMapHtml("Habit Loop", { n: 2, plan }, (id) => (id === "today" ? "screens/today.png" : null), { links: true });
    expect(html).toContain('href="prototype.html#today"');
    expect(html).toContain("Not drawn yet");
    expect(html).toContain("Tap Not now → Today");
  });

  test("the standalone prototype links hotspots and lists the rest", () => {
    const v = { n: 1, plan, designs: [{ screenId: "today", drawnIn: 1, png: "a.png", html: "a.html", note: "", hotspots: [{ to: "log", label: "Tap +", x: 0.1, y: 0.2, w: 0.3, h: 0.05 }] }] };
    const html = prototypeHtml("Habit Loop", v, (id) => `screens/${id}.png`);
    expect(html).toContain('<a class="hot" href="#log" title="Tap + → Log" style="left:10.00%;top:20.00%;width:30.00%;height:5.00%">');
    expect(html).toContain('<a href="#settings">Tap the gear → Settings</a>');
    expect(html).not.toContain("<script");
  });
});

describe("rounds of changes", () => {
  const designs = SCREENS.map((s) => ({ screenId: s.id, drawnIn: 1, png: `v1-${s.id}.png`, html: "", note: "", hotspots: [] }));

  test("only the affected screens are redrawn, never an approved one", () => {
    const next = { ...plan, screens: [...SCREENS.map((s) => (s.id === "log" ? { ...s, purpose: "Changed" } : s)), scr("stats")] };
    expect(affectedScreens({ prev: plan, next, designs, commented: ["settings"], styleChanged: false, locked: [] }).sort()).toEqual(["log", "settings", "stats"]);
    expect(affectedScreens({ prev: plan, next, designs, commented: ["settings"], styleChanged: false, locked: ["settings", "log"] })).toEqual(["stats"]);
    expect(affectedScreens({ prev: plan, next: plan, designs, commented: [], styleChanged: true, locked: ["today"] })).toHaveLength(SCREENS.length - 1);
    expect(affectedScreens({ prev: plan, next: plan, designs: designs.slice(1), commented: [], styleChanged: false, locked: ["welcome"] })).toEqual(["welcome"]); // never drawn
  });

  test("locks and removals are enforced, whatever the agent wrote", () => {
    const agent = { ...plan, screens: [scr("welcome", { purpose: "Rewritten", flow: "onboarding" }), ...SCREENS.slice(1, 4), scr("settings", { flow: "settings" })] };
    const out = enforceLocks(plan, agent, ["welcome", "paywall"], ["settings"]);
    expect(out.screens.find((s) => s.id === "welcome")!.purpose).toBe("The welcome");
    expect(out.screens.map((s) => s.id)).toEqual(["welcome", "signup", "today", "log", "paywall"]);
    expect(out.screens.find((s) => s.id === "today")!.links.map((l) => l.to)).toEqual(["log", "paywall"]);
    expect(ensureAdded(out, [{ name: "Weekly stats", purpose: "x" }]).screens.at(-1)).toMatchObject({ id: "weekly-stats", route: "/weekly-stats" });
    expect(ensureAdded(out, [{ name: "sign up", purpose: "x" }]).screens).toHaveLength(out.screens.length);
    const v: FlowVersion = { n: 1, at: "", plan, designSystem: DS, style: { png: "s.png", html: "s.html", drawnIn: 1 }, designs, changed: [] };
    const d = draftFrom(v, out, ["today"], "now", "asked");
    expect(d).toMatchObject({ n: 2, redraw: ["today"], asked: "asked" });
    expect(d.designs.map((x) => x.screenId)).toEqual(["welcome", "signup", "log", "paywall"]);
    expect(describeChange({ note: "", add: [{ name: "Stats", purpose: "" }], remove: ["log"] }, [], new Map([["log", "Log"]]))).toBe("add Stats · remove Log");
  });

  test("comments and change requests from the console are checked", () => {
    const ids = SCREENS.map((s) => s.id);
    expect(parseComment({ screenId: "today", text: " Bigger ", pin: { x: 0.25, y: 2 } }, ids)).toEqual({ screenId: "today", text: "Bigger" });
    expect(parseComment({ screenId: "today", text: "Bigger", pin: { x: 0.25, y: 0.5 } }, ids)).toMatchObject({ pin: { x: 0.25, y: 0.5 } });
    expect(parseComment({ screenId: "style", text: "Warmer" }, ids)).toMatchObject({ screenId: "style" });
    expect(parseComment({ screenId: "nope", text: "Bigger" }, ids)).toBeNull();
    expect(parseComment({ screenId: "today", text: "" }, ids)).toBeNull();
    expect(parseChangeRequest({ note: " n ", add: [{ name: "Stats" }, { name: "" }], remove: ["log", "ghost"] }, ids)).toEqual({ note: "n", add: [{ name: "Stats", purpose: "" }], remove: ["log"] });
  });

  test("the Maestro screenshot flow opens every screen that has its own route", () => {
    const y = screensMaestroFlow({ ...plan, screens: [...SCREENS, scr("habit", { route: "/habit/[id]" })] }, { bundleId: "com.habitloop", scheme: "habitloop" });
    expect(y).toStartWith("appId: com.habitloop\n");
    expect(y).toContain('- openLink: "habitloop://"\n- waitForAnimationToEnd\n- takeScreenshot: screen-today');
    expect(y).not.toContain("today-empty");
    expect(y).not.toContain("habit/[id]");
    expect(screenFromShot("screen-today")).toBe("today");
    expect(screenFromShot("launch")).toBeNull();
  });
});

const ROOT = mkdtempSync(join(tmpdir(), "day2-screen-flow-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("the backend adapter", () => {
  test("names from the plan; the generated TypeScript type-checks, with and without accounts", () => {
    expect(entities(plan)).toEqual([
      { type: "Habit", collection: "habits", fields: ["name", "daysDone"], where: "device" },
      { type: "FriendInvite", collection: "friendInvites", fields: ["email"], where: "server" },
    ]);
    const cases: Array<[typeof plan, boolean]> = [[plan, false], [{ ...plan, accounts: false, functions: [] }, false], [{ ...plan, data: [], accounts: false, functions: [] }, false], [plan, true]];
    for (const [p, hosted] of cases) {
      const files = backendAdapterFiles(p, { hosted });
      const dir = mkdtempSync(join(ROOT, "app-"));
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(dir, "src", "backend"), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
      const use = join(dir, "use.ts");
      writeFileSync(use, `import { backend } from "./src/backend";\n${p.data.length ? "void backend.habits.create({ name: 'Walk', daysDone: '4' }).then((h) => backend.habits.update(h.id, { name: 'Run' }));\n" : "void backend.functions;\n"}`);
      const program = ts.createProgram([use, join(dir, "src/backend/hosted.ts")], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ["lib.es2022.d.ts"], types: [], noUnusedLocals: false });
      const diags = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      expect(diags).toEqual([]);
    }
    const f = backendAdapterFiles(plan);
    expect(f["src/backend/hosted.ts"]).toContain("Host with day2");
    expect(f["src/backend/adapter.ts"]).toContain("auth: Auth;");
    expect(f["src/backend/adapter.ts"]).toContain("sendInvite(input");
    expect(f["src/backend/index.ts"]).toContain("export const backend: Backend = localBackend();");
    expect(Object.values(f).join("\n")).not.toMatch(/supabase-js|@supabase|wrangler|cloudflare\//i);
    // Hosted: the switch by env (in memory in tests and without the values), hosted.ts to implement.
    const h = backendAdapterFiles(plan, { hosted: true });
    expect(h["src/backend/index.ts"]).toContain("isHosted = Boolean(url && publicKey) && process.env.NODE_ENV !== \"test\"");
    expect(h["src/backend/index.ts"]).toContain("process.env.EXPO_PUBLIC_SUPABASE_URL");
    expect(h["src/backend/index.ts"]).toContain("localBackend()");
    expect(h["src/backend/hosted.ts"]).toContain("row level security");
    expect(h["src/backend/local.ts"]).toBe(f["src/backend/local.ts"]);
  });
});

describe("the download for Claude Design / Figma", () => {
  test("a zip of standalone HTML and PNGs that unzip reads", async () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const dir = join(ROOT, "flow");
    mkdirSync(dir, { recursive: true });
    for (const f of ["v1-today.png", "v1-today.html", "style-v1.png", "style-v1.html", "map-v1.png"]) writeFileSync(join(dir, f), f);
    const v: FlowVersion = { n: 1, at: "", plan, designSystem: DS, style: { png: "style-v1.png", html: "style-v1.html", drawnIn: 1 }, designs: [{ screenId: "today", drawnIn: 1, png: "v1-today.png", html: "v1-today.html", note: "", hotspots: [] }], map: { png: "map-v1.png", html: "map-v1.html" }, changed: ["today"] };
    const entries = exportEntries({ request: req }, v, dir);
    expect(entries.map((e) => e.path).sort()).toEqual(["README.txt", "design-system.json", "flow-map.png", "flow.json", "index.html", "prototype.html", "screens/today.html", "screens/today.png", "style.html", "style.png"]);
    const file = join(ROOT, "flow.zip");
    writeFileSync(file, zip(entries));
    const list = Bun.spawnSync(["unzip", "-l", file]).stdout.toString();
    expect(list).toContain("screens/today.png");
    expect(Bun.spawnSync(["unzip", "-t", file]).exitCode).toBe(0);
    expect(Bun.spawnSync(["unzip", "-p", file, "screens/today.html"]).stdout.toString()).toBe("v1-today.html");
    expect(() => zip([{ path: "../evil", data: "x" }])).toThrow();
  });
});

describe.skipIf(!chromiumPath())("rendering (real Chromium)", () => {
  test("a screen's tappable areas come from data-goto; pages render full height", async () => {
    const html = withTokens('<body><div style="height:100px"></div><button data-goto="log" data-label="Tap +" style="position:absolute;left:39px;top:422px;width:195px;height:84px">+</button><img src="https://example.com/x.png"></body>', DS);
    const png = join(ROOT, "s.png");
    const hot = await renderScreen(html, png, { width: 390, height: 844 });
    expect(hot).toEqual([{ to: "log", label: "Tap +", x: 0.1, y: 0.5, w: 0.5, h: 0.1 }]);
    expect(readFileSync(png).subarray(1, 4).toString()).toBe("PNG");
    const page = join(ROOT, "p.png");
    await renderPage(styleCardHtml(DS, "Habit Loop"), page, 1200);
    expect(readFileSync(page).subarray(1, 4).toString()).toBe("PNG");
  }, 60_000);
});
