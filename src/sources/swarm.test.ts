import { describe, expect, test } from "bun:test";
import { swarmFailuresToBugReports } from "./swarm";
import type { PersonaResult } from "../swarm";

const context = { sha: "abcdef1234567890", previewUrl: "https://preview.example.workers.dev" };

function persona(overrides: Partial<PersonaResult>): PersonaResult {
  return {
    persona: "novice-user-desktop",
    passed: true,
    summary: "SWARM_VERDICT: PASS",
    isError: false,
    costUsd: 0.1,
    ...overrides,
  };
}

describe("swarmFailuresToBugReports", () => {
  test("passed personas produce no bug reports", () => {
    const reports = swarmFailuresToBugReports([persona({ passed: true })], context);
    expect(reports).toEqual([]);
  });

  test("a failed persona becomes one bug report with the verdict prefix stripped", () => {
    const reports = swarmFailuresToBugReports(
      [
        persona({
          persona: "accessibility-auditor-mobile",
          passed: false,
          summary: "SWARM_VERDICT: FAIL — delete button invisible on touch devices",
        }),
      ],
      context,
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]!.description).toBe("delete button invisible on touch devices");
    expect(reports[0]!.title).not.toContain("SWARM_VERDICT");
    expect(reports[0]!.title).toContain("accessibility-auditor-mobile");
    expect(reports[0]!.source).toBe("swarm");
  });

  test("sourceId is deterministic per (sha, persona) — reprocessing the same swarm result dedupes", () => {
    const failing = persona({ persona: "adversarial-input-desktop", passed: false, summary: "SWARM_VERDICT: FAIL — x" });
    const first = swarmFailuresToBugReports([failing], context)[0]!;
    const second = swarmFailuresToBugReports([failing], context)[0]!;
    expect(first.sourceId).toBe(second.sourceId);
  });

  test("different personas on the same commit get different sourceIds", () => {
    const reports = swarmFailuresToBugReports(
      [
        persona({ persona: "novice-user-mobile", passed: false, summary: "SWARM_VERDICT: FAIL — a" }),
        persona({ persona: "adversarial-input-mobile", passed: false, summary: "SWARM_VERDICT: FAIL — b" }),
      ],
      context,
    );
    expect(reports[0]!.sourceId).not.toBe(reports[1]!.sourceId);
  });

  test("a persona that never reached a parseable verdict still produces a usable report, not a dropped finding", () => {
    const reports = swarmFailuresToBugReports(
      [
        persona({
          persona: "novice-user-desktop",
          passed: false,
          isError: true,
          summary: "(agent run threw before producing a result: hit turn cap)",
        }),
      ],
      context,
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]!.description).toContain("hit turn cap");
    expect(reports[0]!.context).toContain("lower-confidence");
  });

  test("multiple failures produce independent single-concern reports, not one combined report", () => {
    const reports = swarmFailuresToBugReports(
      [
        persona({ persona: "accessibility-auditor-desktop", passed: false, summary: "SWARM_VERDICT: FAIL — focus contrast too low" }),
        persona({ persona: "adversarial-input-desktop", passed: false, summary: "SWARM_VERDICT: FAIL — negative amount silently rejected" }),
      ],
      context,
    );
    expect(reports).toHaveLength(2);
    expect(reports[0]!.description).toContain("focus contrast");
    expect(reports[1]!.description).toContain("negative amount");
  });

  test("includes the commit and preview URL in context for traceability", () => {
    const reports = swarmFailuresToBugReports(
      [persona({ passed: false, summary: "SWARM_VERDICT: FAIL — x" })],
      context,
    );
    expect(reports[0]!.context).toContain(context.sha);
    expect(reports[0]!.context).toContain(context.previewUrl);
  });
});
