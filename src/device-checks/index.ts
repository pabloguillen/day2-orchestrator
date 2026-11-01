import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { dataDir } from "../day2-paths";
import { runEasChecks } from "./eas";
import { runLocalChecks } from "./local";
import { isUiChange, summarize } from "./plan";
import { has, runCmd } from "./run-cmd";
import type { DeviceReport, DeviceVerdict, PlatformRun } from "./types";

export type { DeviceReport, DeviceVerdict } from "./types";
export { isUiChange } from "./plan";

/**
 * Where device checks run: DAY2_DEVICE_CHECKS = "local" (this computer's
 * simulators — the default on a Mac with Xcode), "eas" (EAS's, for deployed
 * day2), or "off".
 */
export function deviceMode(): "local" | "eas" | "off" {
  const m = process.env.DAY2_DEVICE_CHECKS;
  if (m === "local" || m === "eas" || m === "off") return m;
  return process.platform === "darwin" && has("xcrun") ? "local" : "off";
}

const reportsRoot = () => join(dataDir(), "device-checks");
const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_");
export const reportDir = (appId: string, key: string) => join(reportsRoot(), safe(appId), safe(key));

export function loadDeviceReport(appId: string, key: string): DeviceReport | null {
  const p = join(reportDir(appId, key), "report.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as DeviceReport;
  } catch {
    return null;
  }
}

/** A screenshot of a report, or null when the path leaves the report's folder. */
export function shotPath(appId: string, key: string, rel: string): string | null {
  const dir = reportDir(appId, key);
  const p = normalize(join(dir, rel));
  return p.startsWith(`${dir}/`) && /\.png$/i.test(p) && existsSync(p) ? p : null;
}

/** One device check at a time on this computer (the simulators are shared). */
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

export type DeviceCheckInput = {
  appId: string;
  repoPath: string;
  /** The change, committed, in an isolated checkout. */
  cwd: string;
  /** The report's key — the change's branch. */
  key: string;
  changedFiles: string[];
  expoToken?: () => Promise<string | null>;
  log?: (t: string) => void;
};

/**
 * Runs the app with the change on virtual devices when the change touches
 * what users see. "failed" blocks the pull request; "skipped" (not a UI
 * change, nothing to run on here) lets it through with a note.
 */
export async function runDeviceChecks(i: DeviceCheckInput): Promise<DeviceVerdict> {
  const mode = deviceMode();
  if (!isUiChange(i.changedFiles)) return { status: "skipped", summary: "No device check needed: the change doesn't touch screens.", key: null };
  if (mode === "off") return { status: "skipped", summary: "Not checked on a device: device checks are off on this server (DAY2_DEVICE_CHECKS).", key: null };
  return oneAtATime(async () => {
    const outDir = reportDir(i.appId, i.key);
    mkdirSync(outDir, { recursive: true });
    const notes: string[] = [];
    let runs: PlatformRun[];
    let link: string | null = null;
    if (mode === "local") {
      const base = (await runCmd(["git", "-C", i.cwd, "rev-parse", "HEAD~1"], { timeoutMs: 30_000 })).out.trim();
      runs = await runLocalChecks({ appId: i.appId, repoPath: i.repoPath, cwd: i.cwd, baseSha: base, outDir, cacheDir: join(reportsRoot(), safe(i.appId), ".builds"), log: i.log });
      if (!has("maestro")) notes.push("Maestro isn't installed, so day2 only launched the app and watched it. Install it for full flows: curl -fsSL https://get.maestro.mobile.dev | bash");
    } else {
      const r = await runEasChecks({ cwd: i.cwd, expoToken: (await i.expoToken?.()) ?? null, log: i.log });
      runs = r.runs;
      link = r.link;
      if (r.note) notes.push(r.note);
    }
    const ran = runs.filter((x) => x.status !== "skipped");
    const status: DeviceReport["status"] = ran.some((x) => x.status === "failed") ? "failed" : ran.length ? "passed" : "skipped";
    const report: DeviceReport = { key: i.key, at: new Date().toISOString(), mode, status, summary: summarize({ status, runs, mode }), runs, link, notes };
    writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    return { status, summary: report.summary, key: i.key };
  });
}
