import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { evaluateAutonomy } from "./autonomy";
import type { AutonomyAreaConfig, AutonomyConfig, AutonomyLevel, ChangeForAutonomy } from "./types";

/**
 * Plain-language authoring for `.day2-autonomy.json` — the one remaining gap
 * under the approval cards (COORDINATION.md W20): an owner can already
 * review/apply individual pending fixes without touching GitHub, but the
 * only way any area ever reaches L3+ ("ship low-risk fixes automatically")
 * is hand-editing raw JSON. This module never re-implements `autonomy.ts`'s
 * sensitive-path/glob-matching logic — `previewArea` calls the real
 * `evaluateAutonomy()` so a preview can't drift out of sync with what
 * actually happens at release time.
 *
 * Deliberately does not expose a way to raise `defaultLevel` above "L2":
 * the source doc's own model is "autonomy is earned per area, not granted
 * platform-wide" (`types.ts`), so this tool only ever adds/removes named
 * areas, never widens the blanket default.
 */

export const AUTONOMY_CONFIG_FILENAME = ".day2-autonomy.json";

export function loadAutonomyConfig(path: string): AutonomyConfig {
  if (!existsSync(path)) {
    return { defaultLevel: "L2", areas: [] };
  }
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} exists but isn't valid JSON — fix or remove it by hand before using this tool.`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("areas" in parsed) ||
    !Array.isArray((parsed as { areas: unknown }).areas)
  ) {
    throw new Error(`${path} exists but doesn't look like a valid autonomy config — refusing to guess or overwrite it.`);
  }
  return parsed as AutonomyConfig;
}

export function saveAutonomyConfig(path: string, config: AutonomyConfig): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** Adds a new named area or replaces an existing one with the same name. */
export function setArea(
  config: AutonomyConfig,
  area: string,
  pathGlobs: string[],
  level: AutonomyLevel,
): AutonomyConfig {
  return {
    ...config,
    areas: [...config.areas.filter((a) => a.area !== area), { area, pathGlobs, level }],
  };
}

/** Reverts a named area to the blanket default (L2 unless changed elsewhere). */
export function removeArea(config: AutonomyConfig, area: string): AutonomyConfig {
  return { ...config, areas: config.areas.filter((a) => a.area !== area) };
}

/**
 * Answers the question an owner actually cares about — "if I turn this on,
 * will an ordinary verified bug fix here actually ship automatically?" —
 * by running a synthetic, otherwise-clean bug fix touching a sample path
 * from the area's own globs through the real decision engine. Catches the
 * case where an owner opts an area into L3+ whose glob is also matched by
 * the hard-coded sensitive-path override (payments/auth/login/etc.), where
 * the opt-in would silently never take effect.
 */
export function previewArea(
  config: AutonomyConfig,
  area: AutonomyAreaConfig,
): { willAutoShip: boolean; reason: string } {
  const sampleFile = (area.pathGlobs[0] ?? "example.ts").replace(/\*\*?/, "example");
  const change: ChangeForAutonomy = {
    sourceId: "autonomy-config-preview",
    filesChanged: [sampleFile],
    isBugfix: true,
    verifierApproved: true,
    ciPassed: true,
  };
  const decision = evaluateAutonomy(change, config);
  return { willAutoShip: decision.autoShip, reason: decision.reason };
}

/** Plain-language, read-only rendering of the current config — no jargon,
 * matching the source doc's framing for the other two review surfaces
 * (the owner feed and the approval cards). */
export function renderConfigSummary(config: AutonomyConfig): string {
  const lines: string[] = [];
  lines.push(
    `Default: areas with no explicit setting stay at ${config.defaultLevel} — every fix opens a PR, a human merges it.`,
  );
  if (config.areas.length === 0) {
    lines.push("No areas have opted into automatic shipping yet.");
    return lines.join("\n");
  }
  lines.push("");
  for (const area of config.areas) {
    const { willAutoShip, reason } = previewArea(config, area);
    const globList = area.pathGlobs.join(", ");
    if (area.level === "L2" || !willAutoShip) {
      lines.push(`- "${area.area}" (${globList}): still requires a human to merge. ${reason}`);
    } else {
      lines.push(
        `- "${area.area}" (${globList}): verified low-risk bug fixes here ship automatically, with one-tap undo (level ${area.level}).`,
      );
    }
  }
  return lines.join("\n");
}
