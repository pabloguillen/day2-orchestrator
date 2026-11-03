import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../api-server";
import { addProposals } from "./listing";
import { REVIEWS_FILENAME, STORE_FILENAME } from "./store";
import { emptyStoreFile, type StoreReview } from "./types";

/**
 * /api/apps/:id/store/* through the real router in local mode — no store
 * connected, no agents, no network: what the page shows, settings,
 * approvals, tests, custom pages and replies.
 */

const ROOT = mkdtempSync(join(tmpdir(), "day2-api-store-"));
const REPO = join(ROOT, "dotty");
const saved: Record<string, string | undefined> = {};
let appId = "";

async function call(method: string, path: string, body?: unknown) {
  const res = await handleRequest(new Request(`http://localhost:4700${path}`, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  for (const k of ["DAY2_APPS_REGISTRY_PATH", "DAY2_DATA_DIR", "DAY2_BACKLOG_TICK_MINUTES", "DAY2_DEVICE_CHECKS"]) saved[k] = process.env[k];
  process.env.DAY2_APPS_REGISTRY_PATH = join(ROOT, "apps.json");
  process.env.DAY2_DATA_DIR = ROOT;
  process.env.DAY2_DEVICE_CHECKS = "off";
  mkdirSync(REPO, { recursive: true });
  writeFileSync(join(REPO, "package.json"), JSON.stringify({ dependencies: { expo: "54.0.0", "react-native": "0.81.0" } }));
  writeFileSync(join(REPO, "app.json"), JSON.stringify({ expo: { name: "Dotty", ios: { bundleIdentifier: "de.dotty.app" }, android: { package: "de.dotty.app" } } }));
  execSync("git init -q", { cwd: REPO });
  const r = await call("POST", "/api/apps", { name: "dotty", repoPath: REPO, connectionMethod: "local_path" });
  expect(r.status).toBe(201);
  appId = r.body.app.id;
  const f = emptyStoreFile();
  f.settings.locales = ["de-DE", "en-US"];
  f.listings = { ios: { "de-DE": { subtitle: "Punkte verbinden" } }, android: null, readAt: new Date().toISOString(), errors: {} };
  writeFileSync(join(REPO, STORE_FILENAME), JSON.stringify(addProposals(f, [{ store: "ios", locale: "de-DE", field: "subtitle", text: "Tägliche Punkte-Rätsel", reason: "targets rätsel" }], { now: new Date(), researchId: null, auto: false }).file));
  const rv: StoreReview = { store: "ios", id: "r1", rating: 5, title: "Toll", body: "Macht Spaß", author: "anna", territory: "DEU", language: null, version: "1.0.0", createdAt: "2026-11-01T00:00:00Z", existingReply: null, reply: { text: "Danke!", state: "draft", by: "day2", at: "x", sentAt: null, error: null }, problemKey: null, ticketId: null, triaged: false };
  writeFileSync(join(REPO, REVIEWS_FILENAME), JSON.stringify([rv]));
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(ROOT, { recursive: true, force: true });
});

describe("Store API", () => {
  test("the page: listing, proposals with counts, what's waiting, the screenshot flow", async () => {
    const r = await call("GET", `/api/apps/${appId}/store`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      applies: true,
      connected: { ios: false, android: false },
      ids: { bundleId: "de.dotty.app", packageName: "de.dotty.app" },
      settings: { locales: ["de-DE", "en-US"], autonomy: { listing: "ask", replies: "ask" } },
      pending: { proposals: 1, replies: 1, total: 2 },
      screenshots: { flow: { path: ".maestro/day2/store-screens.yaml", exists: false } },
    });
    expect(r.body.proposals[0]).toMatchObject({ id: "SP-1", label: "Subtitle", before: "Punkte verbinden", chars: { before: 16, after: 22, limit: 30 }, applyHow: "next_version" });
    expect(r.body.limits.keywords).toBe(100);
  });

  test("approve with an edit (checked against the limit), then it waits for the next App Store version", async () => {
    const bad = await call("POST", `/api/apps/${appId}/store/proposals/SP-1`, { approve: true, text: "x".repeat(31) });
    expect(bad).toMatchObject({ status: 400, body: { error: "Subtitle: 31 characters — the limit is 30." } });
    const ok = await call("POST", `/api/apps/${appId}/store/proposals/SP-1`, { approve: true, text: "Punkte-Rätsel für jeden Tag" });
    expect(ok.status).toBe(200);
    expect(ok.body.proposals[0]).toMatchObject({ status: "staged", after: "Punkte-Rätsel für jeden Tag" });
  });

  test("settings: languages, autonomy and the rating prompt", async () => {
    const r = await call("PUT", `/api/apps/${appId}/store/settings`, { locales: ["de-DE"], autonomy: { replies: "auto_positive", listing: "nope" }, reviewPrompt: { afterEvents: { level_done: 3 }, minDaysBetween: 90 } });
    expect(r.body.settings).toMatchObject({ locales: ["de-DE"], autonomy: { listing: "ask", replies: "auto_positive" }, reviewPrompt: { afterEvents: { level_done: 3 }, minDaysBetween: 90 } });
    expect((await call("PUT", `/api/apps/${appId}/store/settings`, { locales: [] })).status).toBe(400);
  });

  test("a Google Play test comes with its walkthrough; the owner enters the result", async () => {
    const r = await call("POST", `/api/apps/${appId}/store/tests`, { kind: "play_experiment", name: "Kurzbeschreibung", trafficPercent: 50, treatments: [{ name: "Rätsel", note: "Short description: Tägliche Punkte-Rätsel" }] });
    expect(r.status).toBe(201);
    expect(r.body.tests[0]).toMatchObject({ id: "ST-1", status: "draft", locale: "de-DE" });
    expect(r.body.tests[0].walkthrough[0].title).toBe("Open store listing experiments");
    const done = await call("POST", `/api/apps/${appId}/store/tests/ST-1`, { result: { winner: "Rätsel", note: "+6% installs" } });
    expect(done.body.tests[0]).toMatchObject({ status: "finished", result: { winner: "Rätsel" } });
  });

  test("custom product page for a campaign waits for approval", async () => {
    const tooLong = await call("POST", `/api/apps/${appId}/store/pages`, { name: "x", promotionalText: "x".repeat(171) });
    expect(tooLong.status).toBe(400);
    const r = await call("POST", `/api/apps/${appId}/store/pages`, { name: "Rätselfans", purpose: "B-4", promotionalText: "Für alle, die Rätsel lieben", campaigns: ["B-4"] });
    expect(r.body.customPages[0]).toMatchObject({ id: "CP-1", status: "waiting_approval", campaigns: ["B-4"] });
    expect((await call("POST", `/api/apps/${appId}/store/pages/CP-1`, { approve: true })).body.customPages[0].status).toBe("draft");
  });

  test("sending a reply without App Store Connect says so; skipping works", async () => {
    const r = await call("POST", `/api/apps/${appId}/store/reviews/ios/r1`, { text: "Danke, Anna!" });
    expect(r.status).toBe(200);
    expect(r.body.sendError).toBe("App Store Connect isn't connected.");
    expect(r.body.reviews[0].reply).toMatchObject({ state: "failed", text: "Danke, Anna!" });
    const s = await call("POST", `/api/apps/${appId}/store/reviews/ios/r1`, { skip: true });
    expect(s.body.reviews[0].reply.state).toBe("skipped");
  });

  test("screenshots need the flow first; research needs the app scan", async () => {
    expect((await call("POST", `/api/apps/${appId}/store/screenshots`)).body.error).toMatch(/screenshot flow/);
    expect((await call("POST", `/api/apps/${appId}/store/research`)).status).toBe(409);
  });
});
