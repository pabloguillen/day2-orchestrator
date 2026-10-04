import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { runFixAgent, runVerifierAgent, type AgentRunResult } from "./agent";
import { cloneIsolatedWorkspace, commitAll, createFixBranch, diffStat, hasChanges, pushBranch } from "./git";
import { openFixPr } from "./pr";
import type { BugReport, PipelineResult } from "./types";

function loadProcessed(stateFile: string): Set<string> {
  if (!existsSync(stateFile)) return new Set();
  return new Set(JSON.parse(readFileSync(stateFile, "utf-8")) as string[]);
}

/** Every identity string a report is known by: its `sourceId` always, plus
 * its `correlationKey` when the source could supply one. Checking/recording
 * both is what lets two different sources (e.g. the classic Sentry path and
 * a health-scout cluster corroborating that same Sentry issue) land on the
 * same "already processed" outcome instead of each opening its own fix PR. */
function identityKeysFor(report: BugReport): string[] {
  return report.correlationKey ? [report.sourceId, report.correlationKey] : [report.sourceId];
}

export function isAlreadyProcessed(processed: Set<string>, report: BugReport): boolean {
  return identityKeysFor(report).some((key) => processed.has(key));
}

function markProcessed(stateFile: string, report: BugReport) {
  const processed = loadProcessed(stateFile);
  for (const key of identityKeysFor(report)) processed.add(key);
  writeFileSync(stateFile, JSON.stringify([...processed], null, 2));
}

function extractVerdict(text: string): { approved: boolean; line: string } {
  const line = text.split("\n").find((l) => l.trim().startsWith("VERDICT:")) ?? "";
  return { approved: line.includes("APPROVE") && !line.includes("REJECT"), line };
}

/** This app family's test-file naming convention (confirmed against both
 * this repo's own `*.test.ts` files and a real target repo, expense-buddy,
 * which uses the same `*.test.ts`/`*.test.tsx` suffix — no `*.spec.*` files
 * anywhere). Matches `.test.ts`/`.test.tsx`/`.test.js`/`.test.jsx` so this
 * doesn't silently fail on a plain-JS target repo either. */
const TEST_FILE_PATTERN = /\.test\.[jt]sx?$/;

/** Parses `git diff --stat`-style output (git.ts's `diffStat`) into the list
 * of changed file paths. Each real file line has the shape
 * " path/to/file.ts | 12 ++--"; the trailing "N files changed..." summary
 * line has no " | " and is correctly skipped. */
function changedFilesFromDiffStat(stat: string): string[] {
  return stat
    .split("\n")
    .map((line) => {
      const sepIndex = line.indexOf(" | ");
      return sepIndex === -1 ? null : line.slice(0, sepIndex).trim();
    })
    .filter((name): name is string => !!name);
}

/** The mechanical "reproduce-first" gate (Medium-severity audit finding):
 * the fix-agent's prompt instructs it to write a failing test before fixing,
 * and the verifier-agent is separately asked to judge that, but until now
 * `pipeline.ts`'s only mechanical check was "did any file change at all"
 * (`hasChanges`) — nothing actually confirmed a test file was among those
 * changes. This doesn't attempt to verify red->green semantically (no
 * infrastructure in this codebase does that yet); it only confirms a file
 * matching this app family's test-file convention was touched, narrow and
 * disclosed like every other check in this codebase. */
export function touchesTestFile(diffStatOutput: string): boolean {
  return changedFilesFromDiffStat(diffStatOutput).some((f) => TEST_FILE_PATTERN.test(f));
}

/** Every external effect `runPipeline` performs, as injectable functions —
 * defaulted to the real `git.ts`/`agent.ts`/`pr.ts` implementations so every
 * existing caller (`health-scout-cli.ts`, `index.ts`, `swarm-fix-cli.ts`)
 * keeps behaving exactly as before without passing anything here. Tests
 * inject fakes instead, which is what makes `runPipeline`'s own step
 * ordering, dedup early-exit, and failure paths testable without a real git
 * remote, a real `gh`, or a real agent run. */
export type PipelineDeps = {
  cloneIsolatedWorkspace: (sourceRepoPath: string) => Promise<string>;
  createFixBranch: (cwd: string, sourceId: string, title: string) => Promise<string>;
  runFixAgent: (cwd: string, report: BugReport) => Promise<AgentRunResult>;
  hasChanges: (cwd: string) => Promise<boolean>;
  diffStat: (cwd: string) => Promise<string>;
  commitAll: (cwd: string, message: string) => Promise<void>;
  runVerifierAgent: (cwd: string, report: BugReport) => Promise<AgentRunResult>;
  pushBranch: (cwd: string, branch: string) => Promise<void>;
  openFixPr: (cwd: string, branch: string, report: BugReport, agentSummary: string) => Promise<string>;
  removeWorkspace: (cwd: string) => void;
};

const defaultDeps: PipelineDeps = {
  cloneIsolatedWorkspace,
  createFixBranch,
  runFixAgent,
  hasChanges,
  diffStat,
  commitAll,
  runVerifierAgent,
  pushBranch,
  openFixPr,
  removeWorkspace: (cwd) => rmSync(cwd, { recursive: true, force: true }),
};

/**
 * The full loop: production signal -> reproduce -> fix -> independent verify
 * -> PR. Never auto-merges. Never pushes to `main` directly (always a fresh
 * branch) — see git.ts for why that's non-negotiable, not just tidy.
 *
 * `deps` lets tests substitute any of the real git/agent/PR side effects
 * with fakes (see `pipeline.test.ts`); every real caller omits it and gets
 * exactly the previous behavior.
 */
export async function runPipeline(
  sourceRepoPath: string,
  report: BugReport,
  stateFile: string,
  deps: Partial<PipelineDeps> = {},
): Promise<PipelineResult> {
  const d: PipelineDeps = { ...defaultDeps, ...deps };

  if (isAlreadyProcessed(loadProcessed(stateFile), report)) {
    return { status: "already_processed", sourceId: report.sourceId };
  }

  console.log(`[day2] New signal: ${report.title} (${report.source}/${report.sourceId})`);

  console.log(`[day2] Cloning into an isolated workspace...`);
  const cwd = await d.cloneIsolatedWorkspace(sourceRepoPath);
  console.log(`[day2] Workspace: ${cwd}`);

  try {
    const branch = await d.createFixBranch(cwd, report.sourceId, report.title);
    console.log(`[day2] Working on branch ${branch}`);

    console.log(`[day2] Running fix-agent...`);
    const fix = await d.runFixAgent(cwd, report);
    console.log(`[day2] Fix-agent done (${fix.numTurns} turns, $${fix.costUsd.toFixed(3)})`);

    if (fix.isError) {
      return {
        status: "reproduction_failed",
        reason: fix.finalText || "agent reported an error",
      };
    }
    if (!(await d.hasChanges(cwd))) {
      return {
        status: "reproduction_failed",
        reason: "agent made no changes — likely could not reproduce the bug",
      };
    }

    await d.commitAll(cwd, `Fix: ${report.title}`);

    const stat = await d.diffStat(cwd);
    if (!touchesTestFile(stat)) {
      const changedFiles = changedFilesFromDiffStat(stat);
      const reason =
        `fix-agent changed files but none matched this app's test-file convention ` +
        `(*.test.ts / *.test.tsx / *.test.js / *.test.jsx) — "write a failing test first" ` +
        `was not mechanically confirmed. Changed files: ` +
        `${changedFiles.length > 0 ? changedFiles.join(", ") : "(none detected)"}`;
      console.error(`[day2] Reproduce-first check failed: ${reason}`);
      return { status: "reproduction_failed", reason };
    }

    console.log(`[day2] Running independent verifier...`);
    const verifier = await d.runVerifierAgent(cwd, report);
    console.log(
      `[day2] Verifier done (${verifier.numTurns} turns, $${verifier.costUsd.toFixed(3)})`,
    );

    const verdict = extractVerdict(verifier.finalText);
    if (!verdict.approved) {
      return { status: "verifier_rejected", reason: verdict.line || verifier.finalText };
    }

    await d.pushBranch(cwd, branch);
    const url = await d.openFixPr(cwd, branch, report, fix.finalText);
    console.log(`[day2] Opened PR: ${url}`);

    markProcessed(stateFile, report);
    return { status: "pr_opened", url, branch };
  } finally {
    d.removeWorkspace(cwd);
  }
}
