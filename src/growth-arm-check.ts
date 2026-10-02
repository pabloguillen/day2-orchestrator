import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxConfig } from "./agent-sandbox";
import type { ClaimCheckVerdict } from "./growth-creative";
import type { DiagnosisRuleId } from "./diagnosis";

/**
 * Swarm checks for new arms (docs/closed-loop-spec.md §10): "Reuse swarm.ts
 * before any spend on a new arm." Shares `swarm.ts`'s exact SDK+Playwright+
 * sandbox invocation shape (same model/turn/budget/sandbox config, same
 * temp-workspace-per-run pattern) for the genuinely new part — live
 * navigation reachability — rather than duplicating it with drift. Claims-
 * checking is NOT re-implemented here: `growth-creative.ts`'s existing,
 * already-tested `checkTruthfulClaims` is reused directly (spec §10 step 4
 * says "reuse ai-slop-patterns.ts for authenticity checks" — the truthful-
 * claims half of that job already exists as `checkTruthfulClaims`, built on
 * `ai-slop-patterns.ts`'s own sibling `checkAuthenticity`; building a THIRD,
 * separate claims-checker here would be real duplication, not reuse).
 */

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
const MAX_TURNS = 30;
const MAX_BUDGET_USD = 1;
const MAX_REACHABILITY_STEPS = 10; // spec §10 step 2: "within 10 steps"

const orchestratorRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_NODE_MODULES = join(orchestratorRoot, "node_modules");

export type ArmReachabilityVerdict = {
  reachedActivationWithinSteps: boolean;
  stepsToActivation: number | null;
  maxSteps: number;
  errorsSeen: string[];
  accessibilityIssues: string[];
  isError: boolean;
  summary: string;
  costUsd: number;
};

function buildReachabilityPrompt(destinationUrl: string, activationEventDescription: string, audienceDescription: string): string {
  return `You are a real user matching this description: ${audienceDescription}
You just clicked a real ad and landed here: ${destinationUrl}

Your goal: ${activationEventDescription}

Use the browser (Playwright, already available) to actually navigate,
click, and type — not just read the page. Count every real click/tap/
key-press/navigation as one step. You have at most ${MAX_REACHABILITY_STEPS}
steps to reach the goal.

Along the way, note:
- Any real JavaScript error or crash you observe (check the browser console).
- Any real accessibility problem you hit as a real user would (missing
  focus indicator, unlabeled control, keyboard trap).

When finished (whether you reached the goal or not, or ran out of steps),
end your final message with exactly this marker on its own line, followed
by JSON (and nothing else after it):
ARM_REACHABILITY_JSON:
{"reached": true|false, "stepsToActivation": <number|null>, "errorsSeen": ["..."], "accessibilityIssues": ["..."]}

"stepsToActivation" is null if you never reached the goal. An empty
"errorsSeen"/"accessibilityIssues" array is the correct, honest result when
nothing is actually wrong — don't invent issues to seem thorough.`;
}

const REACHABILITY_MARKER = "ARM_REACHABILITY_JSON:";

/** Pure, unit-tested. Fails closed to `reachedActivationWithinSteps: false`
 * on any parse failure or agent error — same discipline as
 * `swarm.ts::parseVerdict`/`growth-creative.ts::parseClaimCheckVerdict`:
 * an unreadable or errored transcript is never treated as a passing one. */
export function parseArmReachabilityVerdict(finalText: string, isError: boolean): ArmReachabilityVerdict {
  const fail = (summary: string): ArmReachabilityVerdict => ({
    reachedActivationWithinSteps: false,
    stepsToActivation: null,
    maxSteps: MAX_REACHABILITY_STEPS,
    errorsSeen: [],
    accessibilityIssues: [],
    isError,
    summary,
    costUsd: 0,
  });

  if (isError) return fail("(agent run errored before producing a verdict)");

  const markerIndex = finalText.indexOf(REACHABILITY_MARKER);
  if (markerIndex === -1) return fail("could not parse a reachability verdict from the agent's output");

  const jsonText = finalText.slice(markerIndex + REACHABILITY_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return fail("malformed JSON after reachability-check result marker");
  }
  if (typeof parsed !== "object" || parsed === null) return fail("reachability result was not a JSON object");

  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.reached !== "boolean" ||
    !Array.isArray(obj.errorsSeen) ||
    !obj.errorsSeen.every((e) => typeof e === "string") ||
    !Array.isArray(obj.accessibilityIssues) ||
    !obj.accessibilityIssues.every((e) => typeof e === "string")
  ) {
    return fail("reachability result had an invalid shape");
  }
  const stepsRaw = obj.stepsToActivation;
  const stepsToActivation = typeof stepsRaw === "number" && Number.isFinite(stepsRaw) ? stepsRaw : null;
  // Fail closed even if the agent claims success: a claimed step count
  // outside the real bound, or a "reached" claim with no step count, is
  // treated as not-reached rather than trusted at face value.
  const reachedActivationWithinSteps =
    obj.reached === true && stepsToActivation !== null && stepsToActivation > 0 && stepsToActivation <= MAX_REACHABILITY_STEPS;

  return {
    reachedActivationWithinSteps,
    stepsToActivation,
    maxSteps: MAX_REACHABILITY_STEPS,
    errorsSeen: obj.errorsSeen as string[],
    accessibilityIssues: obj.accessibilityIssues as string[],
    isError: false,
    summary: reachedActivationWithinSteps
      ? `Reached activation in ${stepsToActivation} step(s).`
      : `Did not reach activation within ${MAX_REACHABILITY_STEPS} steps.`,
    costUsd: 0,
  };
}

/** Thin, agent-invoking wrapper — real Playwright browser automation via
 * the Claude Agent SDK, same sandboxed, isolated-workspace pattern as
 * `swarm.ts::runPersona`. Zero unit coverage by design (matches this
 * project's standing split for every agent-invoking wrapper); validated
 * live only. */
export async function runArmReachabilityCheck(
  destinationUrl: string,
  activationEventDescription: string,
  audienceDescription: string,
): Promise<ArmReachabilityVerdict> {
  const cwd = mkdtempSync(join(tmpdir(), "day2-arm-check-"));
  symlinkSync(SHARED_NODE_MODULES, join(cwd, "node_modules"));

  let finalText = "";
  let isError = false;
  let costUsd = 0;

  try {
    try {
      for await (const message of query({
        prompt: buildReachabilityPrompt(destinationUrl, activationEventDescription, audienceDescription),
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

  return { ...parseArmReachabilityVerdict(finalText, isError), costUsd };
}

// ---------------------------------------------------------------------------
// Launch gate — combines the new reachability check with the already-
// existing, already-tested claims check (growth-creative.ts).
// ---------------------------------------------------------------------------

export type ArmLaunchGateResult =
  | { allowed: true }
  | { allowed: false; reason: "unsupported_claims"; claimsVerdict: ClaimCheckVerdict }
  | { allowed: false; reason: "broken_path"; reachabilityVerdict: ArmReachabilityVerdict }
  | { allowed: false; reason: "quality_issue"; reachabilityVerdict: ArmReachabilityVerdict };

/**
 * Pure. Spec §10: "It must reach the app's activation event within 10
 * steps... No errors or crashes on the way; accessibility checks pass...
 * unsupported claims block the arm." Claims are checked first — an
 * untruthful ad shouldn't launch even if the product experience behind it
 * is flawless.
 */
export function evaluateArmLaunchGate(claimsVerdict: ClaimCheckVerdict, reachabilityVerdict: ArmReachabilityVerdict): ArmLaunchGateResult {
  if (!claimsVerdict.truthful || claimsVerdict.fabricatesTestimonialIdentity) {
    return { allowed: false, reason: "unsupported_claims", claimsVerdict };
  }
  if (!reachabilityVerdict.reachedActivationWithinSteps) {
    return { allowed: false, reason: "broken_path", reachabilityVerdict };
  }
  if (reachabilityVerdict.errorsSeen.length > 0 || reachabilityVerdict.accessibilityIssues.length > 0) {
    return { allowed: false, reason: "quality_issue", reachabilityVerdict };
  }
  return { allowed: true };
}

/**
 * Spec §10: "A failed check blocks launch and creates a D2 or D3 diagnosis
 * with the swarm trace as evidence." Disclosed mapping, since the spec
 * doesn't split which reason maps to which rule: `unsupported_claims`/
 * `quality_issue` land as D2 (the ad itself misrepresents what the user
 * will get, or a real bug taints the landing experience — both are
 * "landing doesn't convert" in kind, `diagnosis/rules.ts`'s own D2);
 * `broken_path` lands as D3 (the entry path genuinely can't reach
 * activation — `diagnosis/rules.ts`'s own D3). Returns the trace as plain
 * text for the caller to attach to `Diagnosis.evidence` or a dedicated
 * trace field — this file doesn't depend on `diagnosis/types.ts`'s exact
 * evidence shape, which is numeric/metric-based and doesn't fit free text.
 */
export function ruleIdForFailedArmCheck(gateResult: Exclude<ArmLaunchGateResult, { allowed: true }>): DiagnosisRuleId {
  return gateResult.reason === "broken_path" ? "D3" : "D2";
}

export function traceForFailedArmCheck(gateResult: Exclude<ArmLaunchGateResult, { allowed: true }>): string {
  if (gateResult.reason === "unsupported_claims") {
    return `Unsupported claims: ${gateResult.claimsVerdict.issues.join("; ") || "(no specific issues listed)"}`;
  }
  return gateResult.reachabilityVerdict.summary;
}
