import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../api-server";
import { createTicket, emptyBacklog, saveBacklog, BACKLOG_FILENAME } from "../backlog";
import { addIdeas } from "../live/ideas";
import { liveStore } from "../live/runtime";
import { resetLearningSalt } from "../learning/runtime";
import { makeOutcome, type Outcome } from "../learning/library";
import { fileLearningStore } from "../learning/store";
import { checkProposal, filterProposals, memoryFor, noteDecline } from "./runtime";
import { MEMORY_FILENAME } from "./types";

/**
 * Memory and learning through the real router in local mode: the "What
 * day2 knows" API, declines with a reason from the ticket page and Live,
 * custom rules mirrored, the hard filter, memoryFor, the account opt-out
 * and the operator's view. No agent calls.
 */

const ROOT = mkdtempSync(join(tmpdir(), "day2-api-memory-"));
const REPO = join(ROOT, "dotty");
const saved: Record<string, string | undefined> = {};
let appId = "";

async function call(method: string, path: string, body?: unknown) {
  const res = await handleRequest(new Request(`http://localhost:4700${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  for (const k of ["DAY2_APPS_REGISTRY_PATH", "DAY2_DATA_DIR", "DAY2_BACKLOG_TICK_MINUTES", "DAY2_LEARNING_SALT"]) saved[k] = process.env[k];
  process.env.DAY2_APPS_REGISTRY_PATH = join(ROOT, "apps.json");
  process.env.DAY2_DATA_DIR = ROOT;
  process.env.DAY2_LEARNING_SALT = "test-salt";
  resetLearningSalt();
  mkdirSync(join(REPO, "app"), { recursive: true });
  writeFileSync(join(REPO, "package.json"), JSON.stringify({ name: "dotty", dependencies: { expo: "54.0.0", "react-native": "0.81.0" } }));
  execSync("git init -q", { cwd: REPO });
  const r = await call("POST", "/api/apps", { name: "Dotty", repoPath: REPO, connectionMethod: "local_path" });
  expect(r.status).toBe(201);
  appId = r.body.app.id;
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetLearningSalt();
  rmSync(ROOT, { recursive: true, force: true });
});

const app = () => ({ id: appId, name: "Dotty", repoPath: REPO });

describe("What day2 knows (API)", () => {
  test("starts empty; the owner adds, edits, confirms and retires items", async () => {
    expect((await call("GET", `/api/apps/${appId}/memory`)).body).toMatchObject({ items: [], needsConfirmation: 0, waiting: 0 });
    const add = await call("POST", `/api/apps/${appId}/memory/items`, { kind: "audience", text: "Most users are nurses on night shifts." });
    expect(add.status).toBe(200);
    const id = add.body.created as string;
    expect(add.body.items[0]).toMatchObject({ id, kind: "audience", status: "active", source: { kind: "owner_comment" } });
    const edit = await call("PATCH", `/api/apps/${appId}/memory/items/${id}`, { text: "Most users are nurses and doctors on night shifts." });
    expect(edit.body.items[0]).toMatchObject({ text: "Most users are nurses and doctors on night shifts.", source: { kind: "correction" } });
    const bad = await call("POST", `/api/apps/${appId}/memory/items`, { kind: "fact", text: "Our admin is boss@dotty.app" });
    expect(bad.status).toBe(400);
    expect(bad.body.error ?? bad.body.message ?? JSON.stringify(bad.body)).toContain("individual users");
    const gone = await call("POST", `/api/apps/${appId}/memory/items/${id}/retire`);
    expect(gone.body.items).toEqual([]);
    expect(gone.body.retired[0].id).toBe(id);
    await call("POST", `/api/apps/${appId}/memory/items/${id}/restore`);
  });

  test("memoryFor puts it in prompts and records when it was used", async () => {
    const block = await memoryFor(app(), "store");
    expect(block).toContain("## What day2 knows about this app");
    expect(block).toContain("nurses and doctors");
    const after = (await call("GET", `/api/apps/${appId}/memory`)).body.items[0];
    expect(after.lastUsedFor).toBe("store");
    expect(after.lastUsedAt).toBeTruthy();
  });

  test("custom backlog rules become rule items at once", async () => {
    saveBacklog(join(REPO, BACKLOG_FILENAME), emptyBacklog());
    const cur = (await call("GET", `/api/apps/${appId}/backlog`)).body.settings.rules as Array<{ id: string }>;
    const r = await call("PUT", `/api/apps/${appId}/backlog/settings`, { rules: [...cur, { text: "Never change the sign-in screen without asking." }] });
    expect(r.status).toBe(200);
    const items = (await call("GET", `/api/apps/${appId}/memory`)).body.items as Array<{ kind: string; text: string; status: string; source: { kind: string } }>;
    expect(items.find((i) => i.kind === "rule")).toMatchObject({ text: "Never change the sign-in screen without asking.", status: "active", source: { kind: "backlog_rule" } });
  });

  test("declining a plan with a reason: parked, blocked for 90 days, and waiting for the memory keeper", async () => {
    const file = join(REPO, BACKLOG_FILENAME);
    let b = emptyBacklog();
    const c = createTicket(b, { title: "Dark mode", type: "feature", source: { kind: "day2_proposal", key: "loop:dark-mode" } }, new Date());
    b = { ...c.backlog, tickets: c.backlog.tickets.map((t) => ({ ...t, state: "to_approve" as const, approval: { kind: "plan" as const, plan: "1. Add a theme" } })) };
    saveBacklog(file, b);
    const r = await call("POST", `/api/apps/${appId}/backlog/tickets/${c.ticket.id}/reject`, { reason: "Our users work at night but the brand is light only." });
    expect(r.status).toBe(200);
    expect(r.body.ticket.state).toBe("parked");
    const mem = (await call("GET", `/api/apps/${appId}/memory`)).body;
    expect(mem.declines[0]).toMatchObject({ key: "backlog.ticket:loop:dark-mode", reason: "Our users work at night but the brand is light only." });
    expect(mem.waiting).toBeGreaterThanOrEqual(1);
    expect((await checkProposal(app(), "backlog.ticket", "loop:dark-mode")).blocked).toBe(true);
    const lifted = await call("POST", `/api/apps/${appId}/memory/declines/lift`, { key: "backlog.ticket:loop:dark-mode" });
    expect(lifted.body.declines).toEqual([]);
  });

  test("“Not now” on a Live idea with a reason blocks ideas on the same settings", async () => {
    await liveStore().update(appId, (s) => ({ state: addIdeas(s, [{ title: "Shorter trial", hypothesis: "h", why: "w", keys: ["paywall.trial_days"], variants: [{ name: "control", weight: 50, values: {} }, { name: "three", weight: 50, values: { "paywall.trial_days": 3 } }], metric: { kind: "retention_d7" } }], new Date()).state, result: null }));
    const idea = (await liveStore().get(appId)).ideas[0]!;
    const r = await call("POST", `/api/apps/${appId}/live/ideas/${idea.id}/dismiss`, { reason: "We never shorten the trial." });
    expect(r.status).toBe(200);
    const kept = await filterProposals(app(), "live.idea", [{ keys: ["paywall.trial_days"] }, { keys: ["onboarding.title"] }], (x) => [x.keys.join(","), ...x.keys]);
    expect(kept.kept).toEqual([{ keys: ["onboarding.title"] }]);
    expect(kept.blocked[0]!.why).toContain("We never shorten the trial.");
  });

  test("a decline without a reason still blocks, and nothing is queued for the keeper", async () => {
    const before = (await call("GET", `/api/apps/${appId}/memory`)).body.waiting as number;
    await noteDecline(app(), { kind: "store.text", target: "subtitle:en-US" });
    const after = (await call("GET", `/api/apps/${appId}/memory`)).body;
    expect(after.waiting).toBe(before);
    expect((await checkProposal(app(), "store.text", "subtitle:en-US")).blocked).toBe(true);
    expect(existsSync(join(REPO, MEMORY_FILENAME))).toBe(true);
    // The file never holds a secret the owner pasted.
    await call("POST", `/api/apps/${appId}/backlog/tickets/D2-1/comments`, { text: "Use key sk-ant-api03-abcdefghijklmnopqrstuvwx for tests" });
    expect(readFileSync(join(REPO, MEMORY_FILENAME), "utf-8")).not.toContain("sk-ant-api03");
  });
});

describe("What works (API)", () => {
  test("“What worked elsewhere”: shown from 3 other apps, never this app's own results", async () => {
    const store = fileLearningStore(join(ROOT, "day2-learning.json"));
    const mk = (appIdX: string, i: number, accountId = `acc-${i}`): Outcome =>
      (makeOutcome({ appId: appIdX, accountId, appName: `Other ${i}`, context: { category: "other", productType: "habit", platform: "both" }, kind: "paywall.trial_length", metric: "conversion", control: { n: 800, value: 0.1 }, treatment: { n: 800, value: 0.12 }, n: 1600, verdict: "better", source: "live", sourceId: `X-${i}`, at: new Date() }, "test-salt") as { outcome: Outcome }).outcome;
    await store.record(mk("a1", 1));
    await store.record(mk("a2", 2));
    let r = await call("GET", `/api/apps/${appId}/learning/worked?module=money`);
    expect(r.body.lines).toEqual([]);
    await store.record(mk(appId, 3, "local"));
    r = await call("GET", `/api/apps/${appId}/learning/worked?module=money`);
    expect(r.body.lines).toEqual([]);
    await store.record(mk("a4", 4));
    r = await call("GET", `/api/apps/${appId}/learning/worked?module=money`);
    expect(r.body.lines[0].text).toMatch(/^Free trial length: worked in 3 of 3 similar apps, typical \+\d+%/);
    const ideas = (await call("GET", `/api/apps/${appId}/learning/worked?module=live`)).body.ideas as Record<string, string>;
    expect(Object.values(ideas).join(" ")).not.toContain("Dotty");
  });

  test("the account's opt-out: on by default, off removes its apps' outcomes", async () => {
    expect((await call("GET", "/api/account/learning")).body).toMatchObject({ share: true });
    const off = await call("PUT", "/api/account/learning", { share: false });
    expect(off.body).toMatchObject({ share: false, removed: 1 });
    expect((await call("GET", "/api/account/learning")).body.note).toContain("Never your app's name");
    await call("PUT", "/api/account/learning", { share: true });
  });

  test("the operator sees anonymous outcomes and can approve playbook entries", async () => {
    const r = await call("GET", "/api/platform/learning");
    expect(r.status).toBe(200);
    expect(r.body.kinds[0]).toMatchObject({ kind: "paywall.trial_length", apps: 3 });
    expect(JSON.stringify(r.body)).not.toContain("appHash");
    expect(JSON.stringify(r.body)).not.toContain("Other 1");
    expect((await call("POST", "/api/platform/learning/playbook/nope", { status: "approved" })).status).toBe(404);
  });
});
