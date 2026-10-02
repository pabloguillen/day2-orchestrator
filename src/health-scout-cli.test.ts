import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAppConfigs } from "./health-scout-cli";

describe("loadAppConfigs", () => {
  test("single-app convenience flags produce a one-element config", () => {
    const configs = loadAppConfigs({
      apps: undefined,
      appId: "app-one",
      repoPath: "/tmp/app-one",
      appBaseUrl: "https://app-one.example.com",
      sentryOrg: "org",
      sentryProject: "proj",
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
      dryRun: false,
    });
    expect(configs).toEqual([]);
  });
});
