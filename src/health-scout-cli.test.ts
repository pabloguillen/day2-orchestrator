import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Diagnosis } from "./diagnosis";
import { gatherSignalsForApp, loadAppConfigs } from "./health-scout-cli";

function diagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    id: "app-one:cohort-a:D6:2026-10-01T00:00:00.000Z",
    appId: "app-one",
    cohortKey: "cohort-a",
    ruleId: "D6",
    primary: true,
    evidence: [{ metric: "error_rate", value: 0.08, baseline: 0.02, n: 150, ci: null }],
    route: "healing",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("loadAppConfigs", () => {
  test("single-app convenience flags produce a one-element config", () => {
    const configs = loadAppConfigs({
      apps: undefined,
      appId: "app-one",
      repoPath: "/tmp/app-one",
      appBaseUrl: "https://app-one.example.com",
      sentryOrg: "org",
      sentryProject: "proj",
      diagnoses: undefined,
      dryRun: false,
    });
    expect(configs).toEqual([
      { id: "app-one", repoPath: "/tmp/app-one", appBaseUrl: "https://app-one.example.com", sentryOrg: "org", sentryProject: "proj" },
    ]);
  });

  test("--apps loads a real multi-app JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-scout-"));
    try {
      const path = join(dir, "apps.json");
      writeFileSync(
        path,
        JSON.stringify([
          { id: "app-one", appBaseUrl: "https://a.example.com" },
          { id: "app-two", appBaseUrl: "https://b.example.com", sentryOrg: "org", sentryProject: "p2" },
        ]),
      );
      const configs = loadAppConfigs({
        apps: path,
        appId: undefined,
        repoPath: undefined,
        appBaseUrl: undefined,
        sentryOrg: undefined,
        sentryProject: undefined,
        diagnoses: undefined,
        dryRun: false,
      });
      expect(configs).toHaveLength(2);
      expect(configs[0]!.id).toBe("app-one");
      expect(configs[1]!.id).toBe("app-two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a malformed --apps file (not a JSON array) throws rather than silently scanning nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-scout-"));
    try {
      const path = join(dir, "apps.json");
      writeFileSync(path, JSON.stringify({ not: "an array" }));
      expect(() =>
        loadAppConfigs({
          apps: path,
          appId: undefined,
          repoPath: undefined,
          appBaseUrl: undefined,
          sentryOrg: undefined,
          sentryProject: undefined,
          diagnoses: undefined,
          dryRun: false,
        }),
      ).toThrow("must contain a JSON array");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no --apps and no --app-id produces an empty list (caller prints usage)", () => {
    const configs = loadAppConfigs({
      apps: undefined,
      appId: undefined,
      repoPath: undefined,
      appBaseUrl: undefined,
      sentryOrg: undefined,
      sentryProject: undefined,
      diagnoses: undefined,
      dryRun: false,
    });
    expect(configs).toEqual([]);
  });

  test("--apps with an inline `diagnoses` field carries the real Diagnosis[] through untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-scout-"));
    try {
      const path = join(dir, "apps.json");
      writeFileSync(path, JSON.stringify([{ id: "app-one", diagnoses: [diagnosis()] }]));
      const configs = loadAppConfigs({
        apps: path,
        appId: undefined,
        repoPath: undefined,
        appBaseUrl: undefined,
        sentryOrg: undefined,
        sentryProject: undefined,
        diagnoses: undefined,
        dryRun: false,
      });
      expect(configs[0]!.diagnoses).toHaveLength(1);
      expect(configs[0]!.diagnoses![0]!.route).toBe("healing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--app-id with --diagnoses loads this one app's Diagnosis[] from its own JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-scout-"));
    try {
      const path = join(dir, "diagnoses.json");
      writeFileSync(path, JSON.stringify([diagnosis(), diagnosis({ id: "d-2", route: "creative", ruleId: "D1" })]));
      const configs = loadAppConfigs({
        apps: undefined,
        appId: "app-one",
        repoPath: undefined,
        appBaseUrl: undefined,
        sentryOrg: undefined,
        sentryProject: undefined,
        diagnoses: path,
        dryRun: false,
      });
      expect(configs).toHaveLength(1);
      expect(configs[0]!.diagnoses).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--app-id with no --diagnoses leaves the field unset entirely (not even undefined)", () => {
    const configs = loadAppConfigs({
      apps: undefined,
      appId: "app-one",
      repoPath: undefined,
      appBaseUrl: undefined,
      sentryOrg: undefined,
      sentryProject: undefined,
      diagnoses: undefined,
      dryRun: false,
    });
    expect("diagnoses" in configs[0]!).toBe(false);
  });
});

describe("gatherSignalsForApp", () => {
  test("a healing-routed diagnosis is picked up as a real signal, with no appBaseUrl/sentryOrg configured", async () => {
    const signals = await gatherSignalsForApp({ id: "app-one", diagnoses: [diagnosis()] });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.source).toBe("growth-diagnosis");
    expect(signals[0]!.appId).toBe("app-one");
  });

  test("a non-healing-routed diagnosis is not picked up as a signal", async () => {
    const signals = await gatherSignalsForApp({
      id: "app-one",
      diagnoses: [diagnosis({ route: "creative", ruleId: "D1" })],
    });
    expect(signals).toHaveLength(0);
  });

  test("an app with no signal sources configured at all produces no signals", async () => {
    const signals = await gatherSignalsForApp({ id: "app-one" });
    expect(signals).toEqual([]);
  });

  test("a mix of healing and non-healing diagnoses only surfaces the healing one(s)", async () => {
    const signals = await gatherSignalsForApp({
      id: "app-one",
      diagnoses: [diagnosis({ id: "d-healing" }), diagnosis({ id: "d-config", route: "config", ruleId: "D2" })],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.id).toBe("diagnosis-d-healing");
  });
});
