import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAutonomyConfig,
  previewArea,
  removeArea,
  renderConfigSummary,
  saveAutonomyConfig,
  setArea,
} from "./autonomy-config";
import type { AutonomyConfig } from "./types";

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "day2-autonomy-config-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadAutonomyConfig", () => {
  test("returns the L2-everywhere default when no file exists", () => {
    withTmpDir((dir) => {
      const config = loadAutonomyConfig(join(dir, ".day2-autonomy.json"));
      expect(config).toEqual({ defaultLevel: "L2", areas: [] });
    });
  });

  test("loads and round-trips a real config file", () => {
    withTmpDir((dir) => {
      const path = join(dir, ".day2-autonomy.json");
      const config: AutonomyConfig = {
        defaultLevel: "L2",
        areas: [{ area: "ui", pathGlobs: ["src/components/**"], level: "L3" }],
      };
      saveAutonomyConfig(path, config);
      expect(existsSync(path)).toBe(true);
      expect(loadAutonomyConfig(path)).toEqual(config);
    });
  });

  test("fails closed on malformed JSON rather than silently ignoring it", () => {
    withTmpDir((dir) => {
      const path = join(dir, ".day2-autonomy.json");
      writeFileSync(path, "{ not valid json");
      expect(() => loadAutonomyConfig(path)).toThrow(/valid JSON/);
    });
  });

  test("fails closed on valid JSON that isn't a valid autonomy config", () => {
    withTmpDir((dir) => {
      const path = join(dir, ".day2-autonomy.json");
      writeFileSync(path, JSON.stringify({ foo: "bar" }));
      expect(() => loadAutonomyConfig(path)).toThrow(/valid autonomy config/);
    });
  });
});

describe("setArea / removeArea", () => {
  test("adds a new area", () => {
    const config: AutonomyConfig = { defaultLevel: "L2", areas: [] };
    const updated = setArea(config, "ui", ["src/components/**"], "L3");
    expect(updated.areas).toEqual([{ area: "ui", pathGlobs: ["src/components/**"], level: "L3" }]);
    // Pure: the original is untouched.
    expect(config.areas).toEqual([]);
  });

  test("replaces an existing area with the same name rather than duplicating it", () => {
    const config: AutonomyConfig = {
      defaultLevel: "L2",
      areas: [{ area: "ui", pathGlobs: ["old/**"], level: "L2" }],
    };
    const updated = setArea(config, "ui", ["new/**"], "L3");
    expect(updated.areas).toHaveLength(1);
    expect(updated.areas[0]).toEqual({ area: "ui", pathGlobs: ["new/**"], level: "L3" });
  });

  test("removeArea reverts an area to the default", () => {
    const config: AutonomyConfig = {
      defaultLevel: "L2",
      areas: [{ area: "ui", pathGlobs: ["src/**"], level: "L3" }],
    };
    expect(removeArea(config, "ui").areas).toEqual([]);
  });
});

describe("previewArea", () => {
  test("an ordinary UI area at L3 genuinely auto-ships", () => {
    const config: AutonomyConfig = {
      defaultLevel: "L2",
      areas: [{ area: "ui", pathGlobs: ["src/components/**"], level: "L3" }],
    };
    const { willAutoShip } = previewArea(config, config.areas[0]);
    expect(willAutoShip).toBe(true);
  });

  test("an area opted into L3 whose glob is also a sensitive path never actually auto-ships", () => {
    const config: AutonomyConfig = {
      defaultLevel: "L2",
      areas: [{ area: "auth-ui", pathGlobs: ["src/auth/**"], level: "L3" }],
    };
    const { willAutoShip, reason } = previewArea(config, config.areas[0]);
    expect(willAutoShip).toBe(false);
    expect(reason).toMatch(/sensitive path/);
  });

  test("an area left at L2 does not auto-ship", () => {
    const config: AutonomyConfig = {
      defaultLevel: "L2",
      areas: [{ area: "ui", pathGlobs: ["src/components/**"], level: "L2" }],
    };
    expect(previewArea(config, config.areas[0]).willAutoShip).toBe(false);
  });
});

describe("renderConfigSummary", () => {
  test("says nothing has opted in when areas is empty", () => {
    const summary = renderConfigSummary({ defaultLevel: "L2", areas: [] });
    expect(summary).toMatch(/No areas have opted in/);
  });

  test("describes a genuinely auto-shipping area in plain language", () => {
    const summary = renderConfigSummary({
      defaultLevel: "L2",
      areas: [{ area: "ui", pathGlobs: ["src/components/**"], level: "L3" }],
    });
    expect(summary).toMatch(/ship automatically/);
    expect(summary).toMatch(/one-tap undo/);
  });

  test("warns rather than silently claims auto-ship for a sensitive-path area", () => {
    const summary = renderConfigSummary({
      defaultLevel: "L2",
      areas: [{ area: "auth-ui", pathGlobs: ["src/auth/**"], level: "L3" }],
    });
    expect(summary).toMatch(/still requires a human/);
  });
});
