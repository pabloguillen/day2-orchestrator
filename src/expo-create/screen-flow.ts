import { cleanScreen, screenId, tidyLinks } from "./plan";
import type { ChangeRequest, ExpoBuild, FlowComment, FlowVersion, Identifiers, PlanScreen, ProductPlan, ScreenDesign } from "./types";

/**
 * The owner's rounds on the screen flow: comments on single screens (pinned
 * or as text), change requests (redraw, add or remove screens), screens
 * approved early (they never change again), and which screens a round has
 * to redraw — only the affected ones. Pure.
 */

export const STYLE = "style";
export const WHOLE_FLOW = "flow";

export const latest = (b: Pick<ExpoBuild, "flow">): FlowVersion | undefined => b.flow.versions.at(-1);
export const openComments = (b: Pick<ExpoBuild, "flow">): FlowComment[] => b.flow.comments.filter((c) => c.doneIn === undefined);

/** Pure. A comment from the console; null when unusable. */
export function parseComment(raw: unknown, screens: string[]): { screenId: string; text: string; pin?: { x: number; y: number } } | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const text = typeof r.text === "string" ? r.text.trim().slice(0, 2000) : "";
  const id = typeof r.screenId === "string" ? r.screenId : "";
  if (text.length < 2 || !(id === STYLE || id === WHOLE_FLOW || screens.includes(id))) return null;
  const p = r.pin as { x?: unknown; y?: unknown } | undefined;
  const ok = (n: unknown): n is number => typeof n === "number" && n >= 0 && n <= 1;
  return { screenId: id, text, ...(p && ok(p.x) && ok(p.y) ? { pin: { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 } } : {}) };
}

/** Pure. A change request from the console; null when it asks for nothing. */
export function parseChangeRequest(raw: unknown, screens: string[]): ChangeRequest {
  const r = (raw ?? {}) as Record<string, unknown>;
  const note = typeof r.note === "string" ? r.note.trim().slice(0, 2000) : "";
  const add = (Array.isArray(r.add) ? r.add : [])
    .map((a: Record<string, unknown>) => ({ name: typeof a?.name === "string" ? a.name.trim().slice(0, 80) : "", purpose: typeof a?.purpose === "string" ? a.purpose.trim().slice(0, 400) : "" }))
    .filter((a) => a.name.length >= 2)
    .slice(0, 6);
  const remove = (Array.isArray(r.remove) ? r.remove : []).filter((x): x is string => typeof x === "string" && screens.includes(x)).slice(0, 16);
  return { note, add, remove };
}

export const isEmptyChange = (c: ChangeRequest, comments: FlowComment[]) => !c.note && !c.add.length && !c.remove.length && !comments.length;

/** Pure. Same screen, as far as its drawing is concerned. */
const sameScreen = (a: PlanScreen, b: PlanScreen) =>
  JSON.stringify([a.name, a.route, a.purpose, a.elements, a.states, a.links, a.stateOf ?? null, a.state ?? null, a.androidDiffers ?? false, a.flow]) ===
  JSON.stringify([b.name, b.route, b.purpose, b.elements, b.states, b.links, b.stateOf ?? null, b.state ?? null, b.androidDiffers ?? false, b.flow]);

/**
 * Pure. The revised plan with the owner's rules enforced: approved screens
 * stay exactly as they were (put back if the agent dropped or changed
 * them), removed screens are gone, links to screens that don't exist are
 * dropped.
 */
export function enforceLocks(prev: ProductPlan, next: ProductPlan, locked: string[], removed: string[]): ProductPlan {
  const prevById = new Map(prev.screens.map((s) => [s.id, s]));
  const keep = new Set(locked.filter((id) => prevById.has(id) && !removed.includes(id)));
  const screens: PlanScreen[] = [];
  const seen = new Set<string>();
  for (const s of next.screens) {
    if (removed.includes(s.id) || seen.has(s.id)) continue;
    screens.push(keep.has(s.id) ? prevById.get(s.id)! : s);
    seen.add(s.id);
  }
  for (const id of keep) if (!seen.has(id)) screens.push(prevById.get(id)!);
  return { ...next, screens: tidyLinks(screens) };
}

/**
 * Pure. Which screens a round redraws: the ones commented on, new ones,
 * ones whose plan entry changed, ones not drawn yet, and every screen when
 * the design system changed — never an approved one.
 */
export function affectedScreens(o: { prev: ProductPlan; next: ProductPlan; designs: ScreenDesign[]; commented: string[]; styleChanged: boolean; locked: string[] }): string[] {
  const prevById = new Map(o.prev.screens.map((s) => [s.id, s]));
  const drawn = new Set(o.designs.map((d) => d.screenId));
  const out: string[] = [];
  for (const s of o.next.screens) {
    const before = prevById.get(s.id);
    const hit = !drawn.has(s.id) || !before || !sameScreen(before, s) || o.commented.includes(s.id) || o.styleChanged;
    // An approved screen is redrawn only when it has never been drawn.
    if (hit && (!o.locked.includes(s.id) || !drawn.has(s.id))) out.push(s.id);
  }
  return out;
}

/** Pure. A new version's starting point: the drawings that stay, carried over from the last version. */
export function draftFrom(last: FlowVersion, plan: ProductPlan, redraw: string[], at: string, asked?: string): FlowVersion & { redraw: string[]; styleChanged: boolean } {
  const ids = new Set(plan.screens.map((s) => s.id));
  return {
    n: last.n + 1,
    at,
    plan,
    designSystem: last.designSystem,
    style: last.style,
    designs: last.designs.filter((d) => ids.has(d.screenId) && !redraw.includes(d.screenId)),
    changed: [],
    ...(asked ? { asked } : {}),
    redraw,
    styleChanged: false,
  };
}

/** Pure. A one-line summary of what the owner asked for (shown with the version). */
export function describeChange(c: ChangeRequest, comments: FlowComment[], names: Map<string, string>): string {
  const parts: string[] = [];
  if (comments.length) parts.push(`${comments.length} comment${comments.length === 1 ? "" : "s"}`);
  if (c.add.length) parts.push(`add ${c.add.map((a) => a.name).join(", ")}`);
  if (c.remove.length) parts.push(`remove ${c.remove.map((id) => names.get(id) ?? id).join(", ")}`);
  if (c.note) parts.push(c.note.length > 80 ? `${c.note.slice(0, 80)}…` : c.note);
  return parts.join(" · ");
}

/** Pure. Screens added by the owner that the agent didn't include are added as plain entries (so nothing asked for is lost). */
export function ensureAdded(plan: ProductPlan, add: ChangeRequest["add"]): ProductPlan {
  const screens = [...plan.screens];
  for (const a of add) {
    const lower = a.name.toLowerCase();
    if (screens.some((s) => s.name.toLowerCase() === lower || s.id === screenId(a.name))) continue;
    const s = cleanScreen({ id: screenId(a.name), name: a.name, route: `/${screenId(a.name)}`, purpose: a.purpose, flow: "main", states: ["filled"], links: [] });
    if (s) screens.push(s);
  }
  return { ...plan, screens };
}

/** Routes a Maestro flow can open directly (no parameters, not a state drawing). */
export const openable = (s: PlanScreen) => !s.stateOf && !/\[|\(/.test(s.route);

/**
 * Pure. The Maestro flow day2 writes into the app (.maestro/day2/screens.yaml):
 * it opens each screen by its deep link and takes a screenshot named after
 * the screen, so the device checks' pictures can be put next to the drawings.
 */
export function screensMaestroFlow(plan: ProductPlan, ids: Pick<Identifiers, "bundleId" | "scheme">): string {
  const lines = [`appId: ${ids.bundleId}`, "name: day2 — every approved screen", "---", "- launchApp"];
  for (const s of plan.screens.filter(openable)) {
    lines.push(`- openLink: "${ids.scheme}://${s.route.replace(/^\//, "")}"`, "- waitForAnimationToEnd", `- takeScreenshot: screen-${s.id}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Pure. Device-check screenshot names back to screen ids ("screen-today" → "today"). */
export function screenFromShot(name: string): string | null {
  const m = name.match(/^screen-([a-z0-9-]+)$/);
  return m ? m[1]! : null;
}
