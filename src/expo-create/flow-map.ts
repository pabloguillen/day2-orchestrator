import { FLOW_GROUPS, FLOW_GROUP_LABEL, type FlowGroup, type FlowVersion, type PlanScreen } from "./types";

/**
 * The flow map: every screen as a thumbnail, grouped by flow (one lane per
 * flow), connected by arrows labelled with the action ("Tap Start → Sign
 * up"). A simple layered layout: columns are the distance from the first
 * screen along the links, lanes are the flows. Pure; drawn as HTML/SVG by
 * flowMapHtml (rendered to a PNG for the zip) and by the console from the
 * same layout.
 */

export const THUMB = { w: 120, h: 260 } as const;
const COL = 250; // column width: the thumbnail plus room for arrow labels
const ROW_GAP = 40;
const LANE_PAD = 28;
const LANE_HEAD = 150;
const LABEL_H = 22;

export type MapNode = { id: string; name: string; group: FlowGroup; x: number; y: number; w: number; h: number; column: number };
export type MapEdge = { from: string; to: string; label: string; d: string; labelX: number; labelY: number; back: boolean };
export type MapLane = { group: FlowGroup; label: string; x: number; y: number; w: number; h: number };
export type FlowMapLayout = { width: number; height: number; nodes: MapNode[]; edges: MapEdge[]; lanes: MapLane[] };

/** Pure. Column of each screen: shortest number of taps from the entry screen (unreachable ones go after their lane's last). */
export function columns(screens: PlanScreen[]): Map<string, number> {
  const ids = new Set(screens.map((s) => s.id));
  const entry = screens.find((s) => s.flow === "onboarding") ?? screens.find((s) => s.key) ?? screens[0];
  const col = new Map<string, number>();
  if (!entry) return col;
  col.set(entry.id, 0);
  const queue = [entry.id];
  const byId = new Map(screens.map((s) => [s.id, s]));
  while (queue.length) {
    const id = queue.shift()!;
    for (const l of byId.get(id)?.links ?? []) {
      if (!ids.has(l.to) || col.has(l.to)) continue;
      col.set(l.to, col.get(id)! + 1);
      queue.push(l.to);
    }
  }
  // State screens sit under the screen they're a state of.
  for (const s of screens) if (s.stateOf && col.has(s.stateOf) && !col.has(s.id)) col.set(s.id, col.get(s.stateOf)!);
  let max = Math.max(0, ...col.values());
  for (const s of screens) if (!col.has(s.id)) col.set(s.id, ++max);
  return col;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Pure. */
export function layoutFlowMap(screens: PlanScreen[]): FlowMapLayout {
  const col = columns(screens);
  const nodes: MapNode[] = [];
  const lanes: MapLane[] = [];
  let y = 0;
  const maxCol = Math.max(0, ...col.values());
  const width = LANE_HEAD + (maxCol + 1) * COL + LANE_PAD;
  for (const g of FLOW_GROUPS) {
    const inLane = screens.filter((s) => (s.flow ?? "main") === g);
    if (!inLane.length) continue;
    // Several screens in one column of a lane are stacked.
    const stack = new Map<number, number>();
    let rows = 1;
    for (const s of inLane) {
      const c = col.get(s.id)!;
      const row = stack.get(c) ?? 0;
      stack.set(c, row + 1);
      rows = Math.max(rows, row + 1);
      nodes.push({ id: s.id, name: s.name, group: g, column: c, x: LANE_HEAD + c * COL, y: y + LANE_PAD + row * (THUMB.h + LABEL_H + ROW_GAP), w: THUMB.w, h: THUMB.h });
    }
    const h = LANE_PAD * 2 + rows * (THUMB.h + LABEL_H) + (rows - 1) * ROW_GAP;
    lanes.push({ group: g, label: FLOW_GROUP_LABEL[g], x: 0, y, w: width, h });
    y += h + 16;
  }
  const at = new Map(nodes.map((n) => [n.id, n]));
  const names = new Map(screens.map((s) => [s.id, s.name]));
  const edges: MapEdge[] = [];
  for (const s of screens) {
    const a = at.get(s.id)!;
    for (const l of s.links) {
      const b = at.get(l.to);
      if (!b) continue;
      const back = b.column <= a.column;
      let x1: number, y1: number, x2: number, y2: number, d: string, lx: number, ly: number;
      if (!back) {
        x1 = a.x + a.w;
        y1 = a.y + a.h / 2;
        x2 = b.x;
        y2 = b.y + b.h / 2;
        const dx = Math.max(40, (x2 - x1) / 2);
        d = `M${r1(x1)},${r1(y1)} C${r1(x1 + dx)},${r1(y1)} ${r1(x2 - dx)},${r1(y2)} ${r1(x2)},${r1(y2)}`;
        // Midpoint of the cubic at t = 0.5.
        lx = (x1 + 3 * (x1 + dx) + 3 * (x2 - dx) + x2) / 8;
        ly = (y1 + 3 * y1 + 3 * y2 + y2) / 8;
      } else {
        // Back (or same-column) links go round below the screens.
        x1 = a.x + a.w / 2;
        y1 = a.y + a.h;
        x2 = b.x + b.w / 2;
        y2 = b.y + b.h;
        const dip = Math.max(y1, y2) + LABEL_H + 26;
        d = `M${r1(x1)},${r1(y1)} C${r1(x1)},${r1(dip)} ${r1(x2)},${r1(dip)} ${r1(x2)},${r1(y2)}`;
        lx = (x1 + 3 * x1 + 3 * x2 + x2) / 8;
        ly = (y1 + 3 * dip + 3 * dip + y2) / 8;
      }
      edges.push({ from: s.id, to: l.to, label: `${l.label} → ${names.get(l.to) ?? l.to}`, d, labelX: r1(lx), labelY: r1(ly), back });
    }
  }
  return { width, height: Math.max(0, y - 16), nodes, edges, lanes };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Pure. The flow map as one HTML page; `src` gives each screen's image (a data: URI to render, a relative path in the zip). */
export function flowMapHtml(appName: string, version: Pick<FlowVersion, "n" | "plan">, src: (screenId: string) => string | null, o: { links?: boolean } = {}): string {
  const L = layoutFlowMap(version.plan.screens);
  const lanes = L.lanes.map((l) => `<div class="lane" style="left:${l.x}px;top:${l.y}px;width:${l.w}px;height:${l.h}px"><span>${esc(l.label)}</span></div>`).join("");
  const nodes = L.nodes
    .map((n) => {
      const img = src(n.id);
      const inner = `${img ? `<img src="${esc(img)}" alt="${esc(n.name)}">` : `<div class="missing">Not drawn yet</div>`}<b>${esc(n.name)}</b>`;
      return o.links
        ? `<a class="node" href="prototype.html#${esc(n.id)}" style="left:${n.x}px;top:${n.y}px;width:${n.w}px">${inner}</a>`
        : `<div class="node" style="left:${n.x}px;top:${n.y}px;width:${n.w}px">${inner}</div>`;
    })
    .join("");
  const edges = L.edges.map((e) => `<path d="${e.d}" class="${e.back ? "back" : ""}" marker-end="url(#arrow)"/>`).join("");
  const labels = L.edges.map((e) => `<div class="label" style="left:${e.labelX}px;top:${e.labelY}px">${esc(e.label)}</div>`).join("");
  const W = L.width + 40;
  const H = L.height + 120;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(appName)} — screen flow v${version.n}</title><style>
*{box-sizing:border-box}body{margin:0;background:#f6f5f1;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#1d1d1b}
h1{font-size:22px;margin:24px 20px 0}p.sub{margin:4px 20px 0;color:#6b6a65;font-size:13px}
.map{position:relative;margin:20px;width:${L.width}px;height:${L.height + 40}px}
.lane{position:absolute;border-radius:18px;background:#fff;border:1px solid #e6e4dc}.lane span{position:absolute;left:18px;top:18px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6b6a65;width:110px}
.node{position:absolute;display:flex;flex-direction:column;gap:6px;text-decoration:none;color:inherit}.node img,.node .missing{width:${THUMB.w}px;height:${THUMB.h}px;border-radius:16px;border:1px solid #dcd9cf;object-fit:cover;background:#fff}
.node .missing{display:flex;align-items:center;justify-content:center;font-size:12px;color:#9a988f;background:#f0eee8}.node b{font-size:12px;font-weight:600;line-height:16px}
svg{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}path{fill:none;stroke:#8a877c;stroke-width:1.6}path.back{stroke-dasharray:5 4}
.label{position:absolute;transform:translate(-50%,-50%);background:#f6f5f1;border:1px solid #e0ddd3;border-radius:999px;padding:2px 8px;font-size:11px;white-space:nowrap;color:#44433f}
</style></head><body style="width:${W}px;min-height:${H}px"><h1>${esc(appName)} — screen flow, version ${version.n}</h1><p class="sub">${L.nodes.length} screens · arrows show what the owner taps</p>
<div class="map">${lanes}<svg width="${L.width}" height="${L.height + 40}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8a877c" stroke="none"/></marker></defs>${edges}</svg>${nodes}${labels}</div></body></html>`;
}

/**
 * Pure. A clickable prototype as one standalone page (no scripts): each
 * screen is a section, its hotspots are links to the next screen, and the
 * links without a hotspot are listed under the phone.
 */
export function prototypeHtml(appName: string, version: Pick<FlowVersion, "n" | "plan" | "designs">, src: (screenId: string) => string | null): string {
  const designs = new Map(version.designs.map((d) => [d.screenId, d]));
  const names = new Map(version.plan.screens.map((s) => [s.id, s.name]));
  const first = version.plan.screens.find((s) => s.flow === "onboarding") ?? version.plan.screens[0];
  const sections = version.plan.screens
    .map((s) => {
      const d = designs.get(s.id);
      const img = src(s.id);
      const hot = (d?.hotspots ?? []).map((h) => `<a class="hot" href="#${esc(h.to)}" title="${esc(h.label)} → ${esc(names.get(h.to) ?? h.to)}" style="left:${(h.x * 100).toFixed(2)}%;top:${(h.y * 100).toFixed(2)}%;width:${(h.w * 100).toFixed(2)}%;height:${(h.h * 100).toFixed(2)}%"></a>`).join("");
      const links = s.links.map((l) => `<li><a href="#${esc(l.to)}">${esc(l.label)} → ${esc(names.get(l.to) ?? l.to)}</a></li>`).join("");
      return `<section id="${esc(s.id)}"><h2>${esc(s.name)}</h2><p>${esc(s.purpose)}</p><div class="phone"><div class="screen">${img ? `<img src="${esc(img)}" alt="${esc(s.name)}">` : "<div class=missing>Not drawn yet</div>"}${hot}</div></div><ul>${links}</ul><a class="map" href="index.html">All screens</a></section>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(appName)} — prototype v${version.n}</title><style>
body{margin:0;background:#ecebe6;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#1d1d1b}section{display:none;flex-direction:column;align-items:center;padding:24px 16px}section:target{display:flex}
${first ? `body:not(:has(section:target)) #${first.id}{display:flex}` : ""}
h2{margin:0;font-size:20px}p{margin:4px 0 16px;color:#6b6a65;font-size:14px;max-width:420px;text-align:center}
.phone{background:#111;padding:14px;border-radius:56px;box-shadow:0 20px 60px rgba(0,0,0,.25)}.screen{position:relative;width:390px;height:844px;border-radius:44px;overflow:hidden;background:#fff}.screen img{width:100%;height:100%;display:block}
.missing{display:flex;height:100%;align-items:center;justify-content:center;color:#999}.hot{position:absolute;border-radius:10px}.hot:hover{background:rgba(255,90,31,.18);outline:2px solid rgba(255,90,31,.6)}
ul{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:16px 0 8px}ul a{display:inline-block;padding:6px 12px;border-radius:999px;background:#fff;color:inherit;text-decoration:none;font-size:13px}a.map{font-size:13px;color:#6b6a65}
</style></head><body>${sections}</body></html>`;
}
