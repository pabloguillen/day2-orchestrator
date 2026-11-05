import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findNotice } from "../privacy-notice";
import { readiness } from "../mobile-release/setup";
import { stepReport, stepTicket } from "./build-steps";
import { ownerSteps } from "./first-build";
import { buildPlanPrompt, parsePlan, renderPlan } from "./plan";
import { migrateBuild } from "./migrate";
import { cleanDomain, estimateCreate, estimateRound, identifiersFor, segment, validateCreateRequest } from "./request";
import { createExpoAppCommand, easJson, firstBuildCommand, patchAppJson, privacyNotice } from "./scaffold";
import { dbCreateStore, fileCreateStore } from "./store";
import type { CreateRequest, ExpoBuild, ProductPlan } from "./types";
import { writeFileSync } from "node:fs";

const plan: ProductPlan = {
  summary: "Habits, kindly.",
  screens: [{ id: "home", name: "Today", route: "/", purpose: "Check off", key: true, elements: [], flow: "main", states: ["filled"], links: [] }],
  data: [{ name: "Habit", fields: ["name"], where: "device" }],
  firstMinute: ["Pick one"],
  monetization: { model: "ads", placement: "Banner on history", notes: "" },
  actions: [{ title: "Log", route: "/log" }],
  accounts: true,
  functions: [{ name: "send reminder", purpose: "Push at the chosen time" }],
  language: "en",
  openQuestions: ["Reminders?"],
};
const req: CreateRequest = { name: "habit-loop", displayName: "Habit Loop", description: "A habit tracker for streak breakers.", platforms: ["ios"], money: "ads", look: ["Bold"] };

describe("requests", () => {
  test("validates and fills defaults", () => {
    expect(validateCreateRequest({ name: "Habit Loop", description: "x".repeat(30) })).toMatchObject({ ok: false });
    expect(validateCreateRequest({ name: "1abc", description: "x".repeat(30) })).toMatchObject({ ok: false });
    expect(validateCreateRequest({ name: "habit-loop", description: "short" })).toMatchObject({ ok: false });
    expect(validateCreateRequest({ name: "habit-loop", description: "x".repeat(30), platforms: [] })).toMatchObject({ ok: false, reason: expect.stringMatching(/iPhone, Android/) });
    expect(validateCreateRequest({ name: "habit-loop", description: "x".repeat(30), domain: "not a domain" })).toMatchObject({ ok: false });
    expect(validateCreateRequest({ name: "habit-loop", description: " A habit tracker for streak breakers. ", look: ["Calm", "Neon"], money: "bogus", domain: "https://www.HabitLoop.com/x" })).toEqual({
      ok: true,
      request: { name: "habit-loop", displayName: "Habit Loop", description: "A habit tracker for streak breakers.", look: ["Calm"], platforms: ["ios", "android"], money: "undecided", domain: "habitloop.com" },
    });
  });

  test("identifiers: domain first, then the owner's name, valid on both platforms", () => {
    expect(identifiersFor({ name: "habit-loop", displayName: "Habit Loop", domain: "habitloop.com" }).bundleId).toBe("com.habitloop");
    expect(identifiersFor({ name: "habit-loop", displayName: "Habit Loop", domain: "acme.co.uk" }).androidPackage).toBe("uk.co.acme.habitloop");
    expect(identifiersFor({ name: "habit-loop", displayName: "Habit Loop" }, "Pablo Güillen")).toMatchObject({ bundleId: "com.pablogillen.habitloop", scheme: "habitloop" });
    expect(identifiersFor({ name: "new-app", displayName: "x", domain: "1password.com" }).bundleId).toBe("com.a1password.newapp");
    expect(identifiersFor({ name: "class", displayName: "x" }).bundleId).toBe("app.day2.classapp");
    expect(segment("new")).toBe("newapp");
    expect(cleanDomain("http://localhost:3000")).toBeNull();
  });

  test("cost estimate: typical below the worst case, both in credits", () => {
    const e = estimateCreate();
    expect(e.credits).toBeGreaterThan(0);
    expect(e.maxCredits).toBeGreaterThan(e.credits);
    expect(estimateRound(3, true).usd).toBeGreaterThan(estimateRound(3, false).usd);
  });
});

describe("the plan", () => {
  test("prompt carries the owner's words as data, the flows, and a revision's changes and locks", () => {
    const p = buildPlanPrompt(req, plan, ["More color"], { change: { note: "Simpler", add: [{ name: "Stats", purpose: "Weekly view" }], remove: ["settings"] }, locked: ["home"], screenComments: [{ screen: "Today", text: "Bigger" }] });
    expect(p).toContain("UNTRUSTED_OWNER_INPUT_START");
    expect(p).toContain("ads (AdMob)");
    expect(p).toContain('"More color"');
    expect(p).toContain("iPhone");
    expect(p).toContain('"onboarding" (first launch)');
    expect(p).toContain('Add a screen: {"name":"Stats","purpose":"Weekly view"}');
    expect(p).toContain("Remove these screens and every link to them: settings");
    expect(p).toContain("must stay exactly as they are (do not change them, do not remove them): home");
    expect(p).toContain('On the screen "Today": "Bigger"');
  });

  test("parses the reply, fails closed on junk, keeps only safe routes and real links", () => {
    expect(parsePlan("no plan")).toBeNull();
    expect(parsePlan("PLAN_JSON:\n```json\n{bad\n```")).toBeNull();
    expect(parsePlan('PLAN_JSON:\n```json\n{"summary":"x","screens":[]}\n```')).toBeNull();
    const p = parsePlan(
      `PLAN_JSON:\n\`\`\`json\n${JSON.stringify({
        summary: "S",
        language: "de",
        screens: [
          { id: "Home Screen", name: "Home", route: "/", flow: "main", states: ["filled", "bogus"], links: [{ label: "Tap Log", to: "log" }, { label: "Tap Gone", to: "nowhere" }, { label: "Self", to: "home-screen" }] },
          { id: "log", name: "Log", route: "/log", flow: "weird", links: [] },
          { id: "home-empty", name: "Empty", route: "/", flow: "states", stateOf: "home-screen", state: "empty" },
          { id: "x", name: "Bad", route: "javascript:alert(1)" },
        ],
        monetization: { model: "undecided" },
        actions: [{ title: "Log", route: "/log" }, { title: "Bad", route: "http://x" }],
      })}\n\`\`\``,
    )!;
    expect(p.screens.map((s) => s.id)).toEqual(["home-screen", "log", "home-empty"]);
    expect(p.screens[0]).toEqual({ id: "home-screen", name: "Home", route: "/", purpose: "", key: true, elements: [], flow: "main", states: ["filled"], links: [{ label: "Tap Log", to: "log" }] });
    expect(p.screens[1]!.flow).toBe("main");
    expect(p.screens[2]).toMatchObject({ stateOf: "home-screen", state: "empty", flow: "states" });
    expect(p.monetization.model).toBe("free");
    expect(p.language).toBe("de");
    expect(p.actions).toEqual([{ title: "Log", route: "/log" }]);
    expect(renderPlan(plan, "Habit Loop")).toContain("## The first minute\n1. Pick one");
    expect(renderPlan(plan, "Habit Loop")).toContain("### Main loop");
    expect(renderPlan(plan, "Habit Loop")).toContain("`send reminder`: Push at the chosen time");
  });
});

describe("scaffold and prewiring", () => {
  test("create-expo-app with the default template (or a pinned one)", () => {
    expect(createExpoAppCommand("/x/app")).toEqual(["npx", "--yes", "create-expo-app@latest", "/x/app", "--template", "default", "--yes"]);
    expect(createExpoAppCommand("/x/app", "default@sdk-57")).toContain("default@sdk-57");
  });

  test("app.json and eas.json pass day2's release readiness (except the update URL without a project)", () => {
    const ids = identifiersFor(req, "pablo");
    const dir = mkdtempSync(join(tmpdir(), "day2-expo-ready-"));
    try {
      writeFileSync(join(dir, "app.json"), JSON.stringify(patchAppJson({ expo: { name: "t", plugins: ["expo-router"] } }, ids, req, "abc-123")));
      writeFileSync(join(dir, "eas.json"), JSON.stringify(easJson()));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { expo: "1", "expo-updates": "1", "expo-application": "1" } }));
      expect(readiness(dir, null).code).toEqual([]);
      expect(readiness(dir, null).projectId).toBe("abc-123");
      writeFileSync(join(dir, "app.json"), JSON.stringify(patchAppJson({ expo: {} }, ids, req, null)));
      expect(readiness(dir, null).code).toEqual(["updates.url isn't set to the EAS Update URL"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const patched = patchAppJson({ expo: { ios: { infoPlist: { a: 1 } } } }, ids, req, null).expo as Record<string, Record<string, unknown>>;
    expect(patched.ios).toMatchObject({ infoPlist: { a: 1 }, bundleIdentifier: "com.pablo.habitloop", config: { usesNonExemptEncryption: false } });
    expect(patched.platforms).toEqual(["ios"]);
    expect(easJson({ build: { production: { env: { A: "1" } } } }).build).toMatchObject({ production: { env: { A: "1" }, autoIncrement: true } });
  });

  test("the privacy notice draft is found by day2's notice updater", () => {
    const text = privacyNotice(req, plan, true);
    expect(text).toContain("AdMob");
    expect(text).toContain("pseudonym"); // accounts → identify
    const dir = mkdtempSync(join(tmpdir(), "day2-expo-privacy-"));
    try {
      writeFileSync(join(dir, "PRIVACY.md"), text);
      expect(findNotice(dir)).toMatchObject({ path: "PRIVACY.md", lang: "en" });
      expect(findNotice(dir)!.version).toMatch(/^[a-f0-9]{12}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("build steps: theme, screens, backend, polish — each a build ticket; a retry carries the failure", () => {
    const b = { request: req, identifiers: identifiersFor(req) };
    const ctx = { fieldEndpoint: null, fieldKey: null, libraryDir: null };
    expect(stepTicket(b, plan, "theme", ctx).description).toContain("src/theme/tokens.ts is written by day2");
    const s = stepTicket(b, plan, "screens", ctx);
    expect(s.description).toContain("design/screens/<id>.png");
    expect(s.description).toContain("exactly as the links in design/flow.json");
    const be = stepTicket(b, plan, "backend", ctx).description;
    expect(be).toContain("src/backend/");
    expect(be).toContain("Don't add any provider SDK");
    expect(be).toContain("expo-secure-store"); // accounts
    expect(be).toContain("send reminder");
    const p = stepTicket(b, plan, "polish", { fieldEndpoint: "https://d.example", fieldKey: "k1", libraryDir: "day2" });
    expect(p.description).toContain('startDay2({ key: "k1", endpoint: "https://d.example"');
    const r = stepReport("c1", "polish", p, "tsc failed");
    expect(r).toMatchObject({ kind: "build", sourceId: "expo-create:c1:polish" });
    expect(r.agentNotes).toContain("tsc failed");
    expect(r.description).toContain("Done when:");
    expect(stepTicket(b, plan, "theme", { ...ctx, legacyMockups: true }).description).toContain("design/mockups/");
  });

  test("owner steps: Expo token, the first build command, the store records", () => {
    const ids = identifiersFor({ ...req, platforms: ["ios", "android"] });
    const steps = ownerSteps({ ...req, platforms: ["ios", "android"] }, ids, { appId: "a1", githubRepo: "me/habit-loop", repoDir: "/r/a1", local: false });
    expect(steps.map((s) => s.id)).toEqual(["expo", "first-build", "app-store", "play"]);
    expect(steps[1]!.command).toBe("gh repo clone me/habit-loop && cd habit-loop && npx eas-cli@latest init && npx eas-cli@latest build --platform all --profile production");
    expect(ownerSteps(req, ids, { appId: "a1", githubRepo: null, repoDir: "/r/a 1", local: true })[1]!.command).toStartWith('cd "/r/a 1" && ');
    expect(firstBuildCommand({ platforms: ["android"] })).toContain("--platform android");
  });
});

describe("old builds move to the nearest new state", () => {
  const old = (phase: string, extra: Record<string, unknown> = {}) =>
    ({ id: "c1", accountId: "a", appId: "app1", at: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", request: req, phase, status: "working", plan: { ...plan, screens: [{ id: "home", name: "Today", route: "/", purpose: "x", key: true, elements: [] }], functions: undefined, language: undefined }, planRevision: 1, planComments: [], mockups: [], mockupComments: [], checks: [], credits: 0, estimateCredits: 1, tickets: [], ownerSteps: [], log: [], ...extra }) as unknown as ExpoBuild;

  test("working phases", () => {
    expect(migrateBuild(old("plan")).phase).toBe("plan");
    expect(migrateBuild(old("mockups")).phase).toBe("style");
    expect(migrateBuild(old("screens")).phase).toBe("theme");
    expect(migrateBuild(old("data")).phase).toBe("backend");
    expect(migrateBuild(old("polish")).phase).toBe("polish");
    expect(migrateBuild(old("done", { status: "done" }))).toMatchObject({ phase: "done", status: "done", v: 2, comparisons: [] });
    const stuck = migrateBuild(old("data", { status: "needs_you", stuck: { phase: "data", reason: "x" }, checks: [{ phase: "screens" }] }));
    expect(stuck).toMatchObject({ stuck: { phase: "backend" }, checks: [{ phase: "theme" }] });
    expect(migrateBuild(old("plan")).plan!.screens[0]).toMatchObject({ flow: "main", states: ["filled"], links: [] });
  });

  test("waiting on the owner keeps waiting, with a v1 to look at (nothing charged)", () => {
    const pr = migrateBuild(old("plan_review", { status: "needs_you" }));
    expect(pr).toMatchObject({ phase: "flow_review", status: "needs_you" });
    expect(pr.flow.versions).toHaveLength(1);
    expect(pr.flow.versions[0]!.designs).toEqual([]);
    expect(pr.flow.versions[0]!.style.png).toBe(""); // the next round chooses a real design system
    const mr = migrateBuild(old("mockup_review", { status: "needs_you", mockups: [{ screenId: "home", name: "Today", file: "home-r0.png", note: "n" }] }));
    expect(mr.flow.versions[0]!.designs).toEqual([{ screenId: "home", drawnIn: 1, png: "home-r0.png", html: "", note: "n", hotspots: [] }]);
    // Already current: unchanged.
    expect(migrateBuild(mr)).toBe(mr);
  });
});

describe("store", () => {
  const ROOT = mkdtempSync(join(tmpdir(), "day2-expo-store-"));
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
  const build = (id: string, accountId: string) => ({ id, accountId, at: new Date().toISOString(), status: "working" }) as unknown as ExpoBuild;

  test("file store: per account, newest first", async () => {
    const s = fileCreateStore(ROOT);
    await s.save(build("a", "acc1"));
    await s.save(build("b", "acc2"));
    expect((await s.list()).map((b) => b.id)).toEqual(["b", "a"]);
    expect((await s.list("acc1")).map((b) => b.id)).toEqual(["a"]);
    expect(await s.get("a", "acc2")).toBeUndefined();
  });
});

const PG = process.env.DAY2_TEST_DATABASE_URL;
describe.skipIf(!PG)("store (Postgres)", () => {
  let t: Awaited<ReturnType<typeof import("../db/test-db").createTestDatabase>>;
  beforeAll(async () => {
    t = await (await import("../db/test-db")).createTestDatabase();
  });
  afterAll(async () => t && (await t.drop()));

  test("saves, updates and lists per account", async () => {
    const [acc] = (await t.sql`INSERT INTO accounts (name) VALUES ('A') RETURNING id`) as Array<{ id: string }>;
    const s = dbCreateStore(t.sql);
    const at = new Date().toISOString();
    await s.save({ id: "c1", accountId: acc!.id, at, status: "working", step: "x" } as unknown as ExpoBuild);
    await s.save({ id: "c1", accountId: acc!.id, at, status: "needs_you", step: "y" } as unknown as ExpoBuild);
    expect(await s.get("c1", acc!.id)).toMatchObject({ status: "needs_you", step: "y" });
    expect((await s.list(acc!.id)).length).toBe(1);
    expect((await s.list()).length).toBe(1);
  });
});
