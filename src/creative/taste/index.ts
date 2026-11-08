import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TEMPLATE_IDS, type TemplateId } from "../templates/types";

/**
 * The taste layer's data (docs/creative-quality.md): the versioned rubric
 * and examples the art director and the critic work from, and what this
 * app's owner approved, declined, edited and picked per template — so day2
 * prefers what the owner likes ("training" without fine-tuning).
 */

export const CURRENT_RUBRIC = 1;
const DIR = import.meta.dir;

export const CRITERIA = [
  { id: "hook", label: "Scroll-stopping first second", weight: 2, blocker: false },
  { id: "legibility", label: "Legibility at phone size", weight: 2, blocker: true },
  { id: "safe_zones", label: "Safe zones", weight: 1.5, blocker: true },
  { id: "brand", label: "Brand match", weight: 1.5, blocker: false },
  { id: "language", label: "Language consistency", weight: 2, blocker: true },
  { id: "real_product", label: "Real product", weight: 1.5, blocker: true },
  { id: "hierarchy", label: "Hierarchy", weight: 1, blocker: false },
  { id: "pacing", label: "Motion pacing", weight: 1, blocker: false },
  { id: "clutter", label: "No clutter", weight: 1, blocker: false },
  { id: "native", label: "Truthful & native", weight: 1, blocker: false },
] as const;
export type CriterionId = (typeof CRITERIA)[number]["id"];
export type Scores = Partial<Record<CriterionId, number>>;
export const PASS_SCORE = 7;
export const BLOCKER_MIN = 6;

export function rubricText(version = CURRENT_RUBRIC): string {
  const p = join(DIR, `rubric.v${version}.md`);
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}
export function examples(): Array<{ verdict: "good" | "bad"; template: string | null; what: string; why: string[] }> {
  try {
    return (JSON.parse(readFileSync(join(DIR, "examples.json"), "utf-8")) as { examples: Array<{ verdict: "good" | "bad"; template: string | null; what: string; why: string[] }> }).examples;
  } catch {
    return [];
  }
}

/** Weighted 0–10 over the criteria that were scored (motion pacing is skipped for stills). Pure. */
export function weightedScore(s: Scores): number {
  let sum = 0;
  let w = 0;
  for (const c of CRITERIA) {
    const v = s[c.id];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    sum += Math.max(0, Math.min(10, v)) * c.weight;
    w += c.weight;
  }
  return w ? Math.round((sum / w) * 10) / 10 : 0;
}

/** Ships when the weighted score is ≥ 7 and no blocker is under 6. Pure. */
export function passes(s: Scores): { ok: boolean; failing: CriterionId[] } {
  const failing = CRITERIA.filter((c) => c.blocker && typeof s[c.id] === "number" && s[c.id]! < BLOCKER_MIN).map((c) => c.id);
  return { ok: weightedScore(s) >= PASS_SCORE && failing.length === 0, failing };
}

// ---------------------------------------------------------------- owner preferences

export const CREATIVE_STATE_FILENAME = "day2-creative.json";
export type TemplateTally = { approved: number; declined: number; picked: number; passed: number; edited: number; reasons: string[] };
export type CreativeState = { templates: Partial<Record<TemplateId, TemplateTally>>; howItWorksAt: string | null; whatsNewVersion?: string | null; log: Array<{ at: string; text: string }> };

const empty = (): CreativeState => ({ templates: {}, howItWorksAt: null, log: [] });
export const creativeStatePath = (repoPath: string) => resolve(repoPath, CREATIVE_STATE_FILENAME);

export function loadCreativeState(repoPath: string): CreativeState {
  const p = creativeStatePath(repoPath);
  if (!existsSync(p)) return empty();
  try {
    const j = JSON.parse(readFileSync(p, "utf-8")) as Partial<CreativeState>;
    return { templates: j.templates ?? {}, howItWorksAt: j.howItWorksAt ?? null, whatsNewVersion: j.whatsNewVersion ?? null, log: Array.isArray(j.log) ? j.log.slice(0, 50) : [] };
  } catch {
    return empty();
  }
}
export function updateCreativeState(repoPath: string, fn: (s: CreativeState) => CreativeState): CreativeState {
  const next = fn(loadCreativeState(repoPath));
  const p = creativeStatePath(repoPath);
  writeFileSync(`${p}.tmp`, `${JSON.stringify({ ...next, log: next.log.slice(0, 50) }, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
  return next;
}

export type OwnerSignal = "approved" | "declined" | "picked" | "passed" | "edited";
/** One owner decision on a post made with `template`. Pure. */
export function noteSignal(s: CreativeState, template: TemplateId, signal: OwnerSignal, reason?: string | null, at = new Date()): CreativeState {
  const cur: TemplateTally = s.templates[template] ?? { approved: 0, declined: 0, picked: 0, passed: 0, edited: 0, reasons: [] };
  const next = { ...cur, [signal]: cur[signal] + 1, reasons: reason ? [reason.slice(0, 160), ...cur.reasons].slice(0, 6) : cur.reasons };
  return { ...s, templates: { ...s.templates, [template]: next }, log: [{ at: at.toISOString(), text: `${template}: ${signal}${reason ? ` (${reason.slice(0, 80)})` : ""}` }, ...s.log].slice(0, 50) };
}

/**
 * How much the owner likes each template, 0..1 (Beta(2,2) prior over
 * approvals + picks vs declines + passed-over variants; edits count half
 * against). Pure.
 */
export function templateLiking(s: CreativeState): Record<TemplateId, number> {
  const out = {} as Record<TemplateId, number>;
  for (const id of TEMPLATE_IDS) {
    const t = s.templates[id];
    const good = (t?.approved ?? 0) + (t?.picked ?? 0);
    const bad = (t?.declined ?? 0) + (t?.passed ?? 0) * 0.7 + (t?.edited ?? 0) * 0.5;
    out[id] = (2 + good) / (4 + good + bad);
  }
  return out;
}

/** For the art director's prompt: what the owner said yes and no to (fixed words + the owner's short reasons, as data). Pure. */
export function preferenceLines(s: CreativeState): string[] {
  const liking = templateLiking(s);
  return (Object.entries(s.templates) as Array<[TemplateId, TemplateTally]>)
    .filter(([, t]) => t.approved + t.declined + t.picked + t.passed > 0)
    .sort((a, b) => liking[b[0]] - liking[a[0]])
    .map(([id, t]) => `${id}: approved ${t.approved}, picked ${t.picked}, declined ${t.declined}, passed over ${t.passed}${t.reasons.length ? `; owner said: ${t.reasons.slice(0, 3).map((r) => `"${r}"`).join(", ")}` : ""}`);
}
