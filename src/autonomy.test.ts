import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AUTONOMY_CONFIG, evaluateAutonomy, recordAutonomyAudit } from "./autonomy";
import type { AutonomyConfig, ChangeForAutonomy } from "./types";

const cleanBugfix: ChangeForAutonomy = {
  sourceId: "test-1",
  filesChanged: ["src/routes/index.tsx"],
  isBugfix: true,
  verifierApproved: true,
  ciPassed: true,
};

describe("evaluateAutonomy", () => {
  test("default config (L2) never auto-ships, even for a clean bugfix", () => {
    const decision = evaluateAutonomy(cleanBugfix, DEFAULT_AUTONOMY_CONFIG);
    expect(decision.autoShip).toBe(false);
    expect(decision.level).toBe("L2");
  });

  test("clean bugfix in an L3 area auto-ships", () => {
    const config: AutonomyConfig = {
      defaultLevel: "L2",
      areas: [{ area: "ui", pathGlobs: ["src/routes/*"], level: "L3" }],
    };
    const decision = evaluateAutonomy(cleanBugfix, config);
    expect(decision.autoShip).toBe(true);
    expect(decision.level).toBe("L3");
    expect(decision.area).toBe("ui");
  });

  test("a bugfix touching a payments file never auto-ships, even at L3+", () => {
    const config: AutonomyConfig = {
      defaultLevel: "L5",
      areas: [],
    };
    const decision = evaluateAutonomy(
      { ...cleanBugfix, filesChanged: ["src/lib/payments.ts"] },
      config,
    );
    expect(decision.autoShip).toBe(false);
    expect(decision.reason).toMatch(/sensitive path/);
  });

  test("mixed change (ui + billing files) uses the most restrictive level", () => {
    const config: AutonomyConfig = {
      defaultLevel: "L2",
      areas: [
        { area: "ui", pathGlobs: ["src/routes/*"], level: "L4" },
        { area: "billing-flow", pathGlobs: ["src/flows/checkout.tsx"], level: "L1" },
      ],
    };
    // Note: "billing-flow" here isn't matched by the sensitive-path regex (no
    // "billing"/"payment"/etc in the path), so this exercises the per-area
    // level restriction specifically, not the hard-coded sensitive override.
    const decision = evaluateAutonomy(
      { ...cleanBugfix, filesChanged: ["src/routes/index.tsx", "src/flows/checkout.tsx"] },
      config,
    );
    expect(decision.level).toBe("L1");
    expect(decision.autoShip).toBe(false);
  });

  test("new feature (not a bugfix) never auto-ships even at L3+", () => {
    const config: AutonomyConfig = { defaultLevel: "L4", areas: [] };
    const decision = evaluateAutonomy({ ...cleanBugfix, isBugfix: false }, config);
    expect(decision.autoShip).toBe(false);
    expect(decision.reason).toMatch(/bug fix/);
  });

  test("unapproved or CI-failing changes never auto-ship even at L3+", () => {
    const config: AutonomyConfig = { defaultLevel: "L3", areas: [] };
    expect(evaluateAutonomy({ ...cleanBugfix, verifierApproved: false }, config).autoShip).toBe(
      false,
    );
    expect(evaluateAutonomy({ ...cleanBugfix, ciPassed: false }, config).autoShip).toBe(false);
  });
});

describe("recordAutonomyAudit", () => {
  test("appends a JSON-line entry per call", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-audit-"));
    const auditFile = join(dir, "audit.jsonl");
    try {
      const decision = evaluateAutonomy(cleanBugfix, DEFAULT_AUTONOMY_CONFIG);
      recordAutonomyAudit(auditFile, cleanBugfix, decision);
      recordAutonomyAudit(auditFile, cleanBugfix, decision);

      expect(existsSync(auditFile)).toBe(true);
      const lines = readFileSync(auditFile, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.sourceId).toBe("test-1");
      expect(parsed.autoShip).toBe(false);
      expect(typeof parsed.timestamp).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
