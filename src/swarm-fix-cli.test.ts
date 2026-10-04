import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * swarm-fix-cli.ts, like index.ts, runs `main()` unconditionally at module
 * scope (no `import.meta.main` guard) and isn't safe to import in-process.
 * It's tested here as a real subprocess, argv/stdout/stderr/exit-code only.
 *
 * Only the required-flags validation branch is covered. Supplying all three
 * required flags would run the real swarm (`runSwarm`, a live
 * browser-automation pass against --preview-url) and, past that, the real
 * healing pipeline — both require network/browser/agent access this suite
 * deliberately never exercises. See the "gaps" note in the final report for
 * why --dry-run output formatting and the anyFailed aggregation aren't
 * covered here.
 */

const SWARM_FIX_TS = join(import.meta.dir, "swarm-fix-cli.ts");

async function runSwarmFix(args: string[]) {
  const proc = Bun.spawn({
    cmd: ["bun", "run", SWARM_FIX_TS, ...args],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("swarm-fix-cli.ts — argument parsing", () => {
  test("no flags at all: prints usage and exits 1 without running the swarm", async () => {
    const { stdout, stderr, exitCode } = await runSwarmFix([]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Usage: bun run swarm-fix -- --repo <path> --sha <commit-under-test>/);
    expect(stdout).toBe("");
  });

  test("missing just --preview-url still fails the same required-flags check", async () => {
    const { stderr, exitCode } = await runSwarmFix(["--repo", "/tmp/whatever", "--sha", "deadbeef"]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Usage: bun run swarm-fix/);
  });

  test("missing just --sha still fails the same required-flags check", async () => {
    const { stderr, exitCode } = await runSwarmFix(["--repo", "/tmp/whatever", "--preview-url", "https://preview.example"]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Usage: bun run swarm-fix/);
  });

  test("missing just --repo still fails the same required-flags check", async () => {
    const { stderr, exitCode } = await runSwarmFix(["--sha", "deadbeef", "--preview-url", "https://preview.example"]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Usage: bun run swarm-fix/);
  });

  test("the usage message documents --dry-run as optional", async () => {
    const { stderr } = await runSwarmFix([]);
    expect(stderr).toMatch(/\[--dry-run\]/);
    expect(stderr).toMatch(/without invoking the pipeline/);
  });
});
