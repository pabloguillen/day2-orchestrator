/**
 * Step 4 (self-distributing), Component 5 — generic-AI-content patterns
 * (COORDINATION.md W42, docs/step4-self-distributing-plan.md).
 *
 * Same idiom as `false-positive-patterns.ts`: a single source of truth for
 * known "this reads as generic AI slop" tells, consumed by
 * `growth-creative.ts`'s independent authenticity-check agent
 * (`checkAuthenticity`). Safety rail 6 — not a hard block by default, but
 * every creative gets checked against this list, and the plan's own
 * consecutive-flag block policy is Component 6's job (the execution layer
 * is where cross-creative state/history lives), not this file's.
 *
 * Unlike `false-positive-patterns.ts`, these aren't tied to a persona —
 * they're generic writing tells, so there's no `personas`/`discovered`
 * filtering dimension, just the plan's own literal shape.
 */

export type GenericContentPattern = {
  /** Stable slug — never reuse once shipped, so a flagged creative's
   * `matchedPatterns` stays meaningful across runs. */
  id: string;
  description: string;
  /** Concrete phrases/constructions that match this pattern — not
   * exhaustive, illustrative enough for an agent to recognize the
   * *category*, not just these exact strings. */
  examples: string[];
};

export const GENERIC_CONTENT_PATTERNS: GenericContentPattern[] = [
  {
    id: "fast-paced-world-opener",
    description:
      "Opens by establishing a generic, unearned premise about modern life or " +
      "the category at large, instead of saying something specific to this app " +
      "or its actual users. Recognizable because it would work verbatim in an " +
      "ad for almost any other app.",
    examples: [
      "In today's fast-paced world, managing your finances has never been more important.",
      "We live in a world full of distractions.",
      "Life moves fast — your expenses shouldn't have to.",
    ],
  },
  {
    id: "unearned-superlative-vocabulary",
    description:
      "Leans on a small, recognizable set of marketing-superlative words to " +
      "signal excitement rather than actually describing what changed or why " +
      "it matters. The tell is the vocabulary showing up untethered from any " +
      "specific claim.",
    examples: [
      "A game-changing way to track your spending.",
      "Revolutionize how you manage money.",
      "Unlock effortless budgeting.",
      "Elevate your financial life.",
    ],
  },
  {
    id: "vague-unquantified-social-proof",
    description:
      "Claims popularity or trust without a real, checkable number or a " +
      "specific, attributable source — a claim that could be typed without " +
      "ever having looked at real usage data.",
    examples: [
      "Join thousands of happy users.",
      "Loved by people everywhere.",
      "The budgeting app everyone's talking about.",
    ],
  },
  {
    id: "formulaic-urgency-cta",
    description:
      "Closes with a stock urgency/scarcity call-to-action pattern rather " +
      "than a specific next step grounded in what the creative actually " +
      "offered — recognizable by working as a closer for literally any " +
      "product.",
    examples: ["Don't wait — try it today!", "Download now and never look back.", "Start your journey today!"],
  },
  {
    id: "numbered-listicle-header-mismatch",
    description:
      "Frames the body as \"N reasons/ways/tips\" when the actual content " +
      "doesn't need that structure — a formatting reflex, not something " +
      "earned by the content having genuinely enumerable, parallel items.",
    examples: ["3 reasons you'll love this app", "5 ways to save more this month", "Top 7 budgeting tips"],
  },
  {
    id: "rhetorical-question-stacking",
    description:
      "Opens or transitions with a rhetorical question whose answer is " +
      "obvious and whose purpose is purely rhythmic, not to actually engage " +
      "a real, specific concern the target user has.",
    examples: [
      "Tired of losing track of your spending?",
      "Ever wonder where your money goes?",
      "What if budgeting could be simple?",
    ],
  },
];

/** Rendered into the authenticity-check agent's prompt (`growth-creative.ts`,
 * `checkAuthenticity`) — every entry `[id]`-tagged so a verdict's
 * `matchedPatterns` can cite exactly which ones fired, same diagnostic
 * framing `buildSkepticChecklist` uses. */
export function buildAuthenticityChecklist(): string {
  const entries = GENERIC_CONTENT_PATTERNS.map(
    (p) => `[${p.id}] ${p.description}\nExamples: ${p.examples.map((e) => `"${e}"`).join(" / ")}`,
  ).join("\n\n");
  return `Known patterns that make marketing copy read as generic, could-be-any-app
AI content. A creative doesn't have to match one of these to be flagged —
these are the well-known, most common tells, not an exhaustive list — but
if it clearly matches one, cite its bracketed id:

${entries}`;
}
