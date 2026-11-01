import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runsFromJson, withCheckProfile, workflowYaml, EAS_PROFILE } from "./eas";
import { deviceMode, runDeviceChecks, shotPath } from "./index";
import { parseEnv } from "./local";
import { flowDir, isUiChange, junitFailures, pairShots, summarize } from "./plan";
import { pickSimulator, runningEmulator } from "./targets";

const root = mkdtempSync(join(tmpdir(), "day2-devices-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("what gets checked", () => {
  test("changes users can see: screens, components, assets, app config", () => {
    expect(isUiChange(["src/screens/FeedScreen.tsx"])).toBe(true);
    expect(isUiChange(["App.tsx"])).toBe(true);
    expect(isUiChange(["assets/icon.png"])).toBe(true);
    expect(isUiChange(["app.json"])).toBe(true);
    expect(isUiChange(["website/sitemap.xml", "website/robots.txt"])).toBe(false);
    expect(isUiChange(["supabase/migrations/1.sql", "src/data/api.ts"])).toBe(false);
  });

  test("the app's Maestro flows are found where they usually live", () => {
    const app = join(root, "app");
    mkdirSync(join(app, ".maestro", "day2"), { recursive: true });
    expect(flowDir(app)).toBeNull();
    writeFileSync(join(app, ".maestro", "day2", "smoke.yaml"), "appId: x\n---\n- launchApp");
    expect(flowDir(app)).toBe(join(app, ".maestro"));
  });
});

describe("on the Mac", () => {
  test("a booted iPhone first, else the newest iOS", () => {
    const devices = {
      "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [{ udid: "A", name: "iPhone 15", state: "Shutdown" }],
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
        { udid: "B", name: "iPad Air", state: "Shutdown" },
        { udid: "C", name: "iPhone 16 Pro", state: "Shutdown" },
      ],
      "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [{ udid: "W", name: "Apple Watch", state: "Booted" }],
    };
    expect(pickSimulator({ devices })).toEqual({ udid: "C", name: "iPhone 16 Pro", runtime: "iOS 18.2", booted: false });
    devices["com.apple.CoreSimulator.SimRuntime.iOS-17-5"]![0]!.state = "Booted";
    expect(pickSimulator({ devices })).toMatchObject({ udid: "A", booted: true, runtime: "iOS 17.5" });
    expect(pickSimulator({ devices: {} })).toBeNull();
  });

  test("a running Android emulator", () => {
    expect(runningEmulator("List of devices attached\nemulator-5554\tdevice\n")).toBe("emulator-5554");
    expect(runningEmulator("List of devices attached\nR58N\tdevice\nemulator-5556\toffline\n")).toBeNull();
  });

  test("the owner's .env reaches the build (values as written, comments dropped)", () => {
    expect(parseEnv('EXPO_PUBLIC_SUPABASE_URL=https://x.supabase.co\n# c\nexport EXPO_PUBLIC_KEY="ab#c" \nMAPBOX=tok # note\n')).toEqual({ EXPO_PUBLIC_SUPABASE_URL: "https://x.supabase.co", EXPO_PUBLIC_KEY: "ab#c", MAPBOX: "tok" });
  });

  test("Maestro's report: which flows failed and why", () => {
    const xml = `<testsuites><testsuite name="Test Suite"><testcase id="smoke" name="smoke" classname="smoke"/><testcase id="d2-12" name="d2-12" classname="d2-12"><failure message="Assertion is false: &quot;Leaderboard&quot; is visible">x</failure></testcase></testsuite></testsuites>`;
    expect(junitFailures(xml)).toEqual(['d2-12: Assertion is false: "Leaderboard" is visible']);
  });

  test("before and after paired by step", () => {
    expect(pairShots(["/b/start.png", "/b/map.png"], ["/a/start.png", "/a/leaderboard.png"])).toEqual([
      { name: "start", before: "/b/start.png", after: "/a/start.png" },
      { name: "leaderboard", before: null, after: "/a/leaderboard.png" },
      { name: "map", before: "/b/map.png", after: null },
    ]);
  });

  test("one line for the ticket and the pull request", () => {
    expect(
      summarize({
        mode: "local",
        status: "failed",
        runs: [
          { platform: "ios", device: "iPhone 16 Pro (iOS 18.2)", status: "failed", why: null, failures: ["the app crashed (EXC_BAD_ACCESS; report Dotty.ips)"], flows: true, shots: [], seconds: 1 },
          { platform: "android", device: "", status: "skipped", why: "Android Studio's emulator isn't installed", failures: [], flows: false, shots: [], seconds: 0 },
        ],
      }),
    ).toBe("iPhone Simulator (iPhone 16 Pro (iOS 18.2)): failed — the app crashed (EXC_BAD_ACCESS; report Dotty.ips); Android emulator not checked (Android Studio's emulator isn't installed).");
  });
});

describe("in the cloud (EAS)", () => {
  test("a workflow per platform: build, then Maestro on that build", () => {
    const y = workflowYaml(["ios", "android"], ".maestro");
    expect(y).toContain(`profile: ${EAS_PROFILE}`);
    expect(y).toContain("build_id: ${{ needs.build_ios.outputs.build_id }}");
    expect(y).toContain("needs: [build_android]");
    expect(y).toContain("flow_path: ['.maestro']");
  });

  test("day2's build profile is added; the app's own stay as they are", () => {
    const j = JSON.parse(withCheckProfile(JSON.stringify({ cli: { appVersionSource: "remote" }, build: { production: { autoIncrement: true } } })));
    expect(j.build.production).toEqual({ autoIncrement: true });
    expect(j.build[EAS_PROFILE]).toEqual({ distribution: "internal", ios: { simulator: true }, android: { buildType: "apk" } });
    expect(j.cli).toEqual({ appVersionSource: "remote" });
  });

  test("results per platform from the run's jobs", () => {
    const runs = runsFromJson(
      { id: "w1", status: "FAILURE", jobs: [{ key: "build_ios", status: "SUCCESS" }, { key: "maestro_ios", status: "SUCCESS" }, { key: "build_android", status: "SUCCESS" }, { key: "maestro_android", name: "Maestro on Android", status: "FAILURE", errors: [{ message: "Flow smoke failed" }] }] },
      ["ios", "android"],
      600,
    );
    expect(runs.map((r) => [r.platform, r.status])).toEqual([
      ["ios", "passed"],
      ["android", "failed"],
    ]);
    expect(runs[1]!.failures).toEqual(["Maestro on Android: Flow smoke failed"]);
  });
});

describe("running the checks", () => {
  test("no screens touched, or checks off: nothing runs, the change goes on with a note", async () => {
    const base = { appId: "a", repoPath: root, cwd: root, key: "day2-fix-x" };
    expect(await runDeviceChecks({ ...base, changedFiles: ["website/sitemap.xml"] })).toEqual({ status: "skipped", summary: "No device check needed: the change doesn't touch screens.", key: null });
    process.env.DAY2_DEVICE_CHECKS = "off";
    expect(deviceMode()).toBe("off");
    expect((await runDeviceChecks({ ...base, changedFiles: ["App.tsx"] })).summary).toContain("device checks are off");
    delete process.env.DAY2_DEVICE_CHECKS;
  });

  test("screenshots are only served from inside their report", () => {
    expect(shotPath("a", "k", "../../../etc/passwd.png")).toBeNull();
    expect(shotPath("a", "k", "ios/after/missing.png")).toBeNull();
  });
});
