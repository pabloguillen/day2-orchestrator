import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * git.ts shells real `git` via Bun's `$`. Two things were confirmed by hand
 * before writing this suite:
 *
 * 1. Mutating `process.env.PATH` (or passing a custom `.env()`/`$.env()`)
 *    inside a running process does NOT change which `git` binary Bun's `$`
 *    resolves — it resolves the executable against the environment the
 *    process was *launched* with, not whatever `process.env` holds later.
 * 2. Overriding `PATH` at the *launch* of a fresh `bun` subprocess does work.
 *
 * So the pattern this suite establishes for mocking the shell-exec boundary:
 * run each git.ts function in a short-lived `bun run <harness>` child
 * process whose PATH is pointed at a directory containing a fake, fully
 * scriptable `git` executable (a tiny bash script controlled entirely by
 * env vars). This lets every test exercise the real, unmodified git.ts
 * against a fake `git` that behaves exactly as instructed — including
 * failing on command, which is the realistic failure path (a bad ref, a
 * network blip on fetch/push, a dirty clone) that was previously entirely
 * uncovered. No real network or real repository is ever touched.
 */

const GIT_TS = join(import.meta.dir, "git.ts");

const FAKE_GIT_SCRIPT = `#!/usr/bin/env bash
args="$*"
if [[ -n "$FAIL_ON" && "$args" == *"$FAIL_ON"* ]]; then
  echo "\${FAIL_MSG:-fake git failure}" >&2
  exit "\${FAIL_CODE:-1}"
fi
case "$args" in
  *"remote get-url origin"*)
    echo "\${OUT_REMOTE_URL:-https://example.com/fake/repo.git}"
    ;;
  *"status --porcelain"*)
    printf '%s' "$OUT_STATUS"
    ;;
  *"diff "*"--stat"*)
    printf '%s' "$OUT_DIFF_STAT"
    ;;
esac
exit 0
`;

const HARNESS_SCRIPT = `
import * as git from ${JSON.stringify(GIT_TS)};
const [fnName, argsJson] = process.argv.slice(2);
const args = JSON.parse(argsJson);
try {
  const result = await (git)[fnName](...args);
  console.log(JSON.stringify({ ok: true, result }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }));
}
`;

let workDir: string;
let fakeBinDir: string;
let harnessPath: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "day2-git-test-"));
  fakeBinDir = join(workDir, "fakebin");
  mkdirSync(fakeBinDir);
  const gitScriptPath = join(fakeBinDir, "git");
  writeFileSync(gitScriptPath, FAKE_GIT_SCRIPT);
  chmodSync(gitScriptPath, 0o755);
  harnessPath = join(workDir, "run-git-fn.ts");
  writeFileSync(harnessPath, HARNESS_SCRIPT);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

type FnResult = { ok: true; result: unknown } | { ok: false; error: string };

async function runGitFn(
  fnName: string,
  args: unknown[],
  env: Record<string, string | undefined> = {},
): Promise<FnResult> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", harnessPath, fnName, JSON.stringify(args)],
    env: { ...process.env, ...env, PATH: `${fakeBinDir}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const lastLine = out.trim().split("\n").pop() ?? "";
  return JSON.parse(lastLine) as FnResult;
}

describe("cloneIsolatedWorkspace", () => {
  test("returns the freshly-cloned workspace path on success", async () => {
    const res = await runGitFn("cloneIsolatedWorkspace", ["/some/source/repo"]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result as string).toMatch(/day2-work-/);
  });

  test("rejects when `git remote get-url origin` fails (e.g. not a real repo)", async () => {
    const res = await runGitFn("cloneIsolatedWorkspace", ["/some/source/repo"], {
      FAIL_ON: "remote get-url origin",
      FAIL_MSG: "fatal: not a git repository",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/exit code/);
  });

  test("rejects when `git clone` itself fails mid-pipeline (e.g. a network error)", async () => {
    const res = await runGitFn("cloneIsolatedWorkspace", ["/some/source/repo"], {
      FAIL_ON: "clone",
      FAIL_MSG: "fatal: unable to access: Could not resolve host",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/exit code/);
  });
});

describe("checkoutSha", () => {
  test("resolves on success", async () => {
    const res = await runGitFn("checkoutSha", ["/some/cwd", "deadbeef"]);
    expect(res).toEqual({ ok: true, result: undefined });
  });

  test("rejects when the initial fetch fails (e.g. network down)", async () => {
    const res = await runGitFn("checkoutSha", ["/some/cwd", "deadbeef"], { FAIL_ON: "fetch origin" });
    expect(res.ok).toBe(false);
  });

  test("rejects when checkout fails (e.g. an unknown sha)", async () => {
    const res = await runGitFn("checkoutSha", ["/some/cwd", "not-a-real-sha"], {
      FAIL_ON: "checkout",
      FAIL_MSG: "fatal: reference is not a tree: not-a-real-sha",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/exit code/);
  });
});

describe("createFixBranch", () => {
  function expectedSlug(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  }

  test("builds the day2-fix-<slug>-<sourceId prefix> branch name and returns it on success", async () => {
    const title = "Login button doesn't work!!";
    const sourceId = "abcdef1234567890";
    const res = await runGitFn("createFixBranch", ["/some/cwd", sourceId, title]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result).toBe(`day2-fix-${expectedSlug(title)}-${sourceId.slice(0, 8)}`);
    }
  });

  test("truncates a long, messy title down to a git-safe 40-char slug", async () => {
    const title = "This is a really long bug title that goes on and on and on and on!!";
    const sourceId = "ffff0000";
    const res = await runGitFn("createFixBranch", ["/some/cwd", sourceId, title]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result).toBe(`day2-fix-${expectedSlug(title)}-${sourceId.slice(0, 8)}`);
    }
  });

  test("rejects when the branch checkout fails (e.g. origin/main unavailable)", async () => {
    const res = await runGitFn("createFixBranch", ["/some/cwd", "abcdef12", "Some bug"], {
      FAIL_ON: "checkout -B",
    });
    expect(res.ok).toBe(false);
  });

  test("rejects when the pre-branch fetch fails", async () => {
    const res = await runGitFn("createFixBranch", ["/some/cwd", "abcdef12", "Some bug"], {
      FAIL_ON: "fetch origin",
    });
    expect(res.ok).toBe(false);
  });
});

describe("hasChanges", () => {
  test("returns true when `git status --porcelain` reports changes", async () => {
    const res = await runGitFn("hasChanges", ["/some/cwd"], { OUT_STATUS: " M src/index.ts\n" });
    expect(res).toEqual({ ok: true, result: true });
  });

  test("returns false when the working tree is clean", async () => {
    const res = await runGitFn("hasChanges", ["/some/cwd"], { OUT_STATUS: "" });
    expect(res).toEqual({ ok: true, result: false });
  });

  test("propagates the error rather than reporting \"no changes\" when git status itself fails", async () => {
    const res = await runGitFn("hasChanges", ["/some/cwd"], { FAIL_ON: "status --porcelain" });
    expect(res.ok).toBe(false);
  });
});

describe("commitAll", () => {
  test("resolves on success", async () => {
    const res = await runGitFn("commitAll", ["/some/cwd", "fix: whatever"]);
    expect(res).toEqual({ ok: true, result: undefined });
  });

  test("rejects when the commit fails (e.g. nothing to commit)", async () => {
    const res = await runGitFn("commitAll", ["/some/cwd", "fix: whatever"], {
      FAIL_ON: "commit -m",
      FAIL_MSG: "nothing to commit, working tree clean",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/exit code/);
  });

  test("rejects when the add step fails", async () => {
    const res = await runGitFn("commitAll", ["/some/cwd", "fix: whatever"], { FAIL_ON: "add -A" });
    expect(res.ok).toBe(false);
  });
});

describe("pushBranch", () => {
  test("resolves on success", async () => {
    const res = await runGitFn("pushBranch", ["/some/cwd", "day2-fix-x"]);
    expect(res).toEqual({ ok: true, result: undefined });
  });

  test("rejects when the push fails (e.g. remote rejected / network error)", async () => {
    const res = await runGitFn("pushBranch", ["/some/cwd", "day2-fix-x"], {
      FAIL_ON: "push -u origin",
      FAIL_MSG: "fatal: unable to access: Could not resolve host",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/exit code/);
  });
});

describe("diffStat", () => {
  test("returns the stat output on success", async () => {
    const res = await runGitFn("diffStat", ["/some/cwd"], { OUT_DIFF_STAT: " 1 file changed, 2 insertions(+)\n" });
    expect(res).toEqual({ ok: true, result: " 1 file changed, 2 insertions(+)\n" });
  });

  test("rejects when the diff fails", async () => {
    const res = await runGitFn("diffStat", ["/some/cwd"], { FAIL_ON: "diff" });
    expect(res.ok).toBe(false);
  });
});
