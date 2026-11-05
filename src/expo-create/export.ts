import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zip, type ZipEntry } from "../zip";
import { flowMapHtml, prototypeHtml } from "./flow-map";
import type { ExpoBuild, FlowVersion } from "./types";

/**
 * "Open in Claude Design / Figma": the screen flow as a zip of standalone
 * files the owner can import into Claude Design or other design tools —
 * one HTML page and one PNG per screen, the style card, the flow map
 * (linked to a clickable prototype), and the data behind them. Claude
 * Design has no API; this is a download, nothing is sent anywhere.
 */

export function exportEntries(b: Pick<ExpoBuild, "request">, v: FlowVersion, flowDir: string): ZipEntry[] {
  const read = (name: string | undefined) => (name && existsSync(join(flowDir, name)) ? new Uint8Array(readFileSync(join(flowDir, name))) : null);
  const entries: ZipEntry[] = [];
  const pngOf = new Map<string, string>();
  for (const d of v.designs) {
    const png = read(d.png);
    if (png) {
      entries.push({ path: `screens/${d.screenId}.png`, data: png });
      pngOf.set(d.screenId, `screens/${d.screenId}.png`);
    }
    const html = read(d.html);
    if (html) entries.push({ path: `screens/${d.screenId}.html`, data: html });
    const ap = read(d.androidPng);
    if (ap) entries.push({ path: `screens/${d.screenId}.android.png`, data: ap });
    const ah = read(d.androidHtml);
    if (ah) entries.push({ path: `screens/${d.screenId}.android.html`, data: ah });
  }
  const style = read(v.style.png);
  if (style) entries.push({ path: "style.png", data: style });
  const styleHtml = read(v.style.html);
  if (styleHtml) entries.push({ path: "style.html", data: styleHtml });
  const map = read(v.map?.png);
  if (map) entries.push({ path: "flow-map.png", data: map });
  const name = b.request.displayName;
  entries.push({ path: "index.html", data: flowMapHtml(name, v, (id) => pngOf.get(id) ?? null, { links: true }) });
  entries.push({ path: "prototype.html", data: prototypeHtml(name, v, (id) => pngOf.get(id) ?? null) });
  const designs = new Map(v.designs.map((d) => [d.screenId, d]));
  entries.push({ path: "flow.json", data: `${JSON.stringify({ app: name, version: v.n, screens: v.plan.screens.map((s) => ({ ...s, hotspots: designs.get(s.id)?.hotspots ?? [] })) }, null, 2)}\n` });
  entries.push({ path: "design-system.json", data: `${JSON.stringify(v.designSystem, null, 2)}\n` });
  entries.push({
    path: "README.txt",
    data: [
      `${name} — screen flow, version ${v.n} (from day2)`,
      "",
      "index.html       all screens as a flow map; click a screen to open the prototype",
      "prototype.html   click through the screens (tap the highlighted areas)",
      "screens/         each screen as a standalone HTML page (390×844, iPhone) and a PNG",
      "style.html/.png  the design system: colors, type, spacing, components",
      "flow.json        every screen, where each button goes, and the tappable areas",
      "",
      "Claude Design: open claude.ai's design canvas and import the screens' HTML files or PNGs",
      "(or start from index.html). Figma: drag the PNGs onto a page, or use an HTML-to-Figma",
      "import plugin with the screens' HTML files.",
      "",
      "Changes you make there don't come back to day2 by themselves: tell day2 what to change",
      "with a comment on the Create page.",
      "",
    ].join("\n"),
  });
  return entries;
}

export function exportZip(b: Pick<ExpoBuild, "request">, v: FlowVersion, flowDir: string): Uint8Array {
  return zip(exportEntries(b, v, flowDir));
}
