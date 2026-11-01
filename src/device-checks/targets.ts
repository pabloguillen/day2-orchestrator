import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { has, runCmd, tail } from "./run-cmd";
import type { DevicePlatform } from "./types";

/**
 * One virtual device on this computer: boot it, build the app for it (a
 * release build, JavaScript bundled in, so no dev server is needed), install,
 * launch, screenshot, and tell whether the app is still running.
 */
export type Target = {
  platform: DevicePlatform;
  /** "iPhone 16 Pro (iOS 18.2)". */
  device: string;
  /** What Maestro's --device takes. */
  id: string;
  build(dir: string, env: Record<string, string>): Promise<{ app: string } | { error: string }>;
  install(app: string): Promise<void>;
  uninstall(): Promise<void>;
  launch(): Promise<void>;
  screenshot(file: string): Promise<boolean>;
  running(): Promise<boolean>;
  /** Crash reports written since a time (iOS: DiagnosticReports; Android: logcat's crash buffer). */
  crashesSince(since: Date): Promise<string[]>;
};

const BUILD_TIMEOUT = 40 * 60_000;

function newest(paths: string[]): string | null {
  return paths.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

function findDirs(root: string, match: (p: string, name: string) => boolean, depth = 6): string[] {
  const out: string[] = [];
  const walk = (d: string, n: number) => {
    if (n > depth || !existsSync(d)) return;
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(d, e.name);
      if (match(p, e.name)) out.push(p);
      else if (!e.name.endsWith(".app")) walk(p, n + 1);
    }
  };
  walk(root, 0);
  return out;
}

// ---------------------------------------------------------------------------
// iPhone Simulator (Xcode)
// ---------------------------------------------------------------------------

type SimDevice = { udid: string; name: string; state: string; isAvailable?: boolean };

/** Pure. The iPhone to use: a booted one, else the first iPhone on the newest iOS runtime. */
export function pickSimulator(list: { devices: Record<string, SimDevice[]> }): { udid: string; name: string; runtime: string; booted: boolean } | null {
  const runtimes = Object.keys(list.devices)
    .filter((r) => /iOS/.test(r))
    .sort((a, b) => {
      const v = (r: string) => (r.match(/iOS[-.](\d+)[-.](\d+)/) ?? []).slice(1).map(Number);
      const [a1 = 0, a2 = 0] = v(a);
      const [b1 = 0, b2 = 0] = v(b);
      return b1 - a1 || b2 - a2;
    });
  const label = (r: string) => {
    const m = r.match(/iOS[-.](\d+)[-.](\d+)/);
    return m ? `iOS ${m[1]}.${m[2]}` : "iOS";
  };
  for (const r of runtimes) for (const d of list.devices[r]!) if (d.state === "Booted" && d.name.startsWith("iPhone") && d.isAvailable !== false) return { udid: d.udid, name: d.name, runtime: label(r), booted: true };
  for (const r of runtimes) {
    const d = list.devices[r]!.find((x) => x.name.startsWith("iPhone") && x.isAvailable !== false);
    if (d) return { udid: d.udid, name: d.name, runtime: label(r), booted: false };
  }
  return null;
}

export async function iosTarget(bundleId: string, appName: string): Promise<Target | { skip: string }> {
  if (process.platform !== "darwin") return { skip: "the iPhone Simulator needs a Mac" };
  if (!has("xcrun")) return { skip: "Xcode isn't installed" };
  const list = await runCmd(["xcrun", "simctl", "list", "devices", "available", "-j"], { timeoutMs: 60_000 });
  if (list.code !== 0) return { skip: `the simulator list didn't load (${tail(list.err, 2)})` };
  const sim = pickSimulator(JSON.parse(list.out) as { devices: Record<string, SimDevice[]> });
  if (!sim) return { skip: "no iPhone simulator is installed (Xcode → Settings → Platforms)" };
  if (!sim.booted) {
    await runCmd(["xcrun", "simctl", "boot", sim.udid], { timeoutMs: 120_000 });
    await runCmd(["xcrun", "simctl", "bootstatus", sim.udid, "-b"], { timeoutMs: 300_000 });
  }
  const udid = sim.udid;
  return {
    platform: "ios",
    device: `${sim.name} (${sim.runtime})`,
    id: udid,
    async build(dir, env) {
      const started = Date.now();
      const r = await runCmd(["npx", "expo", "run:ios", "--configuration", "Release", "--no-bundler", "--device", udid], { cwd: dir, env: { ...env, CI: "1", EXPO_NO_TELEMETRY: "1" }, timeoutMs: BUILD_TIMEOUT });
      if (r.code !== 0) return { error: r.timedOut ? "the iOS build took longer than 40 minutes" : `the iOS build failed: ${tail(r.out + r.err)}` };
      const fresh = (p: string) => statSync(p).mtimeMs >= started - 60_000;
      const isApp = (p: string, n: string) => n.endsWith(".app") && /Release-iphonesimulator/.test(p);
      const app = newest([...findDirs(join(dir, "ios", "build"), isApp), ...findDirs(join(homedir(), "Library", "Developer", "Xcode", "DerivedData"), isApp, 7)].filter(fresh));
      return app ? { app } : { error: "the iOS build finished but day2 couldn't find the app it built" };
    },
    async install(app) {
      await runCmd(["xcrun", "simctl", "install", udid, app], { timeoutMs: 180_000 });
    },
    async uninstall() {
      await runCmd(["xcrun", "simctl", "terminate", udid, bundleId], { timeoutMs: 30_000 });
      await runCmd(["xcrun", "simctl", "uninstall", udid, bundleId], { timeoutMs: 60_000 });
    },
    async launch() {
      await runCmd(["xcrun", "simctl", "launch", udid, bundleId], { timeoutMs: 60_000 });
    },
    async screenshot(file) {
      return (await runCmd(["xcrun", "simctl", "io", udid, "screenshot", file], { timeoutMs: 60_000 })).code === 0;
    },
    async running() {
      const r = await runCmd(["xcrun", "simctl", "spawn", udid, "launchctl", "list"], { timeoutMs: 30_000 });
      return r.out.includes(`UIKitApplication:${bundleId}`);
    },
    async crashesSince(since) {
      const dir = join(homedir(), "Library", "Logs", "DiagnosticReports");
      if (!existsSync(dir)) return [];
      const exe = appName.replace(/[^A-Za-z0-9]/g, "");
      return readdirSync(dir)
        .filter((f) => /\.(ips|crash)$/.test(f) && (f.startsWith(appName) || f.startsWith(exe)) && statSync(join(dir, f)).mtimeMs >= since.getTime())
        .map((f) => {
          const text = readFileSync(join(dir, f), "utf-8");
          const reason = text.match(/"exception"\s*:\s*\{[^}]*"type"\s*:\s*"([^"]+)"/)?.[1] ?? text.match(/Exception Type:\s*(.+)/)?.[1] ?? "crash";
          return `the app crashed (${reason.trim()}; report ${f})`;
        });
    },
  };
}

// ---------------------------------------------------------------------------
// Android emulator (Android Studio)
// ---------------------------------------------------------------------------

/** Pure. The first emulator that's running ("emulator-5554"). */
export function runningEmulator(adbDevices: string): string | null {
  return adbDevices.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[0]?.startsWith("emulator-") && p[1] === "device")?.[0] ?? null;
}

export async function androidTarget(packageName: string): Promise<Target | { skip: string }> {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), "Library", "Android", "sdk");
  const adb = has("adb") ? "adb" : existsSync(join(sdk, "platform-tools", "adb")) ? join(sdk, "platform-tools", "adb") : null;
  const emulator = has("emulator") ? "emulator" : existsSync(join(sdk, "emulator", "emulator")) ? join(sdk, "emulator", "emulator") : null;
  if (!adb || !emulator) return { skip: "Android Studio's emulator isn't installed" };
  let serial = runningEmulator((await runCmd([adb, "devices"], { timeoutMs: 30_000 })).out);
  if (!serial) {
    const avds = (await runCmd([emulator, "-list-avds"], { timeoutMs: 30_000 })).out.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!avds.length) return { skip: "no Android virtual device is set up (Android Studio → Device Manager)" };
    Bun.spawn([emulator, "-avd", avds[0]!, "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save"], { stdout: "ignore", stderr: "ignore" }).unref();
    await runCmd([adb, "wait-for-device"], { timeoutMs: 300_000 });
    for (let i = 0; i < 90; i++) {
      if ((await runCmd([adb, "shell", "getprop", "sys.boot_completed"], { timeoutMs: 15_000 })).out.trim() === "1") break;
      await Bun.sleep(3000);
    }
    serial = runningEmulator((await runCmd([adb, "devices"], { timeoutMs: 30_000 })).out);
    if (!serial) return { skip: "the Android emulator didn't start" };
  }
  const s = serial;
  const model = (await runCmd([adb, "-s", s, "emu", "avd", "name"], { timeoutMs: 15_000 })).out.split("\n")[0]?.trim() || s;
  const shell = (...a: string[]) => runCmd([adb, "-s", s, ...a], { timeoutMs: 120_000 });
  return {
    platform: "android",
    device: model,
    id: s,
    async build(dir, env) {
      const r = await runCmd(["npx", "expo", "run:android", "--variant", "release", "--no-bundler", "--device", s], { cwd: dir, env: { ...env, CI: "1", EXPO_NO_TELEMETRY: "1" }, timeoutMs: BUILD_TIMEOUT });
      if (r.code !== 0) return { error: r.timedOut ? "the Android build took longer than 40 minutes" : `the Android build failed: ${tail(r.out + r.err)}` };
      const out = join(dir, "android", "app", "build", "outputs", "apk", "release");
      const apk = existsSync(out) ? newest(readdirSync(out).filter((f) => f.endsWith(".apk")).map((f) => join(out, f))) : null;
      return apk ? { app: apk } : { error: "the Android build finished but day2 couldn't find the APK" };
    },
    async install(app) {
      await shell("install", "-r", app);
    },
    async uninstall() {
      await shell("uninstall", packageName);
    },
    async launch() {
      await shell("shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1");
    },
    async screenshot(file) {
      const r = Bun.spawnSync([adb, "-s", s, "exec-out", "screencap", "-p"]);
      if (r.exitCode !== 0 || !r.stdout.length) return false;
      await Bun.write(file, r.stdout);
      return true;
    },
    async running() {
      return (await shell("shell", "pidof", packageName)).out.trim().length > 0;
    },
    async crashesSince(since) {
      const r = await shell("logcat", "-d", "-b", "crash", "-T", `${Math.floor(since.getTime() / 1000)}.0`);
      const lines = r.out.split("\n").filter((l) => l.includes(packageName) || /FATAL EXCEPTION/.test(l));
      return lines.length ? [`the app crashed (${lines.find((l) => /Exception|Error/.test(l))?.trim().slice(0, 200) ?? "FATAL EXCEPTION"})`] : [];
    },
  };
}

/** Keeps a built app for reuse (the "before" build of a commit is the same for every change on top of it). */
export function cacheApp(app: string, dest: string): string {
  mkdirSync(join(dest, ".."), { recursive: true });
  cpSync(app, dest, { recursive: true });
  return dest;
}
