import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * index.ts (`bun run fix`) calls `main()` unconditionally at module scope —
 * there's no `import.meta.main` guard — so it can never be safely imported
 * in-process (importing it would immediately run `main()`, which can call
 * `process.exit()` and would kill the whole test run). It's tested here
 * exclusively as a real subprocess with crafted argv/env, asserting on
 * stdout/stderr/exit code — true black-box CLI testing.
 *
 * Only the early-exit validation branches are exercised (missing --repo;
 * neither --manual-report nor --sentry-org+--sentry-project given; the
 * ANTHROPIC_API_KEY fallback notice). Anything past that point calls real
 * Sentry/agent/pipeline machinery and is deliberately out of scope here —
 * see the "gaps" note in the final report.
 */

const INDEX_TS = join(import.meta.dir, "index.ts");

const tmpDirs: string[] = [];
function freshRepoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "day2-index-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

async function runIndex(args: string[], env: Record<string, string | undefined>) {
  const proc = Bun.spawn({
    cmd: ["bun", "run", INDEX_TS, ...args],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("index.ts — argument parsing and early validation", () => {
  test("missing --repo prints usage to stderr and exits 1", async () => {
    const env = { ...process.env, ANTHROPIC_API_KEY: "test-key" };
    const { stderr, exitCode } = await runIndex([], env);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Usage: bun run fix --repo <path>/);
  });

  test("--repo without any report source errors and exits 1, without ever reaching the pipeline", async () => {
    const dir = freshRepoDir();
    const env = { ...process.env, ANTHROPIC_API_KEY: "test-key" };
    const { stderr, exitCode } = await runIndex(["--repo", dir], env);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Provide either --manual-report <file> or --sentry-org \+ --sentry-project\./);
  });

  test("--sentry-org alone (without --sentry-project) is treated as no report source given", async () => {
    const dir = freshRepoDir();
    const env = { ...process.env, ANTHROPIC_API_KEY: "test-key" };
    const { stderr, exitCode } = await runIndex(["--repo", dir, "--sentry-org", "my-org"], env);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Provide either --manual-report/);
  });

  test("logs the Max-subscription fallback notice when ANTHROPIC_API_KEY is unset", async () => {
    const dir = freshRepoDir();
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const { stdout, exitCode } = await runIndex(["--repo", dir], env);
    expect(exitCode).toBe(1); // still errors out on the missing report source, after logging
    expect(stdout).toMatch(/No ANTHROPIC_API_KEY set — falling back to the local Claude Code login/);
  });

  test("does not print the fallback notice when ANTHROPIC_API_KEY is set", async () => {
    const dir = freshRepoDir();
    const env = { ...process.env, ANTHROPIC_API_KEY: "test-key" };
    const { stdout } = await runIndex(["--repo", dir], env);
    expect(stdout).not.toMatch(/falling back to the local Claude Code login/);
  });
});
