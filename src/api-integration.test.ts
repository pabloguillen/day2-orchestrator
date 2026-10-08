import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "./api-server";
import { ASK_LOG_FILENAME } from "./ask-day2";

/**
 * End-to-end tests of the console API through the real router
 * (`handleRequest`), against real files on disk: a throwaway apps registry
 * (DAY2_APPS_REGISTRY_PATH) and two throwaway app repos — one with a git
 * remote, one without. Never touches the operator's real `.day2-apps.json`.
 *
 * Deliberately avoided here (they reach the network or cost money): the
 * GitHub-backed approvals actions, the onboarding scan and the Ask agent
 * call itself. Their request validation and the data they return around
 * the agent call are covered instead.
 */

const ROOT = mkdtempSync(join(tmpdir(), "day2-api-it-"));
const REGISTRY = join(ROOT, "apps.json");
const REMOTE_REPO = join(ROOT, "with-remote");
const LOCAL_REPO = join(ROOT, "no-remote");
const previousRegistryEnv = process.env.DAY2_APPS_REGISTRY_PATH;

let remoteId = "";
let localId = "";

async function call(method: string, path: string, body?: unknown) {
  const res = await handleRequest(
    new Request(`http://localhost:4700${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  process.env.DAY2_APPS_REGISTRY_PATH = REGISTRY;
  mkdirSync(REMOTE_REPO);
  mkdirSync(LOCAL_REPO);
  execSync("git init -q && git remote add origin https://github.com/example/it-app", { cwd: REMOTE_REPO });
  execSync("git init -q", { cwd: LOCAL_REPO });

  const a = await call("POST", "/api/apps", { name: "it-remote", repoPath: REMOTE_REPO, connectionMethod: "local_path" });
  const b = await call("POST", "/api/apps", { name: "it-local", repoPath: LOCAL_REPO, connectionMethod: "local_path" });
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  remoteId = a.body.app.id;
  localId = b.body.app.id;
});

afterAll(() => {
  if (previousRegistryEnv === undefined) delete process.env.DAY2_APPS_REGISTRY_PATH;
  else process.env.DAY2_APPS_REGISTRY_PATH = previousRegistryEnv;
  rmSync(ROOT, { recursive: true, force: true });
});

describe("apps registry", () => {
  test("writes only to the throwaway registry", async () => {
    const saved = JSON.parse(readFileSync(REGISTRY, "utf-8"));
    expect(saved.apps.map((a: { name: string }) => a.name).sort()).toEqual(["it-local", "it-remote"]);
    const listed = await call("GET", "/api/apps");
    expect(listed.body.apps).toHaveLength(2);
  });

  test("rejects a duplicate repo path and a missing one", async () => {
    expect((await call("POST", "/api/apps", { name: "dup", repoPath: REMOTE_REPO, connectionMethod: "local_path" })).status).toBe(409);
    expect((await call("POST", "/api/apps", { name: "x", repoPath: join(ROOT, "nope"), connectionMethod: "local_path" })).status).toBe(409);
    expect((await call("POST", "/api/apps", { name: "x" })).status).toBe(400);
  });

  test("PATCH sets, normalizes and clears the live address; rejects bad ones", async () => {
    const set = await call("PATCH", `/api/apps/${localId}`, { appBaseUrl: "https://it.example/" });
    expect(set.status).toBe(200);
    expect(set.body.app.appBaseUrl).toBe("https://it.example");
    expect((await call("PATCH", `/api/apps/${localId}`, { appBaseUrl: "ftp://it.example" })).status).toBe(400);
    expect((await call("PATCH", `/api/apps/${localId}`, { appBaseUrl: 42 })).status).toBe(400);
    expect((await call("PATCH", "/api/apps/not-an-app", { appBaseUrl: "https://a.b" })).status).toBe(404);
    const cleared = await call("PATCH", `/api/apps/${localId}`, { appBaseUrl: "" });
    expect(cleared.body.app.appBaseUrl).toBeUndefined();
  });
});

describe("budget and spend", () => {
  test("a new app starts with a zero spend breakdown", async () => {
    const res = await call("GET", `/api/apps/${localId}/growth/config`);
    expect(res.status).toBe(200);
    expect(res.body.spend.spentUsd).toBe(0);
    expect(res.body.spend.byDay).toHaveLength(8);
  });

  test("budget, kill switch, daily cap and goals round-trip through the files", async () => {
    await call("PUT", `/api/apps/${localId}/growth/budget`, { monthlyBudgetUsd: 120 });
    await call("PUT", `/api/apps/${localId}/growth/kill-switch`, { killSwitch: true });
    await call("PUT", `/api/apps/${localId}/growth/daily-cap`, { dailyCapUsd: 15 });
    await call("PUT", `/api/apps/${localId}/growth/kpi-goals/wau`, { target: 500, byDate: "2026-12-31" });
    const res = await call("GET", `/api/apps/${localId}/growth/config`);
    expect(res.body.config.budget).toMatchObject({ monthlyBudgetUsd: 120, killSwitch: true, dailyCapUsd: 15 });
    expect(res.body.config.kpiGoals).toEqual([{ metric: "wau", target: 500, byDate: "2026-12-31" }]);
    expect(res.body.spend.killSwitch).toBe(true);
    await call("DELETE", `/api/apps/${localId}/growth/kpi-goals/wau`);
    await call("PUT", `/api/apps/${localId}/growth/kill-switch`, { killSwitch: false });
    expect((await call("GET", `/api/apps/${localId}/growth/config`)).body.config.kpiGoals).toEqual([]);
  });

  test("structured spend matches the summary sentence and ignores denied requests", async () => {
    const cfg = (await call("GET", `/api/apps/${localId}/growth/config`)).body.config;
    const at = new Date(new Date(cfg.budget.periodStart).getTime() + 3600_000).toISOString();
    const entry = (id: string, amountUsd: number, allowed: boolean) =>
      JSON.stringify({
        timestamp: at,
        request: { id, category: "social_content", amountUsd, description: "t", requestedAt: at },
        decision: { allowed, reason: "", remainingMonthlyUsd: 0, remainingDailyUsd: null },
      });
    writeFileSync(join(LOCAL_REPO, "day2-spend-ledger.jsonl"), [entry("a", 30, true), entry("b", 999, false)].join("\n") + "\n");
    const res = await call("GET", `/api/apps/${localId}/growth/config`);
    expect(res.body.spend.spentUsd).toBe(30);
    expect(res.body.spend.byCategory).toEqual([{ category: "social_content", amountUsd: 30 }]);
    expect(res.body.budgetSummary).toContain("$30.00 of $120.00 used this month (25%)");
  });
});

describe("apps overview", () => {
  test("reports unknown approvals as null (no remote) and counts this month's auto-ships", async () => {
    writeFileSync(
      join(LOCAL_REPO, "day2-autonomy-audit.jsonl"),
      JSON.stringify({ timestamp: new Date().toISOString(), sourceId: "1", area: "ui", filesChanged: [], level: "L3", autoShip: true, reason: "r" }) + "\n",
    );
    const res = await call("GET", "/api/apps/overview");
    expect(res.status).toBe(200);
    const local = res.body.apps.find((a: { id: string }) => a.id === localId);
    expect(local).toMatchObject({ hasGitRemote: false, pendingApprovals: null, autoShippedThisMonth: 1, spentUsd: 30 });
    const remote = res.body.apps.find((a: { id: string }) => a.id === remoteId);
    expect(remote.hasGitRemote).toBe(true);
  }, 20_000);
});

describe("autonomy", () => {
  test("is unavailable without a git remote, and writes are refused", async () => {
    expect((await call("GET", `/api/apps/${localId}/autonomy/config`)).body.available).toBe(false);
    expect((await call("PUT", `/api/apps/${localId}/autonomy/areas/everything`, { pathGlobs: ["**"], level: "L3" })).status).toBe(409);
  });

  test("the app-wide area can be turned on and off on an app with a remote", async () => {
    const on = await call("PUT", `/api/apps/${remoteId}/autonomy/areas/everything`, { pathGlobs: ["**"], level: "L3" });
    expect(on.status).toBe(200);
    expect(on.body.config.areas).toContainEqual({ area: "everything", pathGlobs: ["**"], level: "L3" });
    expect(existsSync(join(REMOTE_REPO, ".day2-autonomy.json"))).toBe(true);
    const off = await call("DELETE", `/api/apps/${remoteId}/autonomy/areas/everything`);
    expect(off.body.config.areas.some((a: { area: string }) => a.area === "everything")).toBe(false);
  });
});

describe("app profile and brand DNA", () => {
  const profile = {
    purpose: "Splits bills",
    targetUsers: "Flatmates",
    featureMap: ["Receipts"],
    styleGuide: null,
    toneOfVoice: "Warm",
    businessModel: null,
    caveats: [],
    competitors: null,
    currentState: null,
    currentStateCaveat: "",
    scannedAt: "2026-10-08T00:00:00.000Z",
  };
  const brand = {
    positioning: " Money between friends, minus the awkward. ",
    personality: ["warm"],
    audience: { primary: "Flatmates", segments: [], painPoints: [], motivations: [] },
    voice: { tone: "Warm", doSay: [], dontSay: ["jargon"], sampleLines: [] },
    visual: { palette: [{ hex: "#0F766E", role: "primary" }, { hex: "teal", role: "bad" }], typography: null, imagery: null, designLanguage: null },
    channels: { ads: null, social: null, email: null, outreach: null },
  };

  test("an incomplete brand is rejected and nothing is saved", async () => {
    const res = await call("PUT", `/api/apps/${localId}/onboarding/profile`, { ...profile, brand: { ...brand, positioning: "" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Brand DNA is incomplete/);
    expect((await call("GET", `/api/apps/${localId}/onboarding/profile`)).body.profile).toBeNull();
  });

  test("a valid brand is normalized before saving", async () => {
    expect((await call("PUT", `/api/apps/${localId}/onboarding/profile`, { ...profile, brand })).status).toBe(200);
    const saved = (await call("GET", `/api/apps/${localId}/onboarding/profile`)).body;
    expect(saved.profile.brand.positioning).toBe("Money between friends, minus the awkward.");
    expect(saved.profile.brand.visual.palette).toEqual([{ hex: "#0f766e", role: "primary" }]);
    expect(saved.rendered).toContain("## Brand DNA");
  });

  test("a profile without brand DNA is still accepted", async () => {
    expect((await call("PUT", `/api/apps/${remoteId}/onboarding/profile`, { ...profile, brand: null })).status).toBe(200);
  });
});

describe("ask day2 (no agent call)", () => {
  test("validates the question before doing anything expensive", async () => {
    expect((await call("POST", `/api/apps/${localId}/ask`, { question: "  " })).status).toBe(400);
    expect((await call("POST", `/api/apps/${localId}/ask`, { question: "x".repeat(2001) })).status).toBe(400);
    expect((await call("POST", `/api/apps/${localId}/ask`, {})).status).toBe(400);
    expect((await call("POST", "/api/apps/nope/ask", { question: "hi" })).status).toBe(404);
  });

  test("returns the ask log newest first", async () => {
    writeFileSync(
      join(LOCAL_REPO, ASK_LOG_FILENAME),
      [
        { askedAt: "2026-10-01T00:00:00Z", question: "old", answer: "A", costUsd: 0 },
        { askedAt: "2026-10-02T00:00:00Z", question: "new", answer: "B", costUsd: 0 },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const res = await call("GET", `/api/apps/${localId}/ask`);
    expect(res.body.entries.map((e: { question: string }) => e.question)).toEqual(["new", "old"]);
  });
});

describe("operator, unknown routes and removal", () => {
  test("operator endpoint always returns a name", async () => {
    const res = await call("GET", "/api/operator");
    expect(res.status).toBe(200);
    expect(res.body.name.length).toBeGreaterThan(0);
  });

  test("removing an app only forgets it — its files stay", async () => {
    expect((await call("DELETE", `/api/apps/${localId}`)).status).toBe(200);
    expect((await call("GET", `/api/apps/${localId}/growth/config`)).status).toBe(404);
    expect(existsSync(join(LOCAL_REPO, ".day2-budget.json"))).toBe(true);
  });
});
