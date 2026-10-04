import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAlreadyProcessed, runPipeline, type PipelineDeps } from "./pipeline";
import type { BugReport } from "./types";

function bugReport(overrides: Partial<BugReport> = {}): BugReport {
  return {
    title: "Checkout fails",
    description: "TypeError in checkout",
    sourceId: "sentry-issue-1",
    source: "sentry",
    ...overrides,
  };
}

describe("isAlreadyProcessed", () => {
  test("a brand-new sourceId is not already processed", () => {
    expect(isAlreadyProcessed(new Set(), bugReport())).toBe(false);
  });

  test("a previously-seen sourceId is already processed", () => {
    const processed = new Set(["sentry-issue-1"]);
    expect(isAlreadyProcessed(processed, bugReport())).toBe(true);
  });

  test("the same Sentry issue reported again via a health-scout cluster is recognized as already processed", () => {
    // The classic sentry.ts path already processed this issue under its own sourceId...
    const processed = new Set(["sentry-issue-1", "https://sentry.io/organizations/x/issues/1/"]);
    // ...and a health-scout cluster corroborating the same issue carries a
    // different sourceId (its own report id) but the same correlationKey.
    const healthScoutReport = bugReport({
      sourceId: "report-health-scout-42",
      source: "health-scout",
      correlationKey: "https://sentry.io/organizations/x/issues/1/",
    });
    expect(isAlreadyProcessed(processed, healthScoutReport)).toBe(true);
  });

  test("a health-scout report with no correlationKey only matches on sourceId", () => {
    const processed = new Set(["some-other-report-id"]);
    const healthScoutReport = bugReport({
      sourceId: "report-health-scout-99",
      source: "health-scout",
      correlationKey: undefined,
    });
    expect(isAlreadyProcessed(processed, healthScoutReport)).toBe(false);
  });

  test("a matching correlationKey is sufficient even if sourceId differs and was never seen", () => {
    const processed = new Set(["https://sentry.io/organizations/x/issues/7/"]);
    const report = bugReport({
      sourceId: "report-health-scout-7",
      correlationKey: "https://sentry.io/organizations/x/issues/7/",
    });
    expect(isAlreadyProcessed(processed, report)).toBe(true);
  });
});

/**
 * `runPipeline` is day2's single most central orchestration function (clone
 * -> branch -> fix-agent -> verify-agent -> push -> PR -> dedup), but every
 * one of its real effects (git, the fix-agent, the verifier, PR creation)
 * is a live side effect against a real repo/agent/`gh`. `PipelineDeps`
 * (pipeline.ts) makes every one of those injectable, defaulted to the real
 * implementations for every actual caller — these tests substitute fakes to
 * exercise the orchestration logic itself: step ordering, the dedup
 * early-exit, and the real failure paths (fix-agent error, no changes, the
 * reproduce-first gate, verifier rejection), without a real git remote, a
 * real `gh`, or a real agent run.
 */
async function withStateFile<T>(fn: (stateFile: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "day2-pipeline-test-"));
  const stateFile = join(dir, "state.json");
  try {
    return await fn(stateFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function agentResult(
  overrides: Partial<{ finalText: string; isError: boolean; costUsd: number; numTurns: number }> = {},
) {
  return { finalText: "", isError: false, costUsd: 0.01, numTurns: 1, ...overrides };
}

// A real `git diff --stat` shape: file lines have " | ", the trailing
// "N files changed..." summary line never does.
const PASSING_DIFF_STAT =
  " src/checkout.ts      | 4 ++--\n" +
  " src/checkout.test.ts | 20 ++++++++++++++++++++\n" +
  " 2 files changed, 22 insertions(+), 2 deletions(-)";
const NO_TEST_FILE_DIFF_STAT = " src/checkout.ts | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)";

/** A fully "everything succeeds" set of fake deps, recording call order into
 * `calls` so a test can assert on it. Individual fields can be overridden
 * per test to exercise one specific failure path. */
function happyDeps(calls: string[], overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    cloneIsolatedWorkspace: async () => {
      calls.push("cloneIsolatedWorkspace");
      return "/fake/cwd";
    },
    createFixBranch: async () => {
      calls.push("createFixBranch");
      return "day2-fix-test-branch";
    },
    runFixAgent: async () => {
      calls.push("runFixAgent");
      return agentResult({ finalText: "## What happened\nIt broke.\n## What changed\nFixed it." });
    },
    hasChanges: async () => {
      calls.push("hasChanges");
      return true;
    },
    diffStat: async () => {
      calls.push("diffStat");
      return PASSING_DIFF_STAT;
    },
    commitAll: async () => {
      calls.push("commitAll");
    },
    runVerifierAgent: async () => {
      calls.push("runVerifierAgent");
      return agentResult({ finalText: "VERDICT: APPROVE" });
    },
    pushBranch: async () => {
      calls.push("pushBranch");
    },
    openFixPr: async () => {
      calls.push("openFixPr");
      return "https://github.com/acme/app/pull/42";
    },
    removeWorkspace: () => {
      calls.push("removeWorkspace");
    },
    ...overrides,
  };
}

describe("runPipeline", () => {
  test("a report whose sourceId is already processed exits immediately, before touching any dependency", async () => {
    await withStateFile(async (stateFile) => {
      writeFileSync(stateFile, JSON.stringify(["sentry-issue-1"]));
      const calls: string[] = [];
      const result = await runPipeline("/fake/repo", bugReport(), stateFile, happyDeps(calls));
      expect(result).toEqual({ status: "already_processed", sourceId: "sentry-issue-1" });
      expect(calls).toEqual([]);
    });
  });

  test("the full success path runs every step in the correct order and cleans up the workspace", async () => {
    await withStateFile(async (stateFile) => {
      const calls: string[] = [];
      const result = await runPipeline("/fake/repo", bugReport(), stateFile, happyDeps(calls));
      expect(result).toEqual({
        status: "pr_opened",
        url: "https://github.com/acme/app/pull/42",
        branch: "day2-fix-test-branch",
      });
      expect(calls).toEqual([
        "cloneIsolatedWorkspace",
        "createFixBranch",
        "runFixAgent",
        "hasChanges",
        "commitAll",
        "diffStat",
        "runVerifierAgent",
        "pushBranch",
        "openFixPr",
        "removeWorkspace",
      ]);
    });
  });

  test("a successfully opened PR marks the report processed, so a repeat run short-circuits as already_processed", async () => {
    await withStateFile(async (stateFile) => {
      await runPipeline("/fake/repo", bugReport(), stateFile, happyDeps([]));
      const secondCalls: string[] = [];
      const second = await runPipeline("/fake/repo", bugReport(), stateFile, happyDeps(secondCalls));
      expect(second).toEqual({ status: "already_processed", sourceId: "sentry-issue-1" });
      expect(secondCalls).toEqual([]);
    });
  });

  test("fix-agent reporting an error short-circuits as reproduction_failed before any git/commit/verifier step", async () => {
    await withStateFile(async (stateFile) => {
      const calls: string[] = [];
      const deps = happyDeps(calls, {
        runFixAgent: async () => {
          calls.push("runFixAgent");
          return agentResult({ isError: true, finalText: "could not reproduce the described bug" });
        },
      });
      const result = await runPipeline("/fake/repo", bugReport(), stateFile, deps);
      expect(result).toEqual({ status: "reproduction_failed", reason: "could not reproduce the described bug" });
      expect(calls).toEqual(["cloneIsolatedWorkspace", "createFixBranch", "runFixAgent", "removeWorkspace"]);
    });
  });

  test("fix-agent producing no changes at all is reported as reproduction_failed, without committing or verifying", async () => {
    await withStateFile(async (stateFile) => {
      const calls: string[] = [];
      const deps = happyDeps(calls, {
        hasChanges: async () => {
          calls.push("hasChanges");
          return false;
        },
      });
      const result = await runPipeline("/fake/repo", bugReport(), stateFile, deps);
      expect(result.status).toBe("reproduction_failed");
      if (result.status === "reproduction_failed") {
        expect(result.reason).toContain("no changes");
      }
      expect(calls).toEqual(["cloneIsolatedWorkspace", "createFixBranch", "runFixAgent", "hasChanges", "removeWorkspace"]);
    });
  });

  test("a diff with real changes but no touched test file fails the mechanical reproduce-first gate before the verifier ever runs", () => {
    return withStateFile(async (stateFile) => {
      const calls: string[] = [];
      const deps = happyDeps(calls, {
        diffStat: async () => {
          calls.push("diffStat");
          return NO_TEST_FILE_DIFF_STAT;
        },
      });
      const result = await runPipeline("/fake/repo", bugReport(), stateFile, deps);
      expect(result.status).toBe("reproduction_failed");
      if (result.status === "reproduction_failed") {
        expect(result.reason).toContain("test-file convention");
        expect(result.reason).toContain("src/checkout.ts");
      }
      // Critically: the verifier never ran, and nothing was pushed/opened —
      // a diff that skipped "write a failing test first" is rejected by code,
      // not left for the verifier-agent's prompt-only check to maybe catch.
      expect(calls).toEqual([
        "cloneIsolatedWorkspace",
        "createFixBranch",
        "runFixAgent",
        "hasChanges",
        "commitAll",
        "diffStat",
        "removeWorkspace",
      ]);
    });
  });

  test("the verifier rejecting the fix is reported as verifier_rejected, and never pushes or opens a PR", async () => {
    await withStateFile(async (stateFile) => {
      const calls: string[] = [];
      const deps = happyDeps(calls, {
        runVerifierAgent: async () => {
          calls.push("runVerifierAgent");
          return agentResult({ finalText: "VERDICT: REJECT — fix doesn't address the root cause" });
        },
      });
      const result = await runPipeline("/fake/repo", bugReport(), stateFile, deps);
      expect(result).toEqual({
        status: "verifier_rejected",
        reason: "VERDICT: REJECT — fix doesn't address the root cause",
      });
      expect(calls).toEqual([
        "cloneIsolatedWorkspace",
        "createFixBranch",
        "runFixAgent",
        "hasChanges",
        "commitAll",
        "diffStat",
        "runVerifierAgent",
        "removeWorkspace",
      ]);
    });
  });

  test("the workspace is always removed, even when a step throws", async () => {
    await withStateFile(async (stateFile) => {
      const calls: string[] = [];
      const deps = happyDeps(calls, {
        commitAll: async () => {
          calls.push("commitAll");
          throw new Error("git commit failed");
        },
      });
      await expect(runPipeline("/fake/repo", bugReport(), stateFile, deps)).rejects.toThrow("git commit failed");
      expect(calls).toContain("removeWorkspace");
    });
  });
});
