import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findNotice } from "../privacy-notice";
import { readiness } from "../mobile-release/setup";
import { stepReport, stepTicket } from "./build-steps";
import { ownerSteps } from "./first-build";
import { buildPlanPrompt, newScreenMockupPrompt, parsePlan, renderPlan } from "./plan";
import { cleanDomain, estimateCreate, identifiersFor, segment, validateCreateRequest } from "./request";
import { createExpoAppCommand, easJson, firstBuildCommand, patchAppJson, privacyNotice } from "./scaffold";
import { dbCreateStore, fileCreateStore } from "./store";
import type { CreateRequest, ExpoBuild, ProductPlan } from "./types";
import { writeFileSync } from "node:fs";

const plan: ProductPlan = {
  summary: "Habits, kindly.",
  screens: [{ id: "home", name: "Today", route: "/", purpose: "Check off", key: true, elements: [] }],
  data: [{ name: "Habit", fields: ["name"], where: "device" }],
  firstMinute: ["Pick one"],
  monetization: { model: "ads", placement: "Banner on history", notes: "" },
  actions: [{ title: "Log", route: "/log" }],
  accounts: true,
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
  });
});

describe("the plan", () => {
  test("prompt carries the owner's words as data, and comments on a revision", () => {
    const p = buildPlanPrompt(req, plan, ["More color"]);
    expect(p).toContain("UNTRUSTED_OWNER_INPUT_START");
    expect(p).toContain("ads (AdMob)");
    expect(p).toContain('"More color"');
    expect(p).toContain("iPhone");
    expect(newScreenMockupPrompt(req, plan, plan.screens[0]!, ["Bigger"])).toContain("390×844");
  });

  test("parses the reply, fails closed on junk, keeps only safe routes", () => {
    expect(parsePlan("no plan")).toBeNull();
    expect(parsePlan("PLAN_JSON:\n```json\n{bad\n```")).toBeNull();
    expect(parsePlan('PLAN_JSON:\n```json\n{"summary":"x","screens":[]}\n```')).toBeNull();
    const p = parsePlan(
      `PLAN_JSON:\n\`\`\`json\n${JSON.stringify({ summary: "S", screens: [{ id: "Home Screen", name: "Home", route: "/" }, { id: "x", name: "Bad", route: "javascript:alert(1)" }], monetization: { model: "undecided" }, actions: [{ title: "Log", route: "/log" }, { title: "Bad", route: "http://x" }] })}\n\`\`\``,
    )!;
    expect(p.screens).toEqual([{ id: "home-screen", name: "Home", route: "/", purpose: "", key: true, elements: [] }]);
    expect(p.monetization.model).toBe("free");
    expect(p.actions).toEqual([{ title: "Log", route: "/log" }]);
    expect(renderPlan(plan, "Habit Loop")).toContain("## The first minute\n1. Pick one");
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

  test("build steps: screens, data, polish — each a build ticket; a retry carries the failure", () => {
    const b = { request: req, identifiers: identifiersFor(req), mockups: [{ screenId: "home", name: "Today", file: "home-r0.png", note: "n" }] };
    const s = stepTicket(b, plan, "screens", { fieldEndpoint: null, fieldKey: null, libraryDir: null });
    expect(s.description).toContain("design/mockups/home.png");
    expect(stepTicket(b, plan, "data", { fieldEndpoint: null, fieldKey: null, libraryDir: null }).description).toContain("expo-secure-store");
    const p = stepTicket(b, plan, "polish", { fieldEndpoint: "https://d.example", fieldKey: "k1", libraryDir: "day2" });
    expect(p.description).toContain('startDay2({ key: "k1", endpoint: "https://d.example"');
    const r = stepReport("c1", "polish", p, "tsc failed");
    expect(r).toMatchObject({ kind: "build", sourceId: "expo-create:c1:polish" });
    expect(r.agentNotes).toContain("tsc failed");
    expect(r.description).toContain("Done when:");
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
