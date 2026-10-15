import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "./apps-registry";
import { createTicket, emptyBacklog, findTicket, loadBacklog, saveBacklog, updateTicket } from "./backlog";
import { backlogFile, parsePlan, proposalItems, reconcileApprovals, reportForTicket, runTicket, signalItems, startTicket, tick } from "./backlog-work";
import type { PipelineDeps } from "./pipeline";

const ROOT = mkdtempSync(join(tmpdir(), "day2-backlog-work-"));
const REPO = join(ROOT, "app");
const app: AppEntry = { id: "a1", name: "buddy", repoPath: REPO, connectionMethod: "local_path", addedAt: "2026-10-01T00:00:00Z" };
const now = new Date("2026-10-10T12:00:00Z");

beforeAll(() => {
  mkdirSync(REPO);
  execSync("git init -q && git remote add origin https://github.com/example/buddy", { cwd: REPO });
});
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function seed(type: "bug" | "feature" = "bug") {
  let b = emptyBacklog();
  b = createTicket(b, { title: "Rounding is off", type, description: "Split totals off by a cent", doneWhen: ["Totals add up"], source: { kind: "user" } }, now).backlog;
  saveBacklog(backlogFile(app), b);
}

function fakeDeps(result: "pr" | "fail"): Partial<PipelineDeps> {
  const ok = { finalText: "done", isError: false, costUsd: 0, numTurns: 1 };
  return {
    cloneIsolatedWorkspace: async () => join(ROOT, "clone"),
    createFixBranch: async () => "day2-fix-x",
    runFixAgent: async () => (result === "fail" ? { ...ok, isError: true, finalText: "could not reproduce" } : ok),
    hasChanges: async () => true,
    diffStat: async () => " test/rounding.test.ts | 10 +\n src/split.ts | 2 +-",
    commitAll: async () => {},
    runVerifierAgent: async () => ({ ...ok, finalText: "VERDICT: APPROVE" }),
    pushBranch: async () => {},
    openFixPr: async () => "https://github.com/example/buddy/pull/42",
    removeWorkspace: () => {},
  };
}

describe("working on a ticket", () => {
  test("the report carries the description, Done when and an approved plan", () => {
    seed();
    const t = loadBacklog(backlogFile(app)).tickets[0]!;
    const r = reportForTicket({ ...t, approval: { kind: "plan", plan: "1. Do it" } });
    expect(r.description).toContain("Split totals off by a cent");
    expect(r.description).toContain("- Totals add up");
    expect(r.description).toContain("Approved plan:\n1. Do it");
    expect(r.source).toBe("manual");
  });

  test("start → Doing; a PR moves it to To be approved with the PR link", async () => {
    seed();
    let job: Promise<unknown> | null = null;
    const started = await startTicket(app, "D2-1", { run: (a, id) => (job = runTicket(a, id, fakeDeps("pr"))) });
    expect(started).toMatchObject({ ok: true, started: "pipeline" });
    expect(findTicket(loadBacklog(backlogFile(app)), "D2-1")!.state).toBe("doing");
    await job;
    const t = findTicket(loadBacklog(backlogFile(app)), "D2-1")!;
    expect(t.state).toBe("to_approve");
    expect(t.approval).toEqual({ kind: "pr", number: 42, url: "https://github.com/example/buddy/pull/42" });
    expect(t.activity.at(-1)!.text).toMatch(/opened PR #42/);
    expect(t.progress).toBeUndefined();
    const again = await startTicket(app, "D2-1", { run: async () => {} });
    expect(again).toMatchObject({ ok: false, status: 409 });
  });

  test("a failed attempt goes back to To do with the reason", async () => {
    seed();
    let job: Promise<unknown> | null = null;
    await startTicket(app, "D2-1", { run: (a, id) => (job = runTicket(a, id, fakeDeps("fail"))) });
    await job;
    const t = findTicket(loadBacklog(backlogFile(app)), "D2-1")!;
    expect(t.state).toBe("todo");
    expect(t.activity.at(-1)!.text).toMatch(/couldn't reproduce or fix it: could not reproduce\. Back in To do\./);
  });

  test("features get a plan first when the rule says so", async () => {
    seed("feature");
    let planned = false;
    const r = await startTicket(app, "D2-1", { plan: async () => void (planned = true), run: async () => {} });
    expect(r).toMatchObject({ ok: true, started: "plan" });
    expect(planned).toBe(true);
    expect(findTicket(loadBacklog(backlogFile(app)), "D2-1")!.progress).toMatchObject({ label: "writing a plan" });
  });

  test("refuses without a git remote and for unknown tickets", async () => {
    seed();
    const local = { ...app, repoPath: ROOT };
    expect(await startTicket(local, "D2-1")).toMatchObject({ ok: false, status: 409 });
    expect(await startTicket(app, "D2-99", { run: async () => {} })).toMatchObject({ ok: false, status: 404 });
  });

  test("out of credits: nothing moves; the autopilot says so once, not every pass", async () => {
    seed();
    const broke = async () => ({ ok: false as const, reason: "Not enough credits — this can use up to 855 and 400 are left. Top up or change your plan." });
    let ran = false;
    for (let pass = 0; pass < 3; pass++) {
      const r = await startTicket(app, "D2-1", { by: "day2", afford: broke, run: async () => void (ran = true) });
      expect(r).toMatchObject({ ok: false, status: 402 });
    }
    expect(ran).toBe(false);
    const t = findTicket(loadBacklog(backlogFile(app)), "D2-1")!;
    expect(t.state).toBe("todo");
    const notes = t.activity.filter((a) => a.text.startsWith("waiting for credits"));
    expect(notes).toHaveLength(1);
    expect(t.activity.some((a) => a.kind === "state")).toBe(false);
    // The owner clicking Start gets the reason back; nothing is logged.
    const mine = await startTicket(app, "D2-1", { afford: broke, run: async () => {} });
    expect(mine).toMatchObject({ ok: false, status: 402, reason: expect.stringContaining("Not enough credits") });
    expect(findTicket(loadBacklog(backlogFile(app)), "D2-1")!.activity).toHaveLength(t.activity.length);
  });

  test("when day2 starts a ticket, the move is day2's, not the owner's", async () => {
    seed();
    await startTicket(app, "D2-1", { by: "day2", afford: async () => ({ ok: true }), run: async () => {} });
    const t = findTicket(loadBacklog(backlogFile(app)), "D2-1")!;
    const move = t.activity.find((a) => a.kind === "state")!;
    expect(move.actor).toBe("day2");
  });

  test("plans are parsed strictly", () => {
    expect(parsePlan('{"plan":"1. a\\n2. b","doneWhen":["x",3],"effort":"M"}')).toEqual({ plan: "1. a\n2. b", doneWhen: ["x"], effort: "M" });
    expect(parsePlan('{"doneWhen":[]}')).toBeNull();
    expect(parsePlan("nope")).toBeNull();
  });
});

describe("sources and reconciling", () => {
  test("proposals become feature tickets; Sentry findings become bugs with their own counts", () => {
    writeFileSync(
      join(REPO, "day2-proposals.jsonl"),
      JSON.stringify({ title: "Recurring reminders", rationale: "r", observedEvidence: "38% of expenses repeat monthly", proposedContract: "c", openQuestions: [], recordedAt: now.toISOString() }) + "\n",
    );
    const p = proposalItems(app);
    expect(p[0]).toMatchObject({ type: "feature", title: "Recurring reminders", signals: { usageNote: "38% of expenses repeat monthly" } });
    const s = signalItems([
      { id: "sentry-1", source: "sentry", appId: "a1", at: now.toISOString(), finding: "TypeError in split", evidence: { permalink: "https://sentry.io/1" }, occurrences: 41, affectedUsers: 23, suggestedAction: "Fix it" },
    ]);
    expect(s[0]).toMatchObject({ type: "bug", source: { kind: "sentry", key: "sentry-1", url: "https://sentry.io/1" }, signals: { users: 23, errors: 41, errorsNote: "41 Sentry events, 23 people affected." } });
  });

  test("merged PRs finish tickets, closed ones go back to To do", () => {
    let b = emptyBacklog();
    for (const title of ["a", "b", "c"]) b = createTicket(b, { title, type: "bug", source: { kind: "user" } }, now).backlog;
    for (const id of ["D2-1", "D2-2", "D2-3"]) {
      b = updateTicket(b, id, { state: "done" }, now).backlog;
      b = { ...b, tickets: b.tickets.map((t) => (t.id === id ? { ...t, state: "to_approve" as const, approval: { kind: "pr" as const, number: 1, url: "u" } } : t)) };
    }
    const r = reconcileApprovals(b, new Map([["D2-1", "MERGED"], ["D2-2", "CLOSED"], ["D2-3", "OPEN"]]), now);
    expect(r.changed).toEqual(["D2-1", "D2-2"]);
    expect(r.backlog.tickets.map((t) => t.state)).toEqual(["done", "todo", "to_approve"]);
  });

  test("tick imports, ranks and starts within the owner's limits", async () => {
    saveBacklog(backlogFile(app), emptyBacklog());
    const started: string[] = [];
    const report = await tick(app, {
      gatherSignals: async () => [
        { id: "sentry-9", source: "sentry", appId: "a1", at: now.toISOString(), finding: "Crash on save", evidence: {}, occurrences: 80, affectedUsers: 30, suggestedAction: "Fix" },
      ],
      startWork: true,
      start: async (_a, id) => {
        started.push(id);
        return { ok: true, ticket: findTicket(loadBacklog(backlogFile(app)), id)!, started: "pipeline" };
      },
      now,
    });
    expect(report.created).toHaveLength(2); // the proposal + the Sentry bug
    const bug = loadBacklog(backlogFile(app)).tickets.find((t) => t.title === "Crash on save")!;
    expect(bug.priority).toBe(1);
    expect(started).toEqual([bug.id]); // features don't start on their own
    expect(report.started).toEqual([bug.id]);
  });
});
