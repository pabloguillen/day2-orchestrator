import type { ExpoBuild, FlowVersion, Phase, PlanScreen, ProductPlan } from "./types";

/**
 * Builds stored before the screen flow (record format 1: plan review → 2–3
 * key screens → screens/data/polish) are moved to the nearest new state
 * when they're read. Nothing is charged by the move: a build that was
 * waiting on the owner keeps waiting.
 *
 *   plan                    → plan (writes the screen list)
 *   plan_review (owner)     → flow_review, v1 with the plan's screens, none drawn yet
 *                             (the owner asks day2 to draw them, or comments)
 *   mockups                 → style (the design system, then every screen)
 *   mockup_review (owner)   → flow_review, v1 with the key screens' drawings
 *   screens                 → theme (the old step built theme and screens together)
 *   data                    → backend
 *   scaffold, prewire, polish, publish, onboard, done → the same
 */

export const RECORD_VERSION = 2;

const OLD_PHASE: Record<string, Phase> = {
  plan: "plan",
  plan_review: "flow_review",
  mockups: "style",
  mockup_review: "flow_review",
  scaffold: "scaffold",
  prewire: "prewire",
  screens: "theme",
  data: "backend",
  polish: "polish",
  publish: "publish",
  onboard: "onboard",
  done: "done",
};

/** A neutral design system for old builds (they were drawn without one). */
const LEGACY_SYSTEM: FlowVersion["designSystem"] = {
  name: "From the first drawings",
  colors: [
    { role: "background", hex: "#ffffff", use: "Screen background" },
    { role: "surface", hex: "#f4f4f2", use: "Cards and rows" },
    { role: "text", hex: "#1c1c1e", use: "Text" },
    { role: "muted", hex: "#6b6b70", use: "Secondary text" },
    { role: "primary", hex: "#2f6f5e", use: "Main buttons" },
    { role: "onPrimary", hex: "#ffffff", use: "Text on main buttons" },
    { role: "accent", hex: "#e8a33d", use: "Highlights" },
    { role: "border", hex: "#e2e2de", use: "Dividers" },
    { role: "danger", hex: "#c0392b", use: "Errors" },
    { role: "success", hex: "#2e8b57", use: "Done" },
  ],
  fonts: { heading: "-apple-system, Roboto, sans-serif", body: "-apple-system, Roboto, sans-serif" },
  type: [
    { name: "title", size: 28, weight: 700, lineHeight: 34 },
    { name: "headline", size: 17, weight: 600, lineHeight: 22 },
    { name: "body", size: 17, weight: 400, lineHeight: 22 },
    { name: "caption", size: 13, weight: 400, lineHeight: 18 },
  ],
  spacing: [4, 8, 12, 16, 24, 32],
  radius: { small: 8, medium: 14, large: 24 },
  components: [],
  voice: "",
};

/** Pure. Old plan screens get the screen-flow fields. */
export function migratePlan(p: ProductPlan): ProductPlan {
  const screens: PlanScreen[] = (p.screens ?? []).map((s) => ({ ...s, flow: s.flow ?? "main", states: s.states?.length ? s.states : ["filled"], links: s.links ?? [] }));
  return { ...p, screens, functions: p.functions ?? [], language: p.language ?? "en" };
}

/** Pure. Any stored build as a current one (current ones come back unchanged). */
export function migrateBuild(raw: ExpoBuild): ExpoBuild {
  if (raw.v === RECORD_VERSION && raw.flow) return raw;
  const old = raw as Omit<ExpoBuild, "phase"> & { phase: string };
  const plan = old.plan ? migratePlan(old.plan) : undefined;
  const phase = OLD_PHASE[old.phase] ?? "plan";
  const b: ExpoBuild = {
    ...old,
    v: RECORD_VERSION,
    plan,
    phase,
    flow: old.flow ?? { versions: [], comments: [], approved: [] },
    mockups: old.mockups ?? [],
    mockupComments: old.mockupComments ?? [],
    comparisons: old.comparisons ?? [],
    planComments: old.planComments ?? [],
    checks: (old.checks ?? []).map((c) => ({ ...c, phase: OLD_PHASE[c.phase as string] ?? c.phase })),
    ...(old.stuck ? { stuck: { ...old.stuck, phase: OLD_PHASE[old.stuck.phase as string] ?? old.stuck.phase } } : {}),
  };
  // Waiting on the owner at the old plan or key screens: a v1 to look at (the drawings it has).
  if (phase === "flow_review" && plan && !b.flow.versions.length) {
    const at = b.updatedAt ?? b.at;
    const legacy = old.phase === "mockup_review" ? b.mockups : [];
    b.flow = {
      ...b.flow,
      versions: [
        {
          n: 1,
          at,
          plan,
          designSystem: LEGACY_SYSTEM,
          style: { png: "", html: "", drawnIn: 1 },
          designs: legacy.map((m) => ({ screenId: m.screenId, drawnIn: 1, png: m.file, html: "", note: m.note, hotspots: [] })),
          changed: legacy.map((m) => m.screenId),
          asked: "Moved from the earlier plan review",
        },
      ],
    };
  }
  return b;
}
