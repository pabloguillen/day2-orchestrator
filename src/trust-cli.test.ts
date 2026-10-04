import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutonomyOutcome } from "./trust";
import type { AuditEntry } from "./owner-feed";

/**
 * trust-cli.ts is entirely pure/file-based — it never shells out and never
 * touches the network (loadAutonomyConfig/loadAuditEntries/
 * loadAutonomyOutcomes are all plain file reads, computeTrackRecord/
 * proposeLevelUp are pure functions). So it's tested as a real subprocess
 * against real temp files, no mocking or fake binaries required at all —
 * this exercises the actual argument parsing and branching end to end.
 */

const TRUST_CLI_TS = join(import.meta.dir, "trust-cli.ts");

const tmpDirs: string[] = [];
function freshRepoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "day2-trust-cli-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

async function runTrustCli(args: string[]) {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TRUST_CLI_TS, ...args],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function writeJsonl(path: string, entries: unknown[]): void {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("trust-cli.ts — argument parsing", () => {
  test("missing --repo prints usage and exits 1", async () => {
    const { stderr, exitCode } = await runTrustCli([]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Usage: bun run src\/trust-cli\.ts --repo <path>/);
  });
});

describe("trust-cli.ts — branching on the real track record", () => {
  test("no .day2-autonomy.json at all: nothing configured, nothing to evaluate", async () => {
    const dir = freshRepoDir();
    const { stdout, exitCode } = await runTrustCli(["--repo", dir]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/No areas configured in \.day2-autonomy\.json — nothing to evaluate\./);
  });

  test("an area is configured, but its track record doesn't clear the level-up bar", async () => {
    const dir = freshRepoDir();
    writeFileSync(
      join(dir, ".day2-autonomy.json"),
      JSON.stringify({ defaultLevel: "L2", areas: [{ area: "ui", pathGlobs: ["src/components/**"], level: "L2" }] }),
    );
    // Only 2 clean auto-ships recorded — short of the 10-streak threshold.
    const auditFile = join(dir, "audit.jsonl");
    const outcomeFile = join(dir, "outcomes.jsonl");
    const audit: AuditEntry[] = [1, 2].map((n) => ({
      timestamp: `2026-01-0${n}T00:00:00.000Z`,
      sourceId: `src-${n}`,
      area: "ui",
      filesChanged: ["src/components/x.tsx"],
      level: "L2",
      autoShip: true,
      reason: "eligible",
    }));
    const outcomes: AutonomyOutcome[] = [1, 2].map((n) => ({
      timestamp: `2026-01-0${n}T01:00:00.000Z`,
      sourceId: `src-${n}`,
      status: "promoted",
      reason: "held up fine",
    }));
    writeJsonl(auditFile, audit);
    writeJsonl(outcomeFile, outcomes);

    const { stdout, exitCode } = await runTrustCli([
      "--repo",
      dir,
      "--audit-file",
      auditFile,
      "--outcome-file",
      outcomeFile,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/No area's track record currently clears the bar for a level-up suggestion\./);
  });

  test("an area with a clean 10-auto-ship streak gets a level-up suggestion printed", async () => {
    const dir = freshRepoDir();
    writeFileSync(
      join(dir, ".day2-autonomy.json"),
      JSON.stringify({ defaultLevel: "L2", areas: [{ area: "ui", pathGlobs: ["src/components/**"], level: "L2" }] }),
    );
    const auditFile = join(dir, "audit.jsonl");
    const outcomeFile = join(dir, "outcomes.jsonl");
    const ids = Array.from({ length: 10 }, (_, i) => `src-${i}`);
    const audit: AuditEntry[] = ids.map((sourceId, i) => ({
      timestamp: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      sourceId,
      area: "ui",
      filesChanged: ["src/components/x.tsx"],
      level: "L2",
      autoShip: true,
      reason: "eligible",
    }));
    const outcomes: AutonomyOutcome[] = ids.map((sourceId, i) => ({
      timestamp: `2026-01-${String(i + 1).padStart(2, "0")}T01:00:00.000Z`,
      sourceId,
      status: "promoted",
      reason: "held up fine",
    }));
    writeJsonl(auditFile, audit);
    writeJsonl(outcomeFile, outcomes);

    const { stdout, exitCode } = await runTrustCli([
      "--repo",
      dir,
      "--audit-file",
      auditFile,
      "--outcome-file",
      outcomeFile,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\[day2-trust\] ui: 10 consecutive auto-shipped changes in "ui"/);
    expect(stdout).toMatch(/consider raising this area from L2 to L3/);
  });
});
