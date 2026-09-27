/**
 * Step 3 (self-evolving), Component 1 — swarm calibration loop
 * (COORDINATION.md W30, docs/step3-self-evolving-plan.md).
 *
 * Single source of truth for every known swarm v1 false-positive pattern —
 * each one a real block on a real canary release, manually investigated
 * with real browser tools, and confirmed to not be a real bug (see the
 * `discovered` workstream for the full incident). Consumed two ways from
 * the same data, so the persona's own preventive guidance and the
 * calibration loop's diagnostic checklist can never drift apart:
 *   - `buildPersonaGuidance`: prose only, no ids, rendered into the
 *     persona's own task text so it avoids the mistake in the first place.
 *   - `buildSkepticChecklist`: the same prose, `[id]`-tagged, rendered into
 *     the calibration skeptic's prompt so it can re-apply an *already
 *     human-vetted* pattern to a failure — never invent a new one.
 *
 * Adding a pattern #4 means editing this array once; both prompts and the
 * skeptic's valid-id set pick it up automatically.
 */

export type FalsePositivePattern = {
  /** Stable slug — never reuse once shipped, `calibration.ts` persists
   * these in its audit log. */
  id: string;
  /** Base persona names (e.g. "accessibility-auditor") this pattern
   * applies to. */
  personas: string[];
  /** The pitfall plus concrete re-verification steps, one paragraph. */
  description: string;
  /** Workstream that found this, matching this project's citation style
   * (e.g. "W21"). */
  discovered: string;
};

export const FALSE_POSITIVE_PATTERNS: FalsePositivePattern[] = [
  {
    id: "css-transition-timing",
    personas: ["accessibility-auditor"],
    description: `If an element's focus style is CSS-transitioned (opacity, outline, etc.
animating in rather than appearing instantly), reading its computed style
immediately after focusing can catch it mid-transition. Wait a few
hundred milliseconds after focusing before you read/screenshot it, so you
see its settled state, not a snapshot mid-animation.`,
    discovered: "W21",
  },
  {
    id: "shadow-dom-active-element",
    personas: ["accessibility-auditor"],
    description: `\`document.activeElement\` reports the shadow *host* element, not the
actual focused node, when focus lands inside an open shadow root (e.g. a
third-party widget). Before judging an element's visibility or label from
\`document.activeElement\`, check whether it has a \`shadowRoot\` and, if
so, drill into \`el.shadowRoot.activeElement\` (repeat if nested) to find
the real focused element first.`,
    discovered: "W21",
  },
  {
    id: "native-control-internal-segment",
    personas: ["accessibility-auditor"],
    description: `Native form controls with internal segments that aren't separate DOM
nodes (e.g. \`<input type="date">\`'s day/month/year segments) render
their own focus highlighting as internal browser UI, not as anything
\`getComputedStyle()\` on the outer element can see — it'll report the
same value focused or not, every time, regardless of what's actually
drawn on screen. A computed-style check alone will always claim these are
broken. Take an actual screenshot and look at it before concluding a
segment/part like this has no visible focus indicator.`,
    discovered: "W25",
  },
];

function patternsFor(basePersonaName: string): FalsePositivePattern[] {
  return FALSE_POSITIVE_PATTERNS.filter((p) => p.personas.includes(basePersonaName));
}

export function hasApplicablePatterns(basePersonaName: string): boolean {
  return patternsFor(basePersonaName).length > 0;
}

/** Preventive framing, no ids — rendered straight into the persona's own
 * task text. Returns "" if nothing applies to this persona (nothing to
 * append). */
export function buildPersonaGuidance(basePersonaName: string): string {
  const patterns = patternsFor(basePersonaName);
  if (patterns.length === 0) return "";

  const count = patterns.length === 1 ? "One thing" : `${patterns.length} things`;
  const bullets = patterns.map((p) => `- ${p.description}`).join("\n");
  return `${count} that will make you misreport a working element as broken if
you skip ${patterns.length === 1 ? "it" : "them"} (${patterns.length === 1 ? "this has" : "all have"} hit real false positives in earlier runs, so
check for real, don't skip):
${bullets}`;
}

/** Diagnostic framing, with ids — rendered into the calibration skeptic's
 * prompt (calibration.ts). Returns "" if nothing applies to this persona
 * (calibration.ts short-circuits on this, spending no query() call). */
export function buildSkepticChecklist(basePersonaName: string): string {
  const patterns = patternsFor(basePersonaName);
  if (patterns.length === 0) return "";

  const entries = patterns.map((p) => `[${p.id}] ${p.description}`).join("\n\n");
  return `Known false-positive patterns for this persona — re-verify the failing
finding live against the preview URL, and clear it ONLY if it genuinely
matches one of these exactly (cite the bracketed id):

${entries}`;
}
