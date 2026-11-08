import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetStore } from "../ads/assets";
import type { AppEntry } from "../apps-registry";
import { loadBrandKit, resolveKit } from "./brand-kit";
import { layoutIssues } from "./critique";
import { renderSlideComposition, type Rendered } from "./render";
import { TEMPLATES } from "./templates";
import type { Ratio, ScreenAsset, ShotList } from "./templates/types";

/**
 * The owner's edits to a carousel on the post card: new words on a slide
 * (re-rendered in the template, checked for layout again) or a new order.
 */

/** Applies per-slide words to a shot list (slide 0 = cover, 1..n = steps, n+1 = end). Pure. */
export function applySlideTexts(shots: ShotList, edits: Array<{ index: number; headline?: string; caption?: string | null }>): ShotList {
  const next: ShotList = structuredClone(shots);
  const clip = (v: string, n: number) => v.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
  for (const e of edits) {
    if (!Number.isInteger(e.index) || e.index < 0) continue;
    if (e.index === 0) {
      if (typeof e.headline === "string" && e.headline.trim()) next.hook = clip(e.headline, 60);
      if (e.caption !== undefined) next.kicker = e.caption ? clip(e.caption, 28) : null;
    } else if (e.index <= next.steps.length) {
      const st = next.steps[e.index - 1]!;
      if (typeof e.headline === "string" && e.headline.trim()) st.headline = clip(e.headline, 48);
      if (e.caption !== undefined) st.caption = e.caption ? clip(e.caption, 110) : null;
    } else if (e.index === next.steps.length + 1) {
      if (typeof e.headline === "string") next.endLine = clip(e.headline, 70);
      if (typeof e.caption === "string" && e.caption.trim()) next.cta = clip(e.caption, 22);
    }
  }
  return next;
}

/**
 * A new order for the slides: `order` lists the current slides' asset ids.
 * When cover and end stay in place, the steps in the shot list follow (so a
 * later re-render keeps the order). Pure.
 */
export function reorderSlides(ids: string[], order: string[], shots: ShotList | null): { ids: string[]; shots: ShotList | null } | null {
  if (order.length !== ids.length || new Set(order).size !== order.length || !order.every((x) => ids.includes(x))) return null;
  if (!shots || order[0] !== ids[0] || order[order.length - 1] !== ids[ids.length - 1] || ids.length !== shots.steps.length + 2) return { ids: order, shots };
  const steps = order.slice(1, -1).map((id) => shots.steps[ids.indexOf(id) - 1]!);
  return { ids: order, shots: { ...shots, steps } };
}

/** Renders the carousel again with new words; returns the new slide assets per ratio, or the layout problem. */
export async function rerenderSlides(app: Pick<AppEntry, "id" | "name" | "repoPath">, o: { shots: ShotList; screens: ScreenAsset[]; language: string; store: AssetStore; tag: string; ratios?: Ratio[] }): Promise<{ ok: true; slides: Partial<Record<Ratio, string[]>> } | { ok: false; problem: string }> {
  const t = TEMPLATES[o.shots.template];
  if (!t.slides) return { ok: false, problem: "this template has no slides" };
  const kit = resolveKit(loadBrandKit(app.repoPath), { repoPath: app.repoPath, appName: app.name });
  kit.language = o.language;
  const dir = mkdtempSync(join(tmpdir(), "day2-edit-"));
  try {
    const rendered: Rendered = { template: o.shots.template, video: null, slides: [] };
    for (const r of o.ratios ?? ["4:5", "1:1"]) rendered.slides.push(await renderSlideComposition(t.slides({ shots: o.shots, kit, screens: o.screens, broll: [] }, r), { dir, name: "edit" }));
    const bad = layoutIssues({ rendered, screens: o.screens, language: o.language, hasIcon: Boolean(kit.icon), warned: true }).filter((i) => i.severity === "blocker");
    if (bad.length) return { ok: false, problem: bad[0]!.text };
    const out: Partial<Record<Ratio, string[]>> = {};
    for (const s of rendered.slides) {
      const ids: string[] = [];
      for (const [k, f] of s.files.entries()) ids.push((await o.store.put(f, { appId: app.id, purpose: o.tag, label: `${t.label} slide ${k + 1} (${s.ratio}, edited)`, kind: "image", ratio: s.ratio, width: 1080, height: s.ratio === "4:5" ? 1350 : 1080, mime: "image/jpeg", source: "motion_template", aiGenerated: false, aiPerson: false })).id);
      out[s.ratio] = ids;
    }
    return { ok: true, slides: out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
