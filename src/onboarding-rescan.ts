import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AppProfile } from "./onboarding";

/**
 * Step 4 (self-distributing) extension — drift-detecting app-profile
 * re-scan (COORDINATION.md W46).
 *
 * Real, confirmed gap this responds to: there is no automatic `AppProfile`
 * re-scan anywhere in this codebase. It only ever refreshes via a manual
 * CLI run, and `onboarding-cli.ts`'s own header says persisting an
 * unreviewed scan was judged too risky to do silently — a deliberate
 * human-review step, not an oversight. So this doesn't add a silent
 * overwrite; it adds drift DETECTION on every merged PR (same
 * `pull_request: closed` event `auto-release.yml` already listens for)
 * and writes any detected drift to a SEPARATE pending file for a human to
 * review and promote — never an in-place overwrite of a reviewed profile.
 *
 * **Disclosed, deliberate temporary duplication, not an oversight**: a
 * concurrent, uncommitted workstream (visible only as `api-server.ts`'s
 * imports of `APP_PROFILE_FILENAME`/`loadAppProfile`/`saveAppProfile` from
 * `./onboarding` — those names don't exist in committed `onboarding.ts` as
 * of this file's own base commit) is evidently building real `AppProfile`
 * persistence there already. Building this workstream's own load function
 * directly into the shared `onboarding.ts` file risked a real edit
 * collision with in-progress, unshared work this session can't see or
 * coordinate with mid-flight. This file is deliberately separate and
 * minimal — a read-only loader plus the pure diff/pending-write logic —
 * so it can be deduped into whatever `onboarding.ts` ends up exporting
 * once that workstream lands and commits, same "disclosed duplication
 * now, dedupe once the collision window closes" precedent
 * `agent-sandbox.ts`/`growth-allocator.ts`'s `GrowthCapability` both
 * already established in this project. `APP_PROFILE_FILENAME` here uses
 * the same obvious, established `.day2-*.json` naming convention every
 * other per-app config in this project already follows — not a guess at
 * the other workstream's own choice, just the one name that convention
 * would produce either way.
 *
 * **Real bug caught live, fixed before shipping, not just disclosed**: a
 * live-validation run against the real expense-buddy repo scanned it
 * twice in a row, seconds apart, with ZERO real app changes in between —
 * and `diffAppProfiles`' raw text comparison flagged EVERY free-text field
 * (`purpose`, `targetUsers`, `toneOfVoice`, even `styleGuide`'s framework
 * description) as "changed," purely from the scanning agent rewording its
 * own honest, equally-accurate description differently each run. A naive
 * string-diff CI trigger would have flagged drift on nearly every single
 * merged PR regardless of whether the app actually changed — real alert
 * fatigue, defeating the whole point. Fixed by adding
 * `assessDriftSignificance` below: a second, independent agent judgment
 * call (same "agent-as-skeptic" pattern `calibration.ts`/
 * `checkAuthenticity` already use elsewhere in this codebase) that the CLI
 * runs AFTER `diffAppProfiles` finds any raw difference, before ever
 * writing a pending file — only genuinely meaningful drift (a real
 * feature, tone, or style change) gets surfaced; pure rewording doesn't.
 * `diffAppProfiles` itself stays exactly as it was (a cheap, pure,
 * unit-testable pre-filter — skip the agent call entirely when it finds
 * zero raw differences), the significance judgment is a separate, thin,
 * agent-invoking layer on top.
 */

export const APP_PROFILE_FILENAME = ".day2-app-profile.json";
export const PENDING_APP_PROFILE_FILENAME = ".day2-app-profile.pending.json";

/** Read-only. Returns `null` (not a throw) when no profile has ever been
 * saved yet — a real, honest "nothing to compare against," not an error. */
export function loadStoredAppProfile(path: string): AppProfile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as AppProfile;
  } catch {
    return null;
  }
}

export function writePendingAppProfile(path: string, profile: AppProfile): void {
  writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`);
}

/**
 * Pure. Compares only the fields that matter for creative/website
 * grounding — `purpose`, `targetUsers`, `featureMap`, `styleGuide`,
 * `toneOfVoice`, `businessModel`. Deliberately excludes `currentState`
 * (Sentry issue count fluctuates constantly and would make every re-scan
 * "drift"), `caveats`/`competitors`/`scannedAt` (metadata, not grounding
 * content) — comparing those would bury real drift in constant noise.
 * `oldProfile === null` (nothing reviewed yet) always counts as drift —
 * there's nothing to promote from until a human looks at a first scan.
 */
export function diffAppProfiles(oldProfile: AppProfile | null, newProfile: AppProfile): string[] {
  if (oldProfile === null) {
    return ["no previously reviewed app profile found — this is a first scan, pending review"];
  }

  const diffs: string[] = [];
  if (oldProfile.purpose !== newProfile.purpose) {
    diffs.push(`purpose changed: "${oldProfile.purpose}" → "${newProfile.purpose}"`);
  }
  if (oldProfile.targetUsers !== newProfile.targetUsers) {
    diffs.push(`targetUsers changed: "${oldProfile.targetUsers}" → "${newProfile.targetUsers}"`);
  }
  if (JSON.stringify(oldProfile.featureMap) !== JSON.stringify(newProfile.featureMap)) {
    diffs.push(`featureMap changed: [${oldProfile.featureMap.join(", ")}] → [${newProfile.featureMap.join(", ")}]`);
  }
  if (JSON.stringify(oldProfile.styleGuide) !== JSON.stringify(newProfile.styleGuide)) {
    diffs.push(
      `styleGuide changed: ${oldProfile.styleGuide ? `${oldProfile.styleGuide.framework}/${oldProfile.styleGuide.colors.join(",")}` : "null"} → ${newProfile.styleGuide ? `${newProfile.styleGuide.framework}/${newProfile.styleGuide.colors.join(",")}` : "null"}`,
    );
  }
  if (oldProfile.toneOfVoice !== newProfile.toneOfVoice) {
    diffs.push(`toneOfVoice changed: "${oldProfile.toneOfVoice}" → "${newProfile.toneOfVoice}"`);
  }
  if (oldProfile.businessModel !== newProfile.businessModel) {
    diffs.push(`businessModel changed: "${oldProfile.businessModel}" → "${newProfile.businessModel}"`);
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// Semantic significance check (fixes the rewording-false-positive bug above)
// ---------------------------------------------------------------------------

export type DriftSignificanceVerdict = { significant: boolean; reasoning: string };

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
const MAX_TURNS = 10;
const MAX_BUDGET_USD = 1;
const SIGNIFICANCE_MARKER = "DRIFT_SIGNIFICANCE_JSON:";

function buildSignificancePrompt(diffs: string[], oldProfile: AppProfile, newProfile: AppProfile): string {
  return `Two scans of the same app produced different text for some fields. Your
job is to judge whether the underlying app genuinely changed, or whether
this is just the scanning agent describing the same real facts with
different wording — both scans are independently honest, so a difference
here does NOT automatically mean something changed.

Raw field-level differences detected:
${diffs.map((d) => `- ${d}`).join("\n")}

Previous scan's featureMap: ${JSON.stringify(oldProfile.featureMap)}
New scan's featureMap: ${JSON.stringify(newProfile.featureMap)}
Previous scan's styleGuide: ${JSON.stringify(oldProfile.styleGuide)}
New scan's styleGuide: ${JSON.stringify(newProfile.styleGuide)}

Judge "significant: true" only if there's a REAL change a human should
review — a feature added/removed/changed, an actual color palette or
framework change, a genuine shift in tone or positioning. Judge
"significant: false" if this is just paraphrasing, reordering, or
different-but-equivalent phrasing of the same underlying facts.

When finished, end your final message with exactly this marker on its own
line, followed by JSON (and nothing else after it):
${SIGNIFICANCE_MARKER}
{"significant": true|false, "reasoning": "..."}`;
}

/** Pure, unit-tested. Fails closed to `significant: true` on any parse
 * issue — this is a notification mechanism, not a mutating action, so the
 * safe default on an unreadable verdict is to surface it for a human to
 * look at, not silently suppress a possible real change. */
export function parseDriftSignificanceVerdict(finalText: string): DriftSignificanceVerdict {
  const markerIndex = finalText.indexOf(SIGNIFICANCE_MARKER);
  if (markerIndex === -1) {
    return { significant: true, reasoning: "could not parse a significance verdict from the agent's output" };
  }
  const jsonText = finalText.slice(markerIndex + SIGNIFICANCE_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { significant: true, reasoning: "malformed JSON after significance-check result marker" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { significant: true, reasoning: "significance-check result was not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.significant !== "boolean" || typeof obj.reasoning !== "string" || obj.reasoning.trim().length === 0) {
    return { significant: true, reasoning: "significance-check result had an invalid shape" };
  }
  return { significant: obj.significant, reasoning: obj.reasoning };
}

/** Thin, agent-invoking wrapper — only ever called when `diffAppProfiles`
 * already found at least one raw difference (the CLI skips this entirely
 * on zero raw diffs, cheap short-circuit). Independent of the scan agent
 * itself, same "a second agent judges, never the one that produced the
 * content" discipline this codebase uses for `checkAuthenticity`/
 * `checkTruthfulClaims`. */
export async function assessDriftSignificance(
  diffs: string[],
  oldProfile: AppProfile,
  newProfile: AppProfile,
): Promise<DriftSignificanceVerdict> {
  let finalText = "";
  let isError = false;

  try {
    for await (const message of query({
      prompt: buildSignificancePrompt(diffs, oldProfile, newProfile),
      options: {
        model: MODEL,
        permissionMode: "bypassPermissions",
        maxTurns: MAX_TURNS,
        maxBudgetUsd: MAX_BUDGET_USD,
        persistSession: false,
        settingSources: [],
        settings: { disableClaudeAiConnectors: true },
        tools: [],
      },
    })) {
      if (message.type === "result") {
        finalText = message.result ?? "";
        isError = Boolean(message.is_error);
      }
    }
  } catch (err) {
    isError = true;
    finalText = `(agent run threw before producing a result: ${(err as Error).message})`;
  }

  if (isError) return { significant: true, reasoning: `agent run failed: ${finalText}` };
  return parseDriftSignificanceVerdict(finalText);
}
