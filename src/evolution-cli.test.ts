import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompetitorInsight } from "./competitor-feed";
import type { ProposalResult } from "./evolution";

/**
 * evolution-cli.ts is the file the audit named directly: the `--reject
 * "<title>" --reason "<why>"` wiring, and whether a normal run actually
 * loads existing rejections and passes them through to `proposeFeature`,
 * were entirely unverified.
 *
 * Two strategies are combined here:
 *
 * - `--reject`/`--list` touch only proposals.ts, which is pure file I/O
 *   (append/read JSONL) with zero network or agent calls — so those are
 *   run as real subprocesses against real temp files. No mocking needed,
 *   and this is arguably stronger proof than a mock spy: the actual file
 *   `recordRejection` wrote is read back and asserted on.
 *
 * - A normal run's `--app-url`/`--device-ids` path calls `proposeFeature`,
 *   which drives a real Claude Agent SDK `query()` — genuinely
 *   network/cost-bearing and not something a test suite should ever
 *   trigger. `./evolution` and `./competitor-feed` are mocked in-process
 *   for this one purpose. `main` had to be exported from evolution-cli.ts
 *   (previously module-private) to make this reachable — the only source
 *   edit this suite required, and it's a no-op for real CLI usage, which
 *   still goes through the unchanged `if (import.meta.main)` guard.
 */

type ProposeFeatureArgs = [string, string[], CompetitorInsight[], unknown[]];

const proposeFeatureMock = mock(async (..._args: ProposeFeatureArgs): Promise<ProposalResult> => ({
  status: "no_proposal",
}));
const researchCompetitorFeaturesMock = mock(async (_category: string): Promise<CompetitorInsight[]> => []);

mock.module("./evolution", () => ({
  proposeFeature: proposeFeatureMock,
}));
mock.module("./competitor-feed", () => ({
  researchCompetitorFeatures: researchCompetitorFeaturesMock,
}));

const { main } = await import("./evolution-cli");

beforeEach(() => {
  proposeFeatureMock.mockReset();
  proposeFeatureMock.mockImplementation(async () => ({ status: "no_proposal" }));
  researchCompetitorFeaturesMock.mockReset();
  researchCompetitorFeaturesMock.mockImplementation(async () => []);
});

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "day2-evolution-cli-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

async function callMain(args: string[]): Promise<void> {
  const origArgv = process.argv;
  process.argv = ["bun", "evolution-cli.ts", ...args];
  try {
    await main();
  } finally {
    process.argv = origArgv;
  }
}

describe("evolution-cli.ts — normal run wiring (in-process, agent/network mocked)", () => {
  test("loads existing rejections via listRejections and passes them through to proposeFeature, alongside parsed device IDs", async () => {
    const dir = freshDir();
    const rejectionsFile = join(dir, "rejections.jsonl");
    const proposalsFile = join(dir, "proposals.jsonl");
    writeFileSync(
      rejectionsFile,
      JSON.stringify({ title: "Old idea", reason: "too niche", rejectedAt: "2026-01-01T00:00:00.000Z" }) + "\n",
    );

    await callMain([
      "--app-url",
      "http://fake.test",
      "--device-ids",
      " a , b ,c,",
      "--rejections-file",
      rejectionsFile,
      "--proposals-file",
      proposalsFile,
    ]);

    expect(proposeFeatureMock.mock.calls.length).toBe(1);
    const [appUrl, deviceIds, competitorInsights, rejections] = proposeFeatureMock.mock.calls[0]!;
    expect(appUrl).toBe("http://fake.test");
    expect(deviceIds).toEqual(["a", "b", "c"]);
    expect(competitorInsights).toEqual([]);
    expect(rejections).toEqual([{ title: "Old idea", reason: "too niche", rejectedAt: "2026-01-01T00:00:00.000Z" }]);
    expect(researchCompetitorFeaturesMock.mock.calls.length).toBe(0);
  });

  test("--research-competitors is opt-in: researchCompetitorFeatures is called with the category, and its insights reach proposeFeature", async () => {
    const dir = freshDir();
    const rejectionsFile = join(dir, "rejections.jsonl");
    const proposalsFile = join(dir, "proposals.jsonl");
    const insights: CompetitorInsight[] = [
      { competitor: "Acme Budgets", feature: "Shared household view", relevance: "high", source: "https://acme.example/blog" },
    ];
    researchCompetitorFeaturesMock.mockImplementation(async () => insights);

    await callMain([
      "--app-url",
      "http://fake.test",
      "--device-ids",
      "a",
      "--research-competitors",
      "budgeting apps",
      "--rejections-file",
      rejectionsFile,
      "--proposals-file",
      proposalsFile,
    ]);

    expect(researchCompetitorFeaturesMock.mock.calls.length).toBe(1);
    expect(researchCompetitorFeaturesMock.mock.calls[0]![0]).toBe("budgeting apps");
    expect(proposeFeatureMock.mock.calls.length).toBe(1);
    expect(proposeFeatureMock.mock.calls[0]![2]).toEqual(insights);
  });

  test("an 'already_rejected' result from proposeFeature is reported and nothing new is recorded", async () => {
    const dir = freshDir();
    const proposalsFile = join(dir, "proposals.jsonl");
    proposeFeatureMock.mockImplementation(async () => ({
      status: "already_rejected",
      proposal: { title: "X", rationale: "r", observedEvidence: "e", proposedContract: "c", openQuestions: [] },
      previousRejection: { title: "X", reason: "nah, too niche", rejectedAt: "2026-02-01T00:00:00.000Z" },
    }));
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await callMain([
        "--app-url",
        "http://fake.test",
        "--device-ids",
        "a",
        "--rejections-file",
        join(dir, "rejections.jsonl"),
        "--proposals-file",
        proposalsFile,
      ]);
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toMatch(/Not surfacing "X" — a human already rejected this \(2026-02-01T00:00:00\.000Z\): nah, too niche/);
    } finally {
      logSpy.mockRestore();
    }
    expect(existsSync(proposalsFile)).toBe(false);
  });

  test("a 'parse_failed' result logs the reason and sets a non-zero exit code", async () => {
    const dir = freshDir();
    proposeFeatureMock.mockImplementation(async () => ({ status: "parse_failed", reason: "model output was not valid JSON" }));
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    // Bun quirk confirmed by hand: once `process.exitCode` is set to a
    // number, reassigning `undefined` does NOT clear it back to "unset" —
    // it stays sticky at the last numeric value. Only assigning a concrete
    // number (0, to restore "success") actually resets it. Skipping this
    // would leak a failing exit code into the whole `bun test` run despite
    // every assertion passing.
    const origExitCode = process.exitCode ?? 0;
    try {
      await callMain([
        "--app-url",
        "http://fake.test",
        "--device-ids",
        "a",
        "--rejections-file",
        join(dir, "rejections.jsonl"),
        "--proposals-file",
        join(dir, "proposals.jsonl"),
      ]);
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toMatch(/Could not produce a usable proposal: model output was not valid JSON/);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = origExitCode;
      errSpy.mockRestore();
    }
  });

  test("a 'proposed' result is recorded to the real proposals file and rendered", async () => {
    const dir = freshDir();
    const proposalsFile = join(dir, "proposals.jsonl");
    proposeFeatureMock.mockImplementation(async () => ({
      status: "proposed",
      proposal: {
        title: "Bulk export",
        rationale: "Several users requested it",
        observedEvidence: "3 of 5 profiles show repeated manual exports",
        proposedContract: "exportAll(deviceId: string): Promise<Blob>",
        openQuestions: ["Which formats?"],
      },
    }));
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await callMain([
        "--app-url",
        "http://fake.test",
        "--device-ids",
        "a",
        "--rejections-file",
        join(dir, "rejections.jsonl"),
        "--proposals-file",
        proposalsFile,
      ]);
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toMatch(/# Proposed: Bulk export/);
      expect(logged).toMatch(new RegExp(`Recorded to ${proposalsFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`));
    } finally {
      logSpy.mockRestore();
    }
    expect(existsSync(proposalsFile)).toBe(true);
    const saved = JSON.parse(readFileSync(proposalsFile, "utf-8").trim());
    expect(saved.title).toBe("Bulk export");
  });
});

const EVOLUTION_CLI_TS = join(import.meta.dir, "evolution-cli.ts");

async function runEvolutionCli(args: string[]) {
  const proc = Bun.spawn({
    cmd: ["bun", "run", EVOLUTION_CLI_TS, ...args],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("evolution-cli.ts — --reject (real subprocess, real files, no mocking)", () => {
  test("--reject without --reason errors and exits 1", async () => {
    const { stderr, exitCode } = await runEvolutionCli(["--reject", "Some title"]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Usage: bun run src\/evolution-cli\.ts --reject "<title>" --reason "<why>"/);
  });

  test('--reject "<title>" --reason "<why>" really does call recordRejection with the exact title/reason given', async () => {
    const dir = freshDir();
    const rejectionsFile = join(dir, "rejections.jsonl");
    const { stdout, exitCode } = await runEvolutionCli([
      "--reject",
      "Duplicate expense detection",
      "--reason",
      "Already effectively covered by categorization; too complex to justify right now.",
      "--rejections-file",
      rejectionsFile,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Recorded rejection of "Duplicate expense detection" to .*\. It will not be proposed again\./);

    const lines = readFileSync(rejectionsFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.title).toBe("Duplicate expense detection");
    expect(entry.reason).toBe("Already effectively covered by categorization; too complex to justify right now.");
    expect(entry.rejectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("rejecting twice appends two separate entries rather than overwriting", async () => {
    const dir = freshDir();
    const rejectionsFile = join(dir, "rejections.jsonl");
    await runEvolutionCli(["--reject", "Idea A", "--reason", "no", "--rejections-file", rejectionsFile]);
    await runEvolutionCli(["--reject", "Idea B", "--reason", "also no", "--rejections-file", rejectionsFile]);
    const lines = readFileSync(rejectionsFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).title).toBe("Idea A");
    expect(JSON.parse(lines[1]!).title).toBe("Idea B");
  });
});

describe("evolution-cli.ts — --list (real subprocess, real files, no mocking)", () => {
  test("no proposals file yet: reports none recorded", async () => {
    const dir = freshDir();
    const { stdout, exitCode } = await runEvolutionCli(["--list", "--proposals-file", join(dir, "proposals.jsonl")]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/No proposals recorded yet\./);
  });

  test("renders every previously recorded proposal", async () => {
    const dir = freshDir();
    const proposalsFile = join(dir, "proposals.jsonl");
    writeFileSync(
      proposalsFile,
      JSON.stringify({
        title: "Category budgets",
        rationale: "Users overspend in specific categories",
        observedEvidence: "2 profiles show repeated category overspend",
        proposedContract: "setCategoryBudget(category: string, limit: number): void",
        openQuestions: [],
        recordedAt: "2026-01-05T00:00:00.000Z",
      }) + "\n",
    );
    const { stdout, exitCode } = await runEvolutionCli(["--list", "--proposals-file", proposalsFile]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/# Proposed: Category budgets/);
    expect(stdout).toMatch(/Users overspend in specific categories/);
  });
});

describe("evolution-cli.ts — usage errors (real subprocess)", () => {
  test("no flags at all prints the main usage and exits 1", async () => {
    const { stderr, exitCode } = await runEvolutionCli([]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Usage: bun run src\/evolution-cli\.ts --app-url <url> --device-ids a,b,c/);
    expect(stderr).toMatch(/bun run src\/evolution-cli\.ts --list/);
  });

  test("--app-url without --device-ids prints the main usage and exits 1", async () => {
    const { stderr, exitCode } = await runEvolutionCli(["--app-url", "http://fake.test"]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Usage: bun run src\/evolution-cli\.ts --app-url/);
  });
});
