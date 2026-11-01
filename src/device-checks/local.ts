import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { installCommand } from "../mobile-release/git-workdir";
import { flowDir, junitFailures, pairShots, pngsIn } from "./plan";
import { has, runCmd, tail } from "./run-cmd";
import { androidTarget, cacheApp, iosTarget, type Target } from "./targets";
import type { PlatformRun } from "./types";

/**
 * Device checks on this computer (local mode, the owner's Mac): the iPhone
 * Simulator, and the Android emulator when Android Studio is set up. For
 * each: build the app before and after the change (the "before" build is
 * kept per commit), run the Maestro flows — or, without Maestro, launch the
 * app and watch it — and keep every screenshot.
 */

export type LocalInput = {
  appId: string;
  /** The owner's checkout (for its .env: the build needs the same settings the owner's builds get). */
  repoPath: string;
  /** The change, committed. */
  cwd: string;
  /** The commit the change starts from (default branch). */
  baseSha: string;
  /** Where screenshots and the report go. */
  outDir: string;
  cacheDir: string;
  log?: (t: string) => void;
};

/** Pure. KEY=value lines of a .env file (no expansion). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]!] = v;
  }
  return out;
}

function ownerEnv(repoPath: string): Record<string, string> {
  let env: Record<string, string> = {};
  for (const f of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    const p = join(repoPath, f);
    if (existsSync(p)) env = { ...env, ...parseEnv(readFileSync(p, "utf-8")) };
  }
  return env;
}

function appIds(cwd: string): { bundleId: string | null; packageName: string | null; name: string } {
  try {
    const j = JSON.parse(readFileSync(join(cwd, "app.json"), "utf-8")) as { expo?: Record<string, unknown> } & Record<string, unknown>;
    const e = (j.expo ?? j) as { name?: string; ios?: { bundleIdentifier?: string }; android?: { package?: string } };
    return { bundleId: e.ios?.bundleIdentifier ?? null, packageName: e.android?.package ?? null, name: e.name ?? "App" };
  } catch {
    const t = ["app.config.ts", "app.config.js"].map((f) => (existsSync(join(cwd, f)) ? readFileSync(join(cwd, f), "utf-8") : "")).join("\n");
    return { bundleId: t.match(/bundleIdentifier\s*:\s*["']([\w.-]+)["']/)?.[1] ?? null, packageName: t.match(/\bpackage\s*:\s*["']([\w.]+)["']/)?.[1] ?? null, name: t.match(/\bname\s*:\s*["']([^"']+)["']/)?.[1] ?? "App" };
  }
}

async function ensureDeps(dir: string): Promise<string | null> {
  if (existsSync(join(dir, "node_modules"))) return null;
  const r = await runCmd(installCommand(dir), { cwd: dir, env: { CI: "1" }, timeoutMs: 15 * 60_000 });
  return r.code === 0 ? null : `installing the app's dependencies failed: ${tail(r.err || r.out, 3)}`;
}

/** One session on a device: a clean install, then the flows (or launch and watch), then crash reports. */
async function session(t: Target, app: string, flows: string | null, out: string, bundle: string): Promise<{ failures: string[]; flowsRan: boolean }> {
  mkdirSync(out, { recursive: true });
  await t.uninstall();
  await t.install(app);
  const since = new Date();
  const failures: string[] = [];
  let flowsRan = false;
  if (flows && has("maestro")) {
    flowsRan = true;
    const junit = join(out, "junit.xml");
    const base = ["maestro", "--device", t.id, "test", flows, "--format", "junit", "--output", junit];
    let r = await runCmd([...base, "--test-output-dir", join(out, "maestro")], { cwd: out, env: { MAESTRO_CLI_NO_ANALYTICS: "1" }, timeoutMs: 20 * 60_000 });
    if (r.code !== 0 && /Unknown option|unrecognized/i.test(r.err)) r = await runCmd(base, { cwd: out, env: { MAESTRO_CLI_NO_ANALYTICS: "1" }, timeoutMs: 20 * 60_000 });
    if (existsSync(junit)) failures.push(...junitFailures(readFileSync(junit, "utf-8")));
    if (r.code !== 0 && !failures.length) failures.push(r.timedOut ? "the flows took longer than 20 minutes" : `the flows failed: ${tail(r.out + r.err, 4)}`);
  } else {
    // No flows (or no Maestro): start the app and watch it for 15 seconds.
    await t.launch();
    await Bun.sleep(8000);
    await t.screenshot(join(out, "01-start.png"));
    if (!(await t.running())) failures.push(`the app closed within 8 seconds of starting (${bundle})`);
    else {
      await Bun.sleep(7000);
      await t.screenshot(join(out, "02-after-15s.png"));
      if (!(await t.running())) failures.push("the app closed within 15 seconds of starting");
    }
  }
  failures.push(...(await t.crashesSince(since)));
  return { failures: [...new Set(failures)], flowsRan };
}

export async function runLocalChecks(i: LocalInput): Promise<PlatformRun[]> {
  const log = i.log ?? (() => {});
  const ids = appIds(i.cwd);
  const env = ownerEnv(i.repoPath);
  const runs: PlatformRun[] = [];
  const depErr = await ensureDeps(i.cwd);
  const targets: Array<Promise<Target | { skip: string }>> = [];
  targets.push(ids.bundleId ? iosTarget(ids.bundleId, ids.name) : Promise.resolve({ skip: "the app config has no iOS bundle identifier" }));
  targets.push(ids.packageName ? androidTarget(ids.packageName) : Promise.resolve({ skip: "the app config has no Android package" }));
  let baseDir: string | null = null;
  try {
    for (const [n, p] of targets.entries()) {
      const platform = n === 0 ? "ios" : "android";
      const started = Date.now();
      const t = await p;
      const done = (r: Omit<PlatformRun, "platform" | "seconds">) => runs.push({ platform, seconds: Math.round((Date.now() - started) / 1000), ...r });
      if ("skip" in t) {
        done({ device: "", status: "skipped", why: t.skip, failures: [], flows: false, shots: [] });
        continue;
      }
      if (depErr) {
        done({ device: t.device, status: "failed", why: depErr, failures: [depErr], flows: false, shots: [] });
        continue;
      }
      log(`${t.device}: building the change…`);
      const after = await t.build(i.cwd, env);
      if ("error" in after) {
        done({ device: t.device, status: "failed", why: after.error, failures: [after.error], flows: false, shots: [] });
        continue;
      }
      const afterApp = cacheApp(after.app, join(i.cacheDir, `${platform}-change-${Date.now()}${platform === "ios" ? ".app" : ".apk"}`));
      // Before: the build of the starting commit, kept per commit.
      const cached = join(i.cacheDir, `${platform}-${i.baseSha}${platform === "ios" ? ".app" : ".apk"}`);
      let beforeApp: string | null = existsSync(cached) ? cached : null;
      if (!beforeApp) {
        if (!baseDir) {
          baseDir = join(tmpdir(), `day2-base-${i.baseSha.slice(0, 12)}-${Date.now()}`);
          await runCmd(["git", "-C", i.cwd, "worktree", "add", "--detach", baseDir, i.baseSha], { timeoutMs: 120_000 });
          await ensureDeps(baseDir);
        }
        log(`${t.device}: building the app before the change…`);
        const b = await t.build(baseDir, env);
        beforeApp = "error" in b ? null : cacheApp(b.app, cached);
      }
      const flows = flowDir(i.cwd);
      const shotDir = join(i.outDir, platform);
      let beforeShots: string[] = [];
      if (beforeApp) {
        // The old app with the same flows: what it looked like (new screens may not exist there — that's fine).
        await session(t, beforeApp, flows, join(shotDir, "before-run"), ids.bundleId ?? ids.packageName ?? "");
        beforeShots = pngsIn(join(shotDir, "before-run"));
      }
      log(`${t.device}: running the change…`);
      const res = await session(t, afterApp, flows, join(shotDir, "after-run"), ids.bundleId ?? ids.packageName ?? "");
      const afterShots = pngsIn(join(shotDir, "after-run"));
      // Keep them under stable names next to the report.
      const keep = (p: string | null, side: "before" | "after") => {
        if (!p) return null;
        const dest = join(shotDir, side, `${p.split("/").pop()}`);
        mkdirSync(join(shotDir, side), { recursive: true });
        copyFileSync(p, dest);
        return relative(i.outDir, dest);
      };
      const shots = pairShots(beforeShots, afterShots).map((s) => ({ name: s.name, before: keep(s.before, "before"), after: keep(s.after, "after") }));
      rmSync(join(shotDir, "before-run"), { recursive: true, force: true });
      rmSync(join(shotDir, "after-run"), { recursive: true, force: true });
      rmSync(afterApp, { recursive: true, force: true });
      done({
        device: t.device,
        status: res.failures.length ? "failed" : "passed",
        why: res.failures[0] ?? (beforeApp ? null : "no before screenshots: the app before the change didn't build"),
        failures: res.failures,
        flows: res.flowsRan,
        shots,
      });
    }
  } finally {
    if (baseDir) {
      await runCmd(["git", "-C", i.cwd, "worktree", "remove", "--force", baseDir], { timeoutMs: 60_000 });
      rmSync(baseDir, { recursive: true, force: true });
    }
  }
  return runs;
}
