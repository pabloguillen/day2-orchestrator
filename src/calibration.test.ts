import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCalibrationVerdict, recordCalibrationAudit } from "./calibration";
import {
  FALSE_POSITIVE_PATTERNS,
  buildPersonaGuidance,
  buildSkepticChecklist,
  hasApplicablePatterns,
} from "./false-positive-patterns";
import { DEFAULT_PERSONAS } from "./swarm";

const VALID_IDS = ["css-transition-timing", "shadow-dom-active-element"];

describe("parseCalibrationVerdict", () => {
  test("well-formed clear with a valid pattern id and real evidence clears", () => {
    const result = parseCalibrationVerdict(
      "checked the page\nCALIBRATION_VERDICT: FALSE_POSITIVE — pattern: css-transition-timing — waited 200ms, opacity settled to 1",
      false,
      VALID_IDS,
    );
    expect(result.clearedAsFalsePositive).toBe(true);
    expect(result.matchedPatternId).toBe("css-transition-timing");
  });

  test("a hallucinated/typo'd pattern id never clears — the single most important case here", () => {
    const result = parseCalibrationVerdict(
      "CALIBRATION_VERDICT: FALSE_POSITIVE — pattern: some-made-up-pattern — looked fine to me",
      false,
      VALID_IDS,
    );
    expect(result.clearedAsFalsePositive).toBe(false);
    expect(result.matchedPatternId).toBeNull();
  });

  test("CONFIRMED_REAL never clears", () => {
    const result = parseCalibrationVerdict(
      "CALIBRATION_VERDICT: CONFIRMED_REAL — reproduced the missing focus indicator directly",
      false,
      VALID_IDS,
    );
    expect(result.clearedAsFalsePositive).toBe(false);
  });

  test("INCONCLUSIVE never clears", () => {
    const result = parseCalibrationVerdict(
      "CALIBRATION_VERDICT: INCONCLUSIVE — couldn't reproduce either way",
      false,
      VALID_IDS,
    );
    expect(result.clearedAsFalsePositive).toBe(false);
  });

  test("isError wins even over an otherwise well-formed clear", () => {
    const result = parseCalibrationVerdict(
      "CALIBRATION_VERDICT: FALSE_POSITIVE — pattern: css-transition-timing — waited and confirmed",
      true,
      VALID_IDS,
    );
    expect(result.clearedAsFalsePositive).toBe(false);
  });

  test("no verdict line at all fails closed", () => {
    const result = parseCalibrationVerdict("the agent just rambled without concluding anything", false, VALID_IDS);
    expect(result.clearedAsFalsePositive).toBe(false);
  });

  test("empty transcript fails closed", () => {
    const result = parseCalibrationVerdict("", false, VALID_IDS);
    expect(result.clearedAsFalsePositive).toBe(false);
    expect(result.summary).toBeTruthy();
  });

  test("an empty evidence clause fails closed — a bare clear with nothing behind it isn't trustworthy", () => {
    const result = parseCalibrationVerdict(
      "CALIBRATION_VERDICT: FALSE_POSITIVE — pattern: css-transition-timing — ",
      false,
      VALID_IDS,
    );
    expect(result.clearedAsFalsePositive).toBe(false);
  });

  test("only the first CALIBRATION_VERDICT line is used, ignoring stray later mentions", () => {
    const result = parseCalibrationVerdict(
      "CALIBRATION_VERDICT: CONFIRMED_REAL — first verdict\nsome more rambling\nCALIBRATION_VERDICT: FALSE_POSITIVE — pattern: css-transition-timing — second one shouldn't count",
      false,
      VALID_IDS,
    );
    expect(result.clearedAsFalsePositive).toBe(false);
  });
});

describe("false-positive-patterns.ts", () => {
  test("every pattern's personas reference a real base persona name", () => {
    const realBaseNames = new Set(
      DEFAULT_PERSONAS.map((p) => p.name.replace(/-desktop$/, "").replace(/-mobile$/, "")),
    );
    for (const pattern of FALSE_POSITIVE_PATTERNS) {
      for (const persona of pattern.personas) {
        expect(realBaseNames.has(persona)).toBe(true);
      }
    }
  });

  test("no two patterns share an id", () => {
    const ids = FALSE_POSITIVE_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("buildPersonaGuidance for accessibility-auditor contains the known guidance keywords", () => {
    const guidance = buildPersonaGuidance("accessibility-auditor");
    expect(guidance).toMatch(/transition/i);
    expect(guidance).toMatch(/shadowRoot/);
    expect(guidance).toMatch(/activeElement/);
    expect(guidance).toMatch(/getComputedStyle/);
    expect(guidance).toMatch(/screenshot/i);
  });

  test("buildSkepticChecklist includes every applicable pattern's id verbatim", () => {
    const checklist = buildSkepticChecklist("accessibility-auditor");
    for (const pattern of FALSE_POSITIVE_PATTERNS.filter((p) => p.personas.includes("accessibility-auditor"))) {
      expect(checklist).toContain(`[${pattern.id}]`);
    }
  });

  test("hasApplicablePatterns is false for personas with no catalogued patterns yet — locks in the cost short-circuit", () => {
    expect(hasApplicablePatterns("novice-user")).toBe(false);
    expect(hasApplicablePatterns("adversarial-input")).toBe(false);
    expect(hasApplicablePatterns("accessibility-auditor")).toBe(true);
  });

  test("buildPersonaGuidance/buildSkepticChecklist return empty string for a persona with nothing applicable", () => {
    expect(buildPersonaGuidance("novice-user")).toBe("");
    expect(buildSkepticChecklist("novice-user")).toBe("");
  });
});

describe("recordCalibrationAudit", () => {
  test("appends one correct JSON line per call", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-calibration-audit-"));
    const auditFile = join(dir, "audit.jsonl");
    try {
      const verdicts = [
        {
          persona: "accessibility-auditor-mobile",
          matchedPatternId: "native-control-internal-segment",
          clearedAsFalsePositive: true,
          summary: "CALIBRATION_VERDICT: FALSE_POSITIVE — pattern: native-control-internal-segment — screenshot confirmed a highlighted segment",
          isError: false,
          costUsd: 0.4,
        },
      ];
      recordCalibrationAudit(auditFile, "abc123", "https://preview.example.workers.dev", verdicts);
      recordCalibrationAudit(auditFile, "def456", "https://preview.example.workers.dev", verdicts);

      expect(existsSync(auditFile)).toBe(true);
      const lines = readFileSync(auditFile, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);

      const parsed = JSON.parse(lines[0]!);
      expect(parsed.sha).toBe("abc123");
      expect(parsed.allClearedAsFalsePositive).toBe(true);
      expect(parsed.verdicts).toEqual(verdicts);
      expect(typeof parsed.timestamp).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("allClearedAsFalsePositive is false when any verdict didn't clear", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-calibration-audit-"));
    const auditFile = join(dir, "audit.jsonl");
    try {
      recordCalibrationAudit(auditFile, "sha1", "https://preview.example.workers.dev", [
        {
          persona: "accessibility-auditor-desktop",
          matchedPatternId: "css-transition-timing",
          clearedAsFalsePositive: true,
          summary: "cleared",
          isError: false,
          costUsd: 0.2,
        },
        {
          persona: "accessibility-auditor-mobile",
          matchedPatternId: null,
          clearedAsFalsePositive: false,
          summary: "not cleared",
          isError: false,
          costUsd: 0.2,
        },
      ]);
      const parsed = JSON.parse(readFileSync(auditFile, "utf-8").trim());
      expect(parsed.allClearedAsFalsePositive).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
