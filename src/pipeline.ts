import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { runFixAgent, runVerifierAgent } from "./agent";
import { cloneIsolatedWorkspace, commitAll, createFixBranch, hasChanges, pushBranch } from "./git";
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

/**
 * The full loop: production signal -> reproduce -> fix -> independent verify
 * -> PR. Never auto-merges. Never pushes to `main` directly (always a fresh
 * branch) — see git.ts for why that's non-negotiable, not just tidy.
 */
export async function runPipeline(
  sourceRepoPath: string,
  report: BugReport,
  stateFile: string,
): Promise<PipelineResult> {
  if (isAlreadyProcessed(loadProcessed(stateFile), report)) {
    return { status: "already_processed", sourceId: report.sourceId };
  }

  console.log(`[day2] New signal: ${report.title} (${report.source}/${report.sourceId})`);

  console.log(`[day2] Cloning into an isolated workspace...`);
  const cwd = await cloneIsolatedWorkspace(sourceRepoPath);
  console.log(`[day2] Workspace: ${cwd}`);

  try {
    const branch = await createFixBranch(cwd, report.sourceId, report.title);
    console.log(`[day2] Working on branch ${branch}`);

    console.log(`[day2] Running fix-agent...`);
    const fix = await runFixAgent(cwd, report);
    console.log(`[day2] Fix-agent done (${fix.numTurns} turns, $${fix.costUsd.toFixed(3)})`);

    if (fix.isError) {
      return {
        status: "reproduction_failed",
        reason: fix.finalText || "agent reported an error",
      };
    }
    if (!(await hasChanges(cwd))) {
      return {
        status: "reproduction_failed",
        reason: "agent made no changes — likely could not reproduce the bug",
      };
    }

    await commitAll(cwd, `Fix: ${report.title}`);

    console.log(`[day2] Running independent verifier...`);
    const verifier = await runVerifierAgent(cwd, report);
    console.log(
      `[day2] Verifier done (${verifier.numTurns} turns, $${verifier.costUsd.toFixed(3)})`,
    );

    const verdict = extractVerdict(verifier.finalText);
    if (!verdict.approved) {
      return { status: "verifier_rejected", reason: verdict.line || verifier.finalText };
    }

    await pushBranch(cwd, branch);
    const url = await openFixPr(cwd, branch, report, fix.finalText);
    console.log(`[day2] Opened PR: ${url}`);

    markProcessed(stateFile, report);
    return { status: "pr_opened", url, branch };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
