import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flowDir } from "./plan";
import { runCmd, tail } from "./run-cmd";
import type { DevicePlatform, PlatformRun } from "./types";

/**
 * Device checks in the cloud (deployed day2, DAY2_DEVICE_CHECKS=eas): the
 * change is uploaded to EAS as a workflow — a simulator build for iOS and an
 * APK for Android, then the app's Maestro flows on EAS's own simulator and
 * emulator. Uses the app owner's Expo account (connected on the Releases
 * page) and their EAS build minutes. Results are pass/fail per platform with
 * a link to the run on expo.dev (screenshots stay there).
 *
 * Built against eas-cli 27.2.0 (`eas workflow:run --wait --json`); not yet
 * verified end to end against a real project.
 */

export const EAS_PROFILE = "day2-device-checks";
const WORKFLOW = ".eas/workflows/day2-device-checks.yml";

/** Pure. The workflow file: build per platform, then Maestro on that build. */
export function workflowYaml(platforms: DevicePlatform[], flowPath: string): string {
  const lines = ["name: day2 device checks", "jobs:"];
  for (const p of platforms) {
    lines.push(
      `  build_${p}:`,
      `    name: Build for the ${p === "ios" ? "iOS Simulator" : "Android emulator"}`,
      "    type: build",
      "    params:",
      `      platform: ${p}`,
      `      profile: ${EAS_PROFILE}`,
      `  maestro_${p}:`,
      `    name: Maestro on ${p === "ios" ? "iOS" : "Android"}`,
      `    needs: [build_${p}]`,
      "    type: maestro",
      "    params:",
      `      build_id: \${{ needs.build_${p}.outputs.build_id }}`,
      `      flow_path: ['${flowPath}']`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Pure. eas.json with day2's build profile for simulators/emulators added (the rest unchanged). */
export function withCheckProfile(easJson: string): string {
  const j = JSON.parse(easJson) as { build?: Record<string, unknown> };
  j.build = { ...(j.build ?? {}), [EAS_PROFILE]: { distribution: "internal", ios: { simulator: true }, android: { buildType: "apk" } } };
  return `${JSON.stringify(j, null, 2)}\n`;
}

type RunJson = { id?: string; status?: string; url?: string; logURL?: string; jobs?: Array<{ key?: string; name?: string; status?: string; errors?: Array<{ message?: string }> }> };

/** Pure. Per platform: passed/failed from the run's jobs. */
export function runsFromJson(j: RunJson, platforms: DevicePlatform[], seconds: number): PlatformRun[] {
  return platforms.map((p) => {
    const jobs = (j.jobs ?? []).filter((x) => (x.key ?? x.name ?? "").toLowerCase().includes(p));
    const failed = jobs.filter((x) => /fail|error|cancel/i.test(x.status ?? ""));
    const ok = jobs.length > 0 && jobs.every((x) => /success|finished|completed/i.test(x.status ?? ""));
    const failures = failed.map((x) => `${x.name ?? x.key}: ${x.errors?.[0]?.message ?? x.status}`);
    return {
      platform: p,
      device: p === "ios" ? "EAS iOS Simulator" : "EAS Android emulator",
      status: ok ? "passed" : failures.length || /fail|error/i.test(j.status ?? "") ? "failed" : "skipped",
      why: ok ? null : (failures[0] ?? `the run ended as ${j.status ?? "unknown"}`),
      failures,
      flows: true,
      shots: [],
      seconds,
    };
  });
}

export async function runEasChecks(i: { cwd: string; expoToken: string | null; log?: (t: string) => void }): Promise<{ runs: PlatformRun[]; link: string | null; note: string | null }> {
  const platforms: DevicePlatform[] = ["ios", "android"];
  const skip = (why: string) => ({ runs: platforms.map((p): PlatformRun => ({ platform: p, device: "", status: "skipped", why, failures: [], flows: false, shots: [] , seconds: 0 })), link: null, note: why });
  if (!i.expoToken) return skip("connect the app's Expo account on Connect your stores for device checks in the cloud");
  const flows = flowDir(i.cwd);
  if (!flows) return skip("the app has no Maestro flows yet");
  const easPath = join(i.cwd, "eas.json");
  if (!existsSync(easPath)) return skip("the app has no eas.json");
  writeFileSync(easPath, withCheckProfile(readFileSync(easPath, "utf-8")));
  mkdirSync(join(i.cwd, ".eas", "workflows"), { recursive: true });
  writeFileSync(join(i.cwd, WORKFLOW), workflowYaml(platforms, flows.slice(i.cwd.length + 1)));
  const started = Date.now();
  i.log?.("running the device checks on EAS…");
  const r = await runCmd(["npx", "--yes", "eas-cli@27.2.0", "workflow:run", WORKFLOW, "--wait", "--json", "--non-interactive"], {
    cwd: i.cwd,
    env: { EXPO_TOKEN: i.expoToken, CI: "1", EAS_NO_VCS: "1" },
    timeoutMs: 90 * 60_000,
  });
  let j: RunJson = {};
  try {
    j = JSON.parse(r.out) as RunJson;
  } catch {
    // Not JSON: the run didn't start.
  }
  if (!j.id) return skip(r.timedOut ? "the EAS run took longer than 90 minutes" : `the EAS run didn't start: ${tail(r.err || r.out, 3)}`);
  return { runs: runsFromJson(j, platforms, Math.round((Date.now() - started) / 1000)), link: j.url ?? j.logURL ?? null, note: null };
}
