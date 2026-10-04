import { appendFileSync } from "node:fs";
import type { AutonomyConfig, AutonomyDecision, AutonomyLevel, ChangeForAutonomy } from "./types";

/**
 * Decision-only: this module answers "is the runtime allowed to ship this
 * without a human?" and writes an audit entry. It does NOT perform any
 * merge/deploy itself — the release pipeline (pr.ts / a future release.ts)
 * is expected to call evaluateAutonomy() and act on the result. Kept
 * separate deliberately so this can be reasoned about (and tested) without
 * touching real release mechanics.
 */

/** L4/L5 are ordered above L3 here (for `levelIndex`) but nothing in this
 * file branches on them specifically — see the "Current implementation
 * reality" note on `AutonomyLevel` in types.ts. Setting an area to L4 or L5
 * ships exactly like L3 today; this is a deliberate, documented decision
 * (2026-10-03), not a bug to fix by adding more branches here without a real
 * L4/L5 behavior to attach them to first. */
const LEVEL_ORDER: AutonomyLevel[] = ["L0", "L1", "L2", "L3", "L4", "L5"];

function levelIndex(level: AutonomyLevel): number {
  return LEVEL_ORDER.indexOf(level);
}

/** Hard default: an area not explicitly configured stays at L2 ("Prepare")
 * — opens a tested PR, human merges. This must never silently change; any
 * repo that hasn't opted into autonomy config keeps today's behavior. */
export const DEFAULT_AUTONOMY_CONFIG: AutonomyConfig = {
  defaultLevel: "L2",
  areas: [],
};

/**
 * Paths that always require a human, regardless of configured autonomy
 * level — not overridable by config. Matches the source doc's own rule
 * ("fixes touching payments, login or data: always ask first").
 */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /payment/i,
  /billing/i,
  /\bauth\b/i,
  /login/i,
  /session/i,
  /migration/i,
  /schema/i,
  /\.env/i,
];

function matchesGlob(filePath: string, glob: string): boolean {
  // Minimal glob support: '*' matches any run of non-slash chars, '**' matches
  // anything. Single-pass token replace (not a two-step placeholder swap) so
  // there's no intermediate token that could itself collide with real regex
  // metacharacters -- a prior version used a literal NUL byte as that
  // placeholder, which worked (paths never contain NUL) but made this file
  // register as binary to git, breaking diffs.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\*\*|\*/g, (token) => (token === "**" ? ".*" : "[^/]*"));
  return new RegExp(`^${pattern}$`).test(filePath);
}

/** Pairs a file's resolved level with the configured area that produced it
 * (if any), so callers never have to re-derive "which area actually governed
 * this decision" via a separate, independently-matched lookup — that split
 * is exactly what let `matchedArea` drift out of sync with `effectiveLevel`
 * (an area not tied to the lowest level could still get reported as the one
 * that blocked a change). */
function resolveFileAreaLevel(filePath: string, config: AutonomyConfig): { level: AutonomyLevel; area: string | undefined } {
  const matched = config.areas.filter((area) => area.pathGlobs.some((glob) => matchesGlob(filePath, glob)));
  // A file matched by no configured area falls back to the default. A file
  // matched by one or more areas uses the most restrictive of *those* —
  // the global default doesn't drag an explicitly-configured area back down.
  if (matched.length === 0) return { level: config.defaultLevel, area: undefined };
  return matched.reduce(
    (acc, a) => (levelIndex(a.level) <= levelIndex(acc.level) ? { level: a.level, area: a.area } : acc),
    { level: matched[0]!.level, area: matched[0]!.area },
  );
}

/**
 * Resolves the effective autonomy level and ship/no-ship decision for a
 * change. Conservative by construction: a change touching multiple areas
 * gets the *most restrictive* (lowest) level among them, and any sensitive-
 * path match forces PR-only regardless of configured level.
 */
export function evaluateAutonomy(
  change: ChangeForAutonomy,
  config: AutonomyConfig = DEFAULT_AUTONOMY_CONFIG,
): AutonomyDecision {
  const sensitiveMatch = change.filesChanged.find((f) =>
    SENSITIVE_PATH_PATTERNS.some((p) => p.test(f)),
  );
  if (sensitiveMatch) {
    return {
      level: "L2",
      autoShip: false,
      area: "sensitive-override",
      reason: `Touches a sensitive path (${sensitiveMatch}) — payments, auth, login, sessions, migrations and schema changes always require human review, regardless of configured autonomy level.`,
    };
  }

  // Single pass per changed file, carrying the governing area alongside its
  // level — not two independent lookups (one for the level, one for the
  // area) that could each pick a different file/area and disagree.
  const fileAreaLevels = change.filesChanged.map((f) => resolveFileAreaLevel(f, config));
  const governing =
    fileAreaLevels.length === 0
      ? { level: config.defaultLevel, area: undefined }
      : fileAreaLevels.reduce((acc, x) => (levelIndex(x.level) <= levelIndex(acc.level) ? x : acc));
  const effectiveLevel = governing.level;
  const matchedArea = governing.area ?? "default";

  if (levelIndex(effectiveLevel) < levelIndex("L3")) {
    return {
      level: effectiveLevel,
      autoShip: false,
      area: matchedArea,
      reason: `Area's configured autonomy is ${effectiveLevel} (needs L3 "Act on low risk" or higher to auto-ship) — opened as a PR for human review instead.`,
    };
  }
  if (!change.isBugfix) {
    return {
      level: effectiveLevel,
      autoShip: false,
      area: matchedArea,
      reason: "Not classified as a bug fix — new features and flows always require human approval, regardless of autonomy level.",
    };
  }
  if (!change.verifierApproved) {
    return {
      level: effectiveLevel,
      autoShip: false,
      area: matchedArea,
      reason: "Independent verifier has not approved this change — cannot auto-ship regardless of autonomy level.",
    };
  }
  if (!change.ciPassed) {
    return {
      level: effectiveLevel,
      autoShip: false,
      area: matchedArea,
      reason: "CI has not passed — cannot auto-ship regardless of autonomy level.",
    };
  }

  return {
    level: effectiveLevel,
    autoShip: true,
    area: matchedArea,
    reason: `Bug fix, independently verified, CI green, no sensitive paths touched, area autonomy is ${effectiveLevel} — eligible to ship automatically per L3 "Act on low risk".`,
  };
}

/**
 * Append-only JSON-lines audit trail — one entry per evaluated change.
 * Matches the source doc's "full audit trail for SOC 2 and ISO
 * change-management requirements." Caller supplies the file path so tests
 * and different repos can point this elsewhere; nothing here decides where
 * production audit logs live.
 */
export function recordAutonomyAudit(
  auditFile: string,
  change: ChangeForAutonomy,
  decision: AutonomyDecision,
  summary?: string,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    sourceId: change.sourceId,
    area: decision.area,
    filesChanged: change.filesChanged,
    level: decision.level,
    autoShip: decision.autoShip,
    reason: decision.reason,
    ...(summary ? { summary } : {}),
  };
  appendFileSync(auditFile, `${JSON.stringify(entry)}\n`);
}
