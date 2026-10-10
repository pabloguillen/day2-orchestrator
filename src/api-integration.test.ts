import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "./api-server";
import { ASK_LOG_FILENAME } from "./ask-day2";
import { listUsdForCredits, recordCharge } from "./credits";

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
  expect(a.status).toBe(201);
  // A new account is a one-app trial — the second app needs a plan.
  const refused = await call("POST", "/api/apps", { name: "it-local", repoPath: LOCAL_REPO, connectionMethod: "local_path" });
  expect(refused.status).toBe(402);
  expect(refused.body.error).toMatch(/Trial plan includes 1 app/);
  expect((await call("PUT", "/api/credits/plan", { plan: "growth", billingCycle: "monthly" })).status).toBe(200);
  const b = await call("POST", "/api/apps", { name: "it-local", repoPath: LOCAL_REPO, connectionMethod: "local_path" });
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

describe("per-app credits and growth config", () => {
  test("a new app has used no credits and has no cap", async () => {
    const res = await call("GET", `/api/apps/${localId}/growth/config`);
    expect(res.status).toBe(200);
    expect(res.body.credits).toMatchObject({ usedThisMonth: 0, usedToday: 0, caps: {} });
    expect(res.body.credits.byDay).toHaveLength(8);
    expect(res.body.spend).toBeUndefined();
  });

  test("credit caps round-trip and keep the growth budget rails in step", async () => {
    const set = await call("PUT", `/api/apps/${localId}/credits/caps`, { monthlyCredits: 6000, dailyCredits: 1500 });
    expect(set.status).toBe(200);
    expect(set.body.credits.caps).toEqual({ monthlyCredits: 6000, dailyCredits: 1500 });
    expect(set.body.config.budget).toMatchObject({ monthlyBudgetUsd: listUsdForCredits(6000), dailyCapUsd: listUsdForCredits(1500) });
    const cleared = await call("PUT", `/api/apps/${localId}/credits/caps`, { dailyCredits: null });
    expect(cleared.body.credits.caps).toEqual({ monthlyCredits: 6000 });
    expect(cleared.body.config.budget.dailyCapUsd).toBeUndefined();
    expect((await call("PUT", `/api/apps/${localId}/credits/caps`, { monthlyCredits: -5 })).status).toBe(400);
    expect((await call("PUT", `/api/apps/${localId}/credits/caps`, { monthlyCredits: 1.5 })).status).toBe(400);
    expect((await call("PUT", "/api/apps/nope/credits/caps", { monthlyCredits: 5 })).status).toBe(404);
  });

  test("kill switch and goals still round-trip through the files", async () => {
    await call("PUT", `/api/apps/${localId}/growth/kill-switch`, { killSwitch: true });
    await call("PUT", `/api/apps/${localId}/growth/kpi-goals/wau`, { target: 500, byDate: "2026-12-31" });
    const res = await call("GET", `/api/apps/${localId}/growth/config`);
    expect(res.body.config.budget.killSwitch).toBe(true);
    expect(res.body.config.kpiGoals).toEqual([{ metric: "wau", target: 500, byDate: "2026-12-31" }]);
    await call("DELETE", `/api/apps/${localId}/growth/kpi-goals/wau`);
    await call("PUT", `/api/apps/${localId}/growth/kill-switch`, { killSwitch: false });
    expect((await call("GET", `/api/apps/${localId}/growth/config`)).body.config.kpiGoals).toEqual([]);
  });

  test("the kill switch stops agent work before it starts (402, no agent call)", async () => {
    await call("PUT", `/api/apps/${localId}/growth/kill-switch`, { killSwitch: true });
    const ask = await call("POST", `/api/apps/${localId}/ask`, { question: "How are signups?" });
    expect(ask.status).toBe(402);
    expect(ask.body.code).toBe("kill_switch");
    const scan = await call("POST", `/api/apps/${localId}/onboarding/scan`);
    expect(scan.status).toBe(402);
    await call("PUT", `/api/apps/${localId}/growth/kill-switch`, { killSwitch: false });
  });

  test("usage shows up per app, per service and per day", async () => {
    await recordCharge({ dir: ROOT }, { id: "it-1", appId: localId, service: "scan_answer", costUsd: 0.5, description: "App scan" });
    const res = await call("GET", `/api/apps/${localId}/growth/config`);
    expect(res.body.credits.usedThisMonth).toBeGreaterThan(0);
    expect(res.body.credits.byService[0]).toMatchObject({ service: "scan_answer", name: "Scans & answers", count: 1 });
    expect(res.body.credits.byDay.at(-1).credits).toBe(res.body.credits.usedThisMonth);
  });

  test("growth feed and formats only ever show credits, never day2's cost", async () => {
    const record = {
      id: "r1",
      timestamp: new Date().toISOString(),
      strategy: { stage: "pre_launch", channel: "paid_ads" },
      arm: { channel: "paid_ads", assetType: "image", formatTag: "x" },
      toolUsed: null,
      frequency: "once",
      spend: { requested: 12.34, allowed: true, runningMonthlyTotalUsd: 12.34, monthlyBudgetUsd: 100 },
      claimsCheck: { truthful: true, fabricatesTestimonialIdentity: false, issues: [] },
      authenticityCheck: { readsAsGeneric: false, issues: [] },
      executionResult: "simulated_stopped_before_live_action",
    };
    writeFileSync(join(LOCAL_REPO, "day2-growth-actions.jsonl"), JSON.stringify(record) + "\n");
    writeFileSync(
      join(LOCAL_REPO, "day2-allocator-state.json"),
      JSON.stringify({ arms: [{ arm: record.arm, attempts: 1, successes: 0, spendUsd: 12.34 }], updatedAt: record.timestamp }),
    );
    const feed = await call("GET", `/api/apps/${localId}/growth/feed`);
    expect(feed.body.records[0].spend).toEqual({ credits: expect.any(Number), allowed: true });
    expect(JSON.stringify(feed.body)).not.toContain("12.34");
    const formats = await call("GET", `/api/apps/${localId}/growth/allocator`);
    expect(formats.body.state.arms[0].spendCredits).toBeGreaterThan(0);
    expect(JSON.stringify(formats.body)).not.toContain("12.34");
  });
});

describe("plan & credits", () => {
  test("one balance for the account; nothing reveals cost or markup", async () => {
    const res = await call("GET", "/api/credits");
    expect(res.status).toBe(200);
    expect(res.body.plan.id).toBe("growth");
    expect(res.body.balance.allowance).toBe(8500);
    expect(res.body.catalog.plans.map((p: { id: string }) => p.id)).toEqual(["trial", "starter", "growth", "scale"]);
    expect(res.body.catalog.paymentsConnected).toBe(false);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/costUsd|markup|MARKUP|eurCents"/);
  });

  test("top-ups, auto top-up and plan changes", async () => {
    const topUp = await call("POST", "/api/credits/top-ups", { packId: "1k" });
    expect(topUp.status).toBe(201);
    expect(topUp.body.balance.topUp).toBe(1000);
    expect((await call("POST", "/api/credits/top-ups", { packId: "nope" })).status).toBe(400);
    const auto = await call("PUT", "/api/credits/auto-top-up", { enabled: true, packId: "10k" });
    expect(auto.body.autoTopUp).toEqual({ enabled: true, packId: "10k" });
    expect((await call("PUT", "/api/credits/auto-top-up", { enabled: "yes" })).status).toBe(400);
    const up = await call("PUT", "/api/credits/plan", { plan: "scale", billingCycle: "monthly" });
    expect(up.body.effective).toBe("now");
    expect(up.body.plan.id).toBe("scale");
    const down = await call("PUT", "/api/credits/plan", { plan: "starter", billingCycle: "yearly" });
    expect(down.body.effective).toBe("next_month");
    expect(down.body.pendingPlan).toMatchObject({ plan: "starter", billingCycle: "yearly" });
    expect((await call("PUT", "/api/credits/plan", { plan: "trial" })).status).toBe(400);
    expect((await call("PUT", "/api/credits/plan", { plan: "growth", billingCycle: "weekly" })).status).toBe(400);
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
    expect(local).toMatchObject({ hasGitRemote: false, pendingApprovals: null, autoShippedThisMonth: 1, monthlyCreditCap: 6000 });
    expect(local.creditsUsedThisMonth).toBeGreaterThan(0);
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
        { askedAt: "2026-10-01T00:00:00Z", question: "old", answer: "A", credits: 0 },
        { askedAt: "2026-10-02T00:00:00Z", question: "new", answer: "B", credits: 0 },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const res = await call("GET", `/api/apps/${localId}/ask`);
    expect(res.body.entries.map((e: { question: string }) => e.question)).toEqual(["new", "old"]);
  });
});

describe("backlog", () => {
  test("starts empty with the default rules; work needs a git remote", async () => {
    const res = await call("GET", `/api/apps/${localId}/backlog`);
    expect(res.status).toBe(200);
    expect(res.body.tickets).toEqual([]);
    expect(res.body.settings.rules.map((r: { kind: string }) => r.kind)).toEqual(["builtin", "builtin", "builtin", "builtin", "builtin"]);
    expect(res.body.canWork).toBe(false);
    expect((await call("GET", `/api/apps/${remoteId}/backlog`)).body.canWork).toBe(true);
    expect(res.body.integrations).toEqual({ linear: { connected: false }, jira: { connected: false } });
  });

  test("creating tickets: validation, pinning, day2 decides when no priority", async () => {
    expect((await call("POST", `/api/apps/${localId}/backlog/tickets`, { title: " ", type: "bug" })).status).toBe(400);
    expect((await call("POST", `/api/apps/${localId}/backlog/tickets`, { title: "x", type: "epic" })).status).toBe(400);
    expect((await call("POST", `/api/apps/${localId}/backlog/tickets`, { title: "x", type: "bug", priority: 7 })).status).toBe(400);
    const a = await call("POST", `/api/apps/${localId}/backlog/tickets`, { title: "Export to CSV", type: "feature", description: "One CSV per group", priority: 2 });
    expect(a.status).toBe(201);
    expect(a.body.ticket).toMatchObject({ id: "D2-1", priority: 2, pinned: true, source: { kind: "user" }, state: "todo" });
    const b = await call("POST", `/api/apps/${localId}/backlog/tickets`, { title: "Typo on Groups", type: "task" });
    expect(b.body.ticket).toMatchObject({ id: "D2-2", priority: 3, pinned: false });
    expect(existsSync(join(LOCAL_REPO, "day2-backlog.json"))).toBe(true);
  });

  test("editing: rename, pin and unpin, comment, and states day2 owns are refused", async () => {
    const r = await call("PATCH", `/api/apps/${localId}/backlog/tickets/D2-2`, { title: "Fix typo on Groups", priority: 1 });
    expect(r.body.ticket).toMatchObject({ title: "Fix typo on Groups", priority: 1, pinned: true });
    const back = await call("PATCH", `/api/apps/${localId}/backlog/tickets/D2-2`, { priority: null });
    expect(back.body.ticket.pinned).toBe(false);
    expect((await call("PATCH", `/api/apps/${localId}/backlog/tickets/D2-2`, { state: "doing" })).status).toBe(400);
    expect((await call("PATCH", `/api/apps/${localId}/backlog/tickets/D2-9`, { title: "x" })).status).toBe(404);
    const c = await call("POST", `/api/apps/${localId}/backlog/tickets/D2-2/comments`, { text: "Seen on mobile too" });
    expect(c.status).toBe(201);
    expect(c.body.ticket.activity.at(-1)).toMatchObject({ kind: "comment", actor: "user", text: "Seen on mobile too" });
    expect((await call("POST", `/api/apps/${localId}/backlog/tickets/D2-2/comments`, { text: "" })).status).toBe(400);
  });

  test("working on a ticket needs a git remote; approving needs something to approve", async () => {
    const w = await call("POST", `/api/apps/${localId}/backlog/tickets/D2-2/work`);
    expect(w.status).toBe(409);
    expect(w.body.error).toMatch(/no connected git remote/);
    expect((await call("POST", `/api/apps/${localId}/backlog/tickets/D2-2/approve`)).status).toBe(409);
  });

  test("rules & limits round-trip and re-rank", async () => {
    const r = await call("PUT", `/api/apps/${localId}/backlog/settings`, {
      wipLimit: 3,
      weights: { competition: 2 },
      autoStart: { features: true },
      rules: [{ id: "r-stale", enabled: false }, { text: "Bugs before features this week" }],
    });
    expect(r.status).toBe(200);
    expect(r.body.settings).toMatchObject({ wipLimit: 3, autoStart: { features: true } });
    expect(r.body.settings.rules.find((x: { text: string }) => x.text === "Bugs before features this week").kind).toBe("custom");
    expect((await call("PUT", `/api/apps/${localId}/backlog/settings`, { wipLimit: 99 })).status).toBe(400);
    expect((await call("POST", `/api/apps/${localId}/backlog/rerank`)).body.changes).toEqual([]);
  });

  test("Tell: validates first, and the kill switch stops it before any agent runs", async () => {
    expect((await call("POST", `/api/apps/${localId}/backlog/tell`, { instruction: " " })).status).toBe(400);
    expect((await call("POST", `/api/apps/${localId}/backlog/tell`, { instruction: "x", answerTo: "nope" })).status).toBe(404);
    await call("PUT", `/api/apps/${localId}/growth/kill-switch`, { killSwitch: true });
    const r = await call("POST", `/api/apps/${localId}/backlog/tell`, { instruction: "Bugs before features" });
    expect(r.status).toBe(402);
    await call("PUT", `/api/apps/${localId}/growth/kill-switch`, { killSwitch: false });
  });

  test("Tell undo restores the backlog", async () => {
    const { applyTellPlan, parseTellPlan, saveTellLog } = await import("./backlog-tell");
    const { loadBacklog, saveBacklog } = await import("./backlog");
    const file = join(LOCAL_REPO, "day2-backlog.json");
    const applied = applyTellPlan(
      loadBacklog(file),
      parseTellPlan('{"summary":"s","operations":[{"op":"park","id":"D2-2"},{"op":"create","title":"New","type":"task"}]}')!,
      "Park the typo",
      new Date(),
    );
    saveBacklog(file, applied.backlog);
    saveTellLog(join(LOCAL_REPO, "day2-backlog-tell.json"), [applied.record]);
    expect((await call("GET", `/api/apps/${localId}/backlog/tell`)).body.records).toHaveLength(1);
    const undo = await call("POST", `/api/apps/${localId}/backlog/tell/${applied.record.id}/undo`, {});
    expect(undo.status).toBe(200);
    expect(undo.body.record.changes.every((c: { undone?: boolean }) => c.undone)).toBe(true);
    expect(undo.body.tickets.find((t: { id: string }) => t.id === "D2-2").state).toBe("todo");
    expect(undo.body.tickets.some((t: { title: string }) => t.title === "New")).toBe(false);
    expect((await call("POST", `/api/apps/${localId}/backlog/tell/nope/undo`, {})).status).toBe(404);
  });

  test("JIRA/Linear connections: validated, stored without exposing tokens, removable", async () => {
    expect((await call("PUT", `/api/apps/${localId}/integrations/jira`, { site: "acme", email: "a@b.c", apiToken: "t", projectKey: "EB" })).status).toBe(400);
    const ok = await call("PUT", `/api/apps/${localId}/integrations/jira`, { site: "https://acme.atlassian.net/", email: "a@b.c", apiToken: "secret-token", projectKey: "EB" });
    expect(ok.status).toBe(200);
    expect(ok.body.jira).toMatchObject({ connected: true, site: "https://acme.atlassian.net", projectKey: "EB", label: "day2", mirror: false });
    expect(JSON.stringify((await call("GET", `/api/apps/${localId}/integrations`)).body)).not.toContain("secret-token");
    expect(JSON.stringify((await call("GET", `/api/apps/${localId}/backlog`)).body)).not.toContain("secret-token");
    expect((await call("PUT", `/api/apps/${localId}/integrations/github`, {})).status).toBe(404);
    const off = await call("DELETE", `/api/apps/${localId}/integrations/jira`);
    expect(off.body.jira).toEqual({ connected: false });
    expect((await call("POST", `/api/apps/${localId}/backlog/sync`)).status).toBe(409);
  });

  test("deleting a ticket", async () => {
    expect((await call("DELETE", `/api/apps/${localId}/backlog/tickets/D2-1`)).status).toBe(200);
    expect((await call("DELETE", `/api/apps/${localId}/backlog/tickets/D2-1`)).status).toBe(404);
  });
});

describe("create an app with Lovable (no Lovable calls)", () => {
  test("hidden by default: the flag is off and every endpoint is unreachable", async () => {
    delete process.env.DAY2_FEATURE_CREATE_APPS;
    expect((await call("GET", "/api/features")).body).toMatchObject({ createApps: false, mode: "local" });
    expect((await call("GET", "/api/lovable")).status).toBe(404);
    expect((await call("POST", "/api/lovable/connect")).status).toBe(404);
    expect((await call("POST", "/api/apps/create", { name: "habit-loop", description: "A habit tracker for people who break streaks." })).status).toBe(404);
    expect((await call("GET", "/api/lovable/builds/x")).status).toBe(404);
  });

  test("status, validation, and a clear refusal while day2's Lovable account isn't connected", async () => {
    process.env.DAY2_FEATURE_CREATE_APPS = "on";
    expect((await call("GET", "/api/features")).body).toMatchObject({ createApps: true });
    const prevKey = process.env.DAY2_LOVABLE_API_KEY;
    delete process.env.DAY2_LOVABLE_API_KEY;
    const status = await call("GET", "/api/lovable");
    expect(status.body).toMatchObject({ connected: false, method: null, builds: [] });
    expect(status.body.estimateCredits).toBeGreaterThan(0);
    expect((await call("POST", "/api/apps/create", { name: "Bad Name", description: "x".repeat(40) })).status).toBe(400);
    const r = await call("POST", "/api/apps/create", { name: "habit-loop", description: "A habit tracker for people who break streaks." });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Lovable account isn't connected/);
    expect((await call("GET", "/api/lovable/builds/nope")).status).toBe(404);
    expect((await call("POST", "/api/lovable/builds/nope/answer", { decision: "maybe" })).status).toBe(400);
    if (prevKey !== undefined) process.env.DAY2_LOVABLE_API_KEY = prevKey;
    delete process.env.DAY2_FEATURE_CREATE_APPS;
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
