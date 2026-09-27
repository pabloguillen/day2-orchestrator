import { query } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxConfig } from "./agent-sandbox";
import {
  buildSkepticChecklist,
  hasApplicablePatterns,
  FALSE_POSITIVE_PATTERNS,
} from "./false-positive-patterns";
import type { PersonaResult } from "./swarm";

/**
 * Step 3 (self-evolving), Component 1 — swarm calibration loop
 * (COORDINATION.md W30, docs/step3-self-evolving-plan.md).
 *
 * Automates the manual loop already done three times in this project: a
 * live canary release blocked by a swarm v1 finding, investigated by hand
 * with real browser tools, confirmed to be a false positive, then hand-
 * fixed into the persona's prompt (false-positive-patterns.ts). This module
 * runs a second, focused "skeptic" agent against a failing finding, using
 * the same catalogued patterns, *before* a human has to intervene again.
 *
 * Explicit non-goal: the skeptic can only re-apply a pattern a human
 * already vetted (see parseCalibrationVerdict's `validPatternIds` check).
 * It never gets to invent a new false-positive reason — that still requires
 * a human to investigate and add a new catalogued pattern, same as every
 * one of the three patterns here originated.
 *
 * Sandbox/denylist config now comes from the shared agent-sandbox.ts —
 * originally kept as its own disclosed-duplicate copy here while W28 (a
 * separate, in-flight fix touching swarm.ts's sandbox settings) was still
 * landing, per this module's own earlier note. W28 landed (PR #37); deduped
 * here now that the collision window is closed.
 */

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
const MAX_TURNS = 30;
const MAX_BUDGET_USD = 1;

const orchestratorRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_NODE_MODULES = join(orchestratorRoot, "node_modules");

const VIEWPORT_SUFFIXES = ["-desktop", "-mobile"];

/** `DEFAULT_PERSONAS` names are `${basePersonaName}-${viewport}` (swarm.ts).
 * Strips the viewport suffix back off so this module can look up patterns
 * by base persona name without swarm.ts needing to export that mapping. */
function basePersonaName(fullPersonaName: string): string {
  for (const suffix of VIEWPORT_SUFFIXES) {
    if (fullPersonaName.endsWith(suffix)) return fullPersonaName.slice(0, -suffix.length);
  }
  return fullPersonaName;
}

export type CalibrationVerdict = {
  persona: string;
  matchedPatternId: string | null;
  clearedAsFalsePositive: boolean;
  summary: string;
  isError: boolean;
  costUsd: number;
};

/** Pure, unit-tested — the fail-closed core of the whole mechanism.
 * Cleared only when ALL of: the final line is exactly well-formed, the run
 * didn't error, the cited pattern id is one a human actually vetted for
 * this persona, and the evidence clause is non-empty (rejects a bare,
 * unsubstantiated clear). Every other case — CONFIRMED_REAL, INCONCLUSIVE,
 * a missing/malformed line, a hallucinated/typo'd id, an SDK error — fails
 * closed to "not cleared", same philosophy as swarm.ts's parseVerdict. */
export function parseCalibrationVerdict(
  finalText: string,
  isError: boolean,
  validPatternIds: string[],
): { matchedPatternId: string | null; clearedAsFalsePositive: boolean; summary: string } {
  const verdictLine =
    finalText
      .split("\n")
      .find((l) => l.trim().startsWith("CALIBRATION_VERDICT:"))
      ?.trim() ?? "";

  if (isError || !verdictLine) {
    return {
      matchedPatternId: null,
      clearedAsFalsePositive: false,
      summary: verdictLine || finalText.slice(0, 500).trim() || "(no output)",
    };
  }

  const match = verdictLine.match(/^CALIBRATION_VERDICT:\s*FALSE_POSITIVE\s*—\s*pattern:\s*(\S+)\s*—\s*(.+)$/);
  if (!match) {
    return { matchedPatternId: null, clearedAsFalsePositive: false, summary: verdictLine };
  }

  const [, patternId, evidence] = match;
  const cleared = validPatternIds.includes(patternId!) && evidence!.trim().length > 0;
  return {
    matchedPatternId: cleared ? patternId! : null,
    clearedAsFalsePositive: cleared,
    summary: verdictLine,
  };
}

function buildSkepticPrompt(previewUrl: string, failedResult: PersonaResult, checklist: string): string {
  return `You are a skeptical second reviewer checking whether another automated
tester's finding is actually real. The app under test is live at exactly
this URL — never guess or construct a different one:

${previewUrl}

The other tester ("${failedResult.persona}") reported:

"${failedResult.summary}"

${checklist}

Re-verify this live, for real, using Playwright (already installed —
\`import { chromium } from "playwright"\` works without any install step).
Write a small script, run it with \`node check.mjs\`, and actually reproduce
what the other tester claims to have seen — don't just reason about
whether it sounds plausible. This URL carries no real production traffic
(it's an isolated preview version), so interacting with it freely is safe.

When finished, end your final message with exactly one line, in exactly
this format:
"CALIBRATION_VERDICT: FALSE_POSITIVE — pattern: <id> — <what you actually observed that confirms it>"
(only if you genuinely reproduced one of the patterns above), or
"CALIBRATION_VERDICT: CONFIRMED_REAL — <what you actually observed>" (the
finding holds up), or
"CALIBRATION_VERDICT: INCONCLUSIVE — <why>" (you couldn't tell either way —
this is a legitimate answer, not a failure, and will keep the release
blocked exactly like CONFIRMED_REAL does).

If you're running low on turns, stop investigating further and give your
best current verdict right away, based on what you've already found — a
short, concrete one, not a longer report. A run that never reaches a
parseable verdict line fails closed regardless, so an unfinished long
report gets you nothing a timely short one wouldn't.`;
}

/** Thin, agent-invoking wrapper — zero unit coverage, validated only live
 * (same idiom as swarm.ts's runPersona). Short-circuits to "not cleared"
 * with no query() call at all if no catalogued pattern applies to this
 * persona — never spends money auditing against an empty checklist. */
export async function runSkepticCheck(
  previewUrl: string,
  failedResult: PersonaResult,
): Promise<CalibrationVerdict> {
  const base = basePersonaName(failedResult.persona);
  if (!hasApplicablePatterns(base)) {
    return {
      persona: failedResult.persona,
      matchedPatternId: null,
      clearedAsFalsePositive: false,
      summary: "(no catalogued false-positive pattern applies to this persona — skeptic not run)",
      isError: false,
      costUsd: 0,
    };
  }

  const validPatternIds = FALSE_POSITIVE_PATTERNS.filter((p) => p.personas.includes(base)).map(
    (p) => p.id,
  );

  const checklist = buildSkepticChecklist(base);
  const cwd = mkdtempSync(join(tmpdir(), "day2-calibration-"));
  symlinkSync(SHARED_NODE_MODULES, join(cwd, "node_modules"));

  let finalText = "";
  let isError = false;
  let costUsd = 0;

  try {
    try {
      for await (const message of query({
        prompt: buildSkepticPrompt(previewUrl, failedResult, checklist),
        options: {
          cwd,
          model: MODEL,
          permissionMode: "bypassPermissions",
          maxTurns: MAX_TURNS,
          maxBudgetUsd: MAX_BUDGET_USD,
          persistSession: false,
          settingSources: [],
          settings: { disableClaudeAiConnectors: true },
          tools: ["Bash", "Read", "Write", "Edit"],
          sandbox: sandboxConfig(),
        },
      })) {
        if (message.type === "result") {
          finalText = message.result ?? "";
          isError = Boolean(message.is_error);
          costUsd = message.total_cost_usd ?? 0;
        }
      }
    } catch (err) {
      isError = true;
      finalText = `(agent run threw before producing a result: ${(err as Error).message})`;
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }

  return {
    persona: failedResult.persona,
    ...parseCalibrationVerdict(finalText, isError, validPatternIds),
    isError,
    costUsd,
  };
}

/** Batches one runSkepticCheck per currently-failing persona (mirrors
 * runSwarm's Promise.all-of-personas shape). Wrapper, no unit coverage. */
export async function calibrateSwarmFailures(
  previewUrl: string,
  results: PersonaResult[],
): Promise<{ allClearedAsFalsePositive: boolean; verdicts: CalibrationVerdict[] }> {
  const failing = results.filter((r) => !r.passed);
  const verdicts = await Promise.all(failing.map((r) => runSkepticCheck(previewUrl, r)));
  return {
    allClearedAsFalsePositive: verdicts.length > 0 && verdicts.every((v) => v.clearedAsFalsePositive),
    verdicts,
  };
}

/** Append-only JSONL audit trail, same idiom as autonomy.ts's
 * recordAutonomyAudit — every calibration run leaves a real, readable
 * record regardless of whether it ends up clearing anything. */
export function recordCalibrationAudit(
  auditFile: string,
  sha: string,
  previewUrl: string,
  verdicts: CalibrationVerdict[],
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    sha,
    previewUrl,
    verdicts,
    allClearedAsFalsePositive: verdicts.length > 0 && verdicts.every((v) => v.clearedAsFalsePositive),
  };
  appendFileSync(auditFile, `${JSON.stringify(entry)}\n`);
}
