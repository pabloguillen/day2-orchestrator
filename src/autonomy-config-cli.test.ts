import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "./autonomy-config-cli";

/**
 * autonomy-config-cli.ts is entirely pure/file-based — it only reads/writes
 * `.day2-autonomy.json` and calls the real (also pure) autonomy-config.ts
 * functions. No network, no shelling out. So its branching is tested here
 * as a real subprocess against a real temp repo dir — no mocking needed.
 */

describe("parseArgs", () => {
  test("collects repeated --glob flags into an array", () => {
    const orig = process.argv;
    process.argv = [
      "bun",
      "autonomy-config-cli.ts",
      "--repo",
      "/r",
      "--area",
      "ui",
      "--glob",
      "src/components/**",
      "--glob",
      "src/pages/**",
      "--auto-ship",
      "yes",
    ];
    try {
      expect(parseArgs()).toEqual({
        repo: "/r",
        area: "ui",
        globs: ["src/components/**", "src/pages/**"],
        autoShip: "yes",
        remove: undefined,
      });
    } finally {
      process.argv = orig;
    }
  });

  test("no --glob flags at all yields an empty array, not undefined", () => {
    const orig = process.argv;
    process.argv = ["bun", "autonomy-config-cli.ts", "--repo", "/r"];
    try {
      expect(parseArgs().globs).toEqual([]);
    } finally {
      process.argv = orig;
    }
  });
});

const AUTONOMY_CONFIG_CLI_TS = join(import.meta.dir, "autonomy-config-cli.ts");

const tmpDirs: string[] = [];
function freshRepoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "day2-autonomy-config-cli-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

async function runAutonomyConfigCli(args: string[]) {
  const proc = Bun.spawn({
    cmd: ["bun", "run", AUTONOMY_CONFIG_CLI_TS, ...args],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("autonomy-config-cli.ts — argument validation", () => {
  test("missing --repo prints usage and exits 1", async () => {
    const { stderr, exitCode } = await runAutonomyConfigCli([]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Usage: bun run src\/autonomy-config-cli\.ts --repo <path>/);
  });

  test("--area without any --glob prints usage and exits 1", async () => {
    const dir = freshRepoDir();
    const { exitCode } = await runAutonomyConfigCli(["--repo", dir, "--area", "ui"]);
    expect(exitCode).toBe(1);
  });

  test("--area with --glob but an invalid --auto-ship value prints usage and exits 1", async () => {
    const dir = freshRepoDir();
    const { exitCode } = await runAutonomyConfigCli([
      "--repo",
      dir,
      "--area",
      "ui",
      "--glob",
      "src/**",
      "--auto-ship",
      "maybe",
    ]);
    expect(exitCode).toBe(1);
  });
});

describe("autonomy-config-cli.ts — default (summary) mode", () => {
  test("fresh repo with no config file: prints the plain L2-everywhere default", async () => {
    const dir = freshRepoDir();
    const { stdout, exitCode } = await runAutonomyConfigCli(["--repo", dir]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Default: areas with no explicit setting stay at L2/);
    expect(stdout).toMatch(/No areas have opted into automatic shipping yet\./);
  });
});

describe("autonomy-config-cli.ts — --area / --glob / --auto-ship", () => {
  test("--auto-ship yes on an ordinary (non-sensitive) glob saves at L3 and confirms it will really ship", async () => {
    const dir = freshRepoDir();
    const { stdout, exitCode } = await runAutonomyConfigCli([
      "--repo",
      dir,
      "--area",
      "ui",
      "--glob",
      "src/components/**",
      "--auto-ship",
      "yes",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Saved "ui" \(src\/components\/\*\*\) at L3\./);
    expect(stdout).toMatch(/Verified low-risk bug fixes here will now ship automatically, with one-tap undo\./);

    const saved = JSON.parse(readFileSync(join(dir, ".day2-autonomy.json"), "utf-8"));
    expect(saved.areas).toEqual([{ area: "ui", pathGlobs: ["src/components/**"], level: "L3" }]);
  });

  test("--auto-ship yes on a glob that matches a sensitive path warns it won't actually auto-ship", async () => {
    const dir = freshRepoDir();
    const { stdout, exitCode } = await runAutonomyConfigCli([
      "--repo",
      dir,
      "--area",
      "auth",
      "--glob",
      "src/auth/**",
      "--auto-ship",
      "yes",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Saved "auth" \(src\/auth\/\*\*\) at L3\./);
    expect(stdout).toMatch(/⚠ This won't actually auto-ship yet, even though you asked for it:/);
    expect(stdout).toMatch(/sensitive path/);
  });

  test("--auto-ship no saves at L2 and says fixes will keep opening a PR", async () => {
    const dir = freshRepoDir();
    const { stdout, exitCode } = await runAutonomyConfigCli([
      "--repo",
      dir,
      "--area",
      "ui",
      "--glob",
      "src/components/**",
      "--auto-ship",
      "no",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Saved "ui" \(src\/components\/\*\*\) at L2\./);
    expect(stdout).toMatch(/Fixes here will keep opening a PR for a human to merge\./);
  });
});

describe("autonomy-config-cli.ts — --remove", () => {
  test("removing a previously-configured area falls back to the default and persists", async () => {
    const dir = freshRepoDir();
    await runAutonomyConfigCli(["--repo", dir, "--area", "ui", "--glob", "src/**", "--auto-ship", "yes"]);

    const { stdout, exitCode } = await runAutonomyConfigCli(["--repo", dir, "--remove", "ui"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Removed "ui" — it now falls back to the default \(L2: every fix opens a PR, a human merges it\)\./);

    const saved = JSON.parse(readFileSync(join(dir, ".day2-autonomy.json"), "utf-8"));
    expect(saved.areas).toEqual([]);
  });

  test("the post-removal summary no longer lists the removed area", async () => {
    const dir = freshRepoDir();
    await runAutonomyConfigCli(["--repo", dir, "--area", "ui", "--glob", "src/**", "--auto-ship", "yes"]);
    await runAutonomyConfigCli(["--repo", dir, "--remove", "ui"]);

    const { stdout } = await runAutonomyConfigCli(["--repo", dir]);
    expect(stdout).not.toMatch(/"ui"/);
    expect(stdout).toMatch(/No areas have opted into automatic shipping yet\./);
  });
});
