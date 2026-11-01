import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DeviceReport, PlatformRun, Shot } from "./types";

/** Pure. Whether changed files touch what users see or run (screens, components, assets, native config). */
export function isUiChange(files: string[]): boolean {
  return files.some(
    (f) =>
      /\.(tsx|jsx)$/.test(f) ||
      /^(app|App)\.(tsx|jsx|ts|js)$/.test(basename(f)) ||
      /(^|\/)(assets|src\/(screens|components|navigation|ui|theme))\//.test(f) ||
      /^(app\.json|app\.config\.(ts|js)|eas\.json|package\.json)$/.test(f),
  );
}

/** Where the app's Maestro flows live (day2 writes its own under .maestro/day2/). */
export function flowDir(cwd: string): string | null {
  for (const d of [".maestro", "maestro", "e2e/maestro"]) {
    const p = join(cwd, d);
    if (existsSync(p) && statSync(p).isDirectory() && listFlows(p).length) return p;
  }
  return null;
}

export function listFlows(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (/\.ya?ml$/.test(e.name) && e.name !== "config.yaml") out.push(join(d, e.name));
    }
  };
  walk(dir);
  return out.sort();
}

/** Every .png under a directory (Maestro puts screenshots in its output dir). */
export function pngsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (/\.png$/i.test(e.name)) out.push(join(d, e.name));
    }
  };
  walk(dir);
  return out.sort();
}

/** Pure. Before and after screenshots side by side, by step name (after's order first). */
export function pairShots(before: string[], after: string[]): Shot[] {
  const name = (p: string) => basename(p).replace(/\.png$/i, "");
  const b = new Map(before.map((p) => [name(p), p]));
  const shots: Shot[] = after.map((p) => ({ name: name(p), before: b.get(name(p)) ?? null, after: p }));
  for (const [n, p] of b) if (!after.some((a) => name(a) === n)) shots.push({ name: n, before: p, after: null });
  return shots;
}

/** Pure. Failed test cases from a Maestro JUnit report. */
export function junitFailures(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = m[1]!.match(/\bname="([^"]*)"/)?.[1] ?? "flow";
    const f = (m[2] ?? "").match(/<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/);
    if (!f) continue;
    const attrs = f[2] ?? f[5] ?? "";
    const message = attrs.match(/\bmessage="([^"]*)"/)?.[1] || (f[3] ?? "").trim() || "failed";
    const text = message.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    out.push(`${name}: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  return out;
}

/** Pure. One line for the ticket and the pull request. */
export function summarize(r: Pick<DeviceReport, "status" | "runs" | "mode">): string {
  const name = (p: PlatformRun["platform"]) => (p === "ios" ? "iPhone Simulator" : "Android emulator");
  const ran = r.runs.filter((x) => x.status !== "skipped");
  if (!ran.length) {
    const why = r.runs.map((x) => x.why).filter(Boolean)[0];
    return `Not checked on a device${why ? `: ${why}` : ""}.`;
  }
  const parts = ran.map((x) => `${name(x.platform)} (${x.device}): ${x.status === "passed" ? (x.flows ? "all flows passed" : "started and kept running") : `failed — ${x.failures[0] ?? x.why ?? "see the report"}`}`);
  const skipped = r.runs.filter((x) => x.status === "skipped").map((x) => `${name(x.platform)} not checked (${x.why})`);
  return [...parts, ...skipped].join("; ") + ".";
}
