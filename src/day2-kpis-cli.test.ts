import { describe, expect, test } from "bun:test";
import { parseArgs, renderDay2Kpis, toAutoAppliedChangeRecords, toProposalRecords, toReleaseRecords } from "./day2-kpis-cli";
import type { AuditEntry } from "./owner-feed";
import type { RecordedProposal, RejectedProposal } from "./proposals";
import type { RecordedReleaseResult } from "./release";

/**
 * Fixtures below are shaped exactly like the real on-disk formats found in
 * release.ts (`recordReleaseResult`'s `RecordedReleaseResult`),
 * proposals.ts (`recordProposal`/`recordRejection`'s real JSONL shapes —
 * see day2-proposals.jsonl, a real committed sample, for the proposal
 * shape), and owner-feed.ts (`recordAutonomyAudit`'s real `AuditEntry`
 * shape).
 */

describe("toReleaseRecords", () => {
  test("promoted and rolled_back attempts become real ReleaseRecords", () => {
    const results: RecordedReleaseResult[] = [
      { timestamp: "2026-08-01T00:00:00.000Z", sha: "a1", result: { status: "promoted", errorCount: 0, canaryVersionId: "v1" } },
      {
        timestamp: "2026-08-15T00:00:00.000Z",
        sha: "a2",
        result: { status: "rolled_back", reason: "3 errors", errorCount: 3, canaryVersionId: "v2", stableVersionId: "v1" },
      },
    ];
    const records = toReleaseRecords(results);
    expect(records).toEqual([
      { shippedAt: "2026-08-01T00:00:00.000Z", rolledBack: false },
      { shippedAt: "2026-08-15T00:00:00.000Z", rolledBack: true },
    ]);
  });

  test("pre-flight failures and dry runs are excluded — they never shipped real traffic", () => {
    const results: RecordedReleaseResult[] = [
      { timestamp: "t0", sha: "b1", result: { status: "smoke_check_failed", reason: "unreachable", canaryVersionId: "v1" } },
      { timestamp: "t1", sha: "b2", result: { status: "swarm_check_failed", reason: "persona failed", canaryVersionId: "v2", personaResults: [] } },
      { timestamp: "t2", sha: "b3", result: { status: "dry_run_stopped_before_traffic_shift", canaryVersionId: "v3", previewUrl: "https://preview" } },
    ];
    expect(toReleaseRecords(results)).toEqual([]);
  });
});

describe("toProposalRecords", () => {
  test("a proposal found in the rejections log (same case-insensitive title match isAlreadyRejected uses) maps to approved: false", () => {
    const proposals: RecordedProposal[] = [
      {
        title: "Quick re-add for dominant category",
        rationale: "r",
        observedEvidence: "e",
        proposedContract: "c",
        openQuestions: [],
        recordedAt: "2026-09-27T21:03:50.339Z",
      },
    ];
    const rejections: RejectedProposal[] = [
      { title: "  quick re-add for dominant category  ", reason: "not now", rejectedAt: "2026-09-28T00:00:00.000Z" },
    ];
    const records = toProposalRecords(proposals, rejections);
    expect(records).toEqual([{ proposedAt: "2026-09-27T21:03:50.339Z", approved: false }]);
  });

  test("a proposal with no matching rejection maps to approved: null — still genuinely undecided", () => {
    const proposals: RecordedProposal[] = [
      { title: "Something new", rationale: "r", observedEvidence: "e", proposedContract: "c", openQuestions: [], recordedAt: "t0" },
    ];
    const records = toProposalRecords(proposals, []);
    expect(records).toEqual([{ proposedAt: "t0", approved: null }]);
  });

  test("never produces approved: true — no real approval event exists anywhere in this codebase", () => {
    const proposals: RecordedProposal[] = [
      { title: "A", rationale: "r", observedEvidence: "e", proposedContract: "c", openQuestions: [], recordedAt: "t0" },
      { title: "B", rationale: "r", observedEvidence: "e", proposedContract: "c", openQuestions: [], recordedAt: "t1" },
    ];
    const rejections: RejectedProposal[] = [{ title: "A", reason: "no", rejectedAt: "t0" }];
    const records = toProposalRecords(proposals, rejections);
    expect(records.some((r) => r.approved === true)).toBe(false);
  });
});

describe("toAutoAppliedChangeRecords", () => {
  test("returns an empty array today — no real on-disk 'undone' signal exists yet (disclosed, not fabricated)", () => {
    const entries: AuditEntry[] = [
      {
        timestamp: "t0",
        sourceId: "s1",
        area: "ui",
        filesChanged: ["src/x.ts"],
        level: "L3",
        autoShip: true,
        reason: "Bug fix, independently verified, CI green.",
      },
    ];
    expect(toAutoAppliedChangeRecords(entries)).toEqual([]);
  });
});

describe("parseArgs", () => {
  test("applies the same real default filenames canary-cli.ts/auto-release-cli.ts/evolution-cli.ts already use", () => {
    const original = process.argv;
    try {
      process.argv = [...original.slice(0, 2), "--repo", "/tmp/repo"];
      const opts = parseArgs();
      expect(opts.releaseFile).toBe("day2-release-results.jsonl");
      expect(opts.auditFile).toBe("day2-autonomy-audit.jsonl");
      expect(opts.proposalsFile).toBe("day2-proposals.jsonl");
      expect(opts.rejectionsFile).toBe("day2-proposal-rejections.jsonl");
    } finally {
      process.argv = original;
    }
  });

  test("explicit flags override the defaults", () => {
    const original = process.argv;
    try {
      process.argv = [...original.slice(0, 2), "--repo", "/tmp/repo", "--release-file", "custom.jsonl"];
      expect(parseArgs().releaseFile).toBe("custom.jsonl");
    } finally {
      process.argv = original;
    }
  });
});

describe("renderDay2Kpis", () => {
  test("renders real data metrics with a percentage and n", () => {
    const rendered = renderDay2Kpis(
      { metric: "change_success_rate", breakdown: {}, value: 0.5, n: 2, ci: [0.1, 0.9], sufficientData: false },
      { metric: "rollback_rate", breakdown: {}, value: 0.25, n: 4, ci: [0.1, 0.5], sufficientData: false },
      { metric: "proposal_approval_rate", breakdown: {}, value: null, n: 0, ci: null, sufficientData: false },
      { metric: "owner_undo_rate", breakdown: {}, value: null, n: 0, ci: null, sufficientData: false },
      "2026-10-04T00:00:00.000Z",
    );
    expect(rendered).toContain("change_success_rate:    50.0% (n=2, below confidence threshold)");
    expect(rendered).toContain("rollback_rate:          25.0% (n=4, below confidence threshold)");
    expect(rendered).toContain("proposal_approval_rate: no data (n=0)");
    expect(rendered).toContain("owner_undo_rate:        no data (n=0)");
  });
});
