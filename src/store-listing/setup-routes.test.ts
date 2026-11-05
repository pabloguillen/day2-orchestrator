import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../api-server";
import { normalizeAgeRating } from "./setup-answers";
import { STORE_FILENAME } from "./store";
import { emptyStoreFile } from "./types";

/**
 * /api/apps/:id/store/setup/* through the real router in local mode — no
 * store connected, no agents, no network: the checklist, approving facts,
 * guided steps, and the demo account that's never returned.
 */

const ROOT = mkdtempSync(join(tmpdir(), "day2-api-setup-"));
const REPO = join(ROOT, "dotty");
const saved: Record<string, string | undefined> = {};
let appId = "";

async function call(method: string, path: string, body?: unknown) {
  const res = await handleRequest(new Request(`http://localhost:4700${path}`, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
const item = (b: { stores: Array<{ items: Array<{ id: string }> }> }, id: string) => b.stores.flatMap((s) => s.items).find((i) => i.id === id) as unknown as Record<string, unknown> & { status: string; detail: string };

beforeAll(async () => {
  for (const k of ["DAY2_APPS_REGISTRY_PATH", "DAY2_DATA_DIR", "DAY2_BACKLOG_TICK_MINUTES", "DAY2_DEVICE_CHECKS", "DAY2_SECRETS_KEY"]) saved[k] = process.env[k];
  process.env.DAY2_APPS_REGISTRY_PATH = join(ROOT, "apps.json");
  process.env.DAY2_DATA_DIR = ROOT;
  process.env.DAY2_DEVICE_CHECKS = "off";
  process.env.DAY2_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
  mkdirSync(REPO, { recursive: true });
  writeFileSync(join(REPO, "package.json"), JSON.stringify({ dependencies: { expo: "54.0.0", "react-native": "0.81.0" } }));
  writeFileSync(join(REPO, "app.json"), JSON.stringify({ expo: { name: "Dotty", ios: { bundleIdentifier: "de.dotty.app" }, android: { package: "de.dotty.app" } } }));
  execSync("git init -q", { cwd: REPO });
  const r = await call("POST", "/api/apps", { name: "dotty", repoPath: REPO, connectionMethod: "local_path" });
  expect(r.status).toBe(201);
  appId = r.body.app.id;
  // What the content agent found (so no agent runs here).
  const f = emptyStoreFile();
  f.settings.locales = ["de-DE"];
  f.setup.answersAt = new Date().toISOString();
  f.setup.answers = {
    facts: { privacyPolicyUrl: "https://dotty.app/privacy", privacyChoicesUrl: "", supportUrl: "https://dotty.app/help", marketingUrl: "", contactEmail: "hi@dotty.app", contactPhone: "", copyrightHolder: "Dotty GmbH", primaryCategory: "FINANCE", secondaryCategory: "", playCategory: "Finance", playTags: [], usesThirdPartyContent: false, signInRequired: true, reviewNotes: "Sign in, then open a group.", free: true },
    ageRating: normalizeAgeRating({}),
    play: { targetAges: ["18+"], appealsToChildren: false, containsAds: false, news: false, health: false, financial: true, government: false, contentNotes: "" },
    why: {},
  };
  writeFileSync(join(REPO, STORE_FILENAME), JSON.stringify(f));
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(ROOT, { recursive: true, force: true });
});

describe("Store setup API", () => {
  test("before the first pass: both stores, each item saying what day2 does", async () => {
    const r = await call("GET", `/api/apps/${appId}/store/setup`);
    expect(r.status).toBe(200);
    expect(r.body.stores.map((s: { store: string; connected: boolean }) => [s.store, s.connected])).toEqual([["ios", false], ["android", false]]);
    expect(item(r.body, "ios.categories")).toMatchObject({ status: "pending", how: "api" });
    expect(item(r.body, "android.category")).toMatchObject({ status: "owner", how: "guided" });
    expect(r.body.ctx).toBeUndefined();
  });

  test("a pass proposes the facts; the Store page counts what waits", async () => {
    const r = await call("POST", `/api/apps/${appId}/store/setup/run`);
    expect(r.status).toBe(200);
    expect(r.body.report.proposed).toHaveLength(9);
    expect(item(r.body, "ios.categories")).toMatchObject({ status: "waiting", fact: { value: { primary: "FINANCE" }, state: "proposed" } });
    expect((item(r.body, "ios.categories").fact as { fields: Array<{ key: string }> }).fields.map((f) => f.key)).toEqual(["primary", "secondary"]);
    const page = await call("GET", `/api/apps/${appId}/store`);
    expect(page.body.pending.setup).toBe(9);
  });

  test("approving a fact: edits checked in plain words; approved without a connection it waits for one", async () => {
    const bad = await call("POST", `/api/apps/${appId}/store/setup/facts/ios.privacyUrls`, { value: { privacyPolicyUrl: "dotty.app" } });
    expect(bad).toMatchObject({ status: 400, body: { error: "Privacy policy link: that isn't a web address (it starts with https://)." } });
    const ok = await call("POST", `/api/apps/${appId}/store/setup/facts/ios.privacyUrls`, { value: { privacyChoicesUrl: "https://dotty.app/choices" } });
    expect(ok.status).toBe(200);
    expect(item(ok.body, "ios.privacyUrls")).toMatchObject({ status: "pending", fact: { state: "approved", value: { privacyPolicyUrl: "https://dotty.app/privacy", privacyChoicesUrl: "https://dotty.app/choices" } } });
    expect(item(ok.body, "ios.privacyUrls").detail).toMatch(/once App Store Connect is connected/);
    expect((await call("POST", `/api/apps/${appId}/store/setup/facts/ios.nope`, {})).status).toBe(404);
  });

  test("the demo account is stored encrypted and never comes back", async () => {
    const review = await call("POST", `/api/apps/${appId}/store/setup/facts/ios.review`, { value: { firstName: "Pia", lastName: "Lang", phone: "+49 30 1234567" } });
    expect(item(review.body, "ios.review")).toMatchObject({ status: "owner", demo: { set: false } });
    expect((await call("PUT", `/api/apps/${appId}/store/setup/demo`, { username: "demo@dotty.app" })).status).toBe(400);
    const r = await call("PUT", `/api/apps/${appId}/store/setup/demo`, { username: "demo@dotty.app", password: "Very-s3cret-pw" });
    expect(r.status).toBe(200);
    expect(item(r.body, "ios.review")).toMatchObject({ demo: { set: true, label: "Demo account saved" } });
    expect(r.text).not.toContain("Very-s3cret-pw");
    expect(r.text).not.toContain("demo@dotty.app");
    expect((await call("GET", `/api/apps/${appId}/store/setup`)).text).not.toContain("Very-s3cret-pw");
    const onDisk = readFileSync(join(REPO, STORE_FILENAME), "utf-8");
    expect(onDisk).not.toContain("Very-s3cret-pw");
    expect(onDisk).not.toContain("demo@dotty.app");
    const del = await call("DELETE", `/api/apps/${appId}/store/setup/demo`);
    expect(item(del.body, "ios.review")).toMatchObject({ demo: { set: false } });
  });

  test("a guided step: the owner says done for the answers shown; privacy steps belong to the Privacy page", async () => {
    const r = await call("POST", `/api/apps/${appId}/store/setup/steps/android.appAccess`, { done: true });
    expect(r.status).toBe(200);
    expect(item(r.body, "android.appAccess")).toMatchObject({ status: "done" });
    expect((item(r.body, "android.appAccess").answers as Array<{ a: string }>)[0]!.a).toBe("All or some functionality in my app is restricted");
    expect((await call("POST", `/api/apps/${appId}/store/setup/steps/android.dataSafety`, { done: true })).status).toBe(409);
    expect((await call("POST", `/api/apps/${appId}/store/setup/steps/android.nope`, { done: true })).status).toBe(404);
    const undo = await call("POST", `/api/apps/${appId}/store/setup/steps/android.appAccess`, { done: false });
    expect(item(undo.body, "android.appAccess").status).toBe("owner");
  });

  test("graphics and files: unknown ones are refused", async () => {
    expect((await call("POST", `/api/apps/${appId}/store/setup/graphics/SG-x`, { approve: true })).status).toBe(404);
    expect((await call("GET", `/api/apps/${appId}/store/setup/files/nope.png`)).status).toBe(404);
    expect((await call("GET", `/api/apps/${appId}/store/setup/files/..%2Fsecret.png`)).status).toBeGreaterThanOrEqual(400);
  });
});
