import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "./approval-cli";

/**
 * approval-cli.ts dispatches to approvals.ts, which shells real `gh pr
 * list/view/merge/close/comment`. Same fake-executable-on-PATH pattern as
 * git.test.ts/pr.test.ts: run the real CLI as a subprocess against a fake,
 * scriptable `gh`, so every branch (list/apply/undo/ask, and gh failing)
 * is exercised without any real network or GitHub state.
 */

describe("parseArgs", () => {
  test("parses --repo alone", () => {
    const orig = process.argv;
    process.argv = ["bun", "approval-cli.ts", "--repo", "/some/repo"];
    try {
      expect(parseArgs()).toEqual({ repo: "/some/repo", apply: undefined, undo: undefined, ask: undefined, askText: undefined });
    } finally {
      process.argv = orig;
    }
  });

  test("parses --ask <pr> \"<question>\" as two separate positional slots after the flag", () => {
    const orig = process.argv;
    process.argv = ["bun", "approval-cli.ts", "--repo", "/some/repo", "--ask", "42", "Why this approach?"];
    try {
      const parsed = parseArgs();
      expect(parsed.ask).toBe("42");
      expect(parsed.askText).toBe("Why this approach?");
    } finally {
      process.argv = orig;
    }
  });

  test("--ask with no question text leaves askText undefined", () => {
    const orig = process.argv;
    process.argv = ["bun", "approval-cli.ts", "--repo", "/some/repo", "--ask", "42"];
    try {
      const parsed = parseArgs();
      expect(parsed.ask).toBe("42");
      expect(parsed.askText).toBeUndefined();
    } finally {
      process.argv = orig;
    }
  });
});

const APPROVAL_CLI_TS = join(import.meta.dir, "approval-cli.ts");

const FAKE_GH_SCRIPT = `#!/usr/bin/env bash
cmd="$1 $2"
dump_args() {
  if [[ -n "$GH_ARGS_FILE" ]]; then
    : > "$GH_ARGS_FILE"
    for a in "$@"; do printf '%s\\0' "$a" >> "$GH_ARGS_FILE"; done
  fi
}
case "$cmd" in
  "pr list")
    printf '%s' "$OUT_PR_LIST"
    ;;
  "pr view")
    printf '%s' "$OUT_PR_VIEW"
    ;;
  "pr merge"|"pr close"|"pr comment")
    dump_args "$@"
    if [[ -n "$FAIL" ]]; then
      echo "\${FAIL_MSG:-fake gh failure}" >&2
      exit "\${FAIL_CODE:-1}"
    fi
    exit 0
    ;;
  *)
    echo "fake gh: unhandled command: $*" >&2
    exit 2
    ;;
esac
exit 0
`;

let workDir: string;
let fakeBinDir: string;
let repoDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "day2-approval-cli-test-"));
  fakeBinDir = join(workDir, "fakebin");
  mkdirSync(fakeBinDir);
  const ghScriptPath = join(fakeBinDir, "gh");
  writeFileSync(ghScriptPath, FAKE_GH_SCRIPT);
  chmodSync(ghScriptPath, 0o755);
  repoDir = join(workDir, "repo");
  mkdirSync(repoDir);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

let fileCounter = 0;
afterEach(() => {
  fileCounter++;
});

async function runApprovalCli(args: string[], env: Record<string, string | undefined> = {}) {
  const proc = Bun.spawn({
    cmd: ["bun", "run", APPROVAL_CLI_TS, ...args],
    env: { ...process.env, ...env, PATH: `${fakeBinDir}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function readArgs(argsFile: string): string[] {
  const raw = readFileSync(argsFile, "utf-8");
  return raw.split("\0").slice(0, -1);
}

describe("approval-cli.ts — argument validation", () => {
  test("missing --repo prints usage and exits 1", async () => {
    const { stderr, exitCode } = await runApprovalCli([]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Usage: bun run src\/approval-cli\.ts --repo <path>/);
  });

  test("--ask without a question text errors and exits 1, without ever calling gh", async () => {
    const { stderr, exitCode } = await runApprovalCli(["--repo", repoDir, "--ask", "7"]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/--ask requires a question/);
  });
});

describe("approval-cli.ts — default (list) mode", () => {
  test("no open day2-fix-* PRs: reports nothing pending", async () => {
    const { stdout, exitCode } = await runApprovalCli(["--repo", repoDir], { OUT_PR_LIST: "[]" });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Nothing pending — no open day2-fix-\* PRs\./);
  });

  test("filters to only day2-fix-* branches and renders a card per matching PR", async () => {
    const prList = JSON.stringify([
      {
        number: 101,
        title: "Fix: crash on empty cart",
        headRefName: "day2-fix-empty-cart-abc12345",
        url: "https://github.com/example/repo/pull/101",
        body: "## What happened\nUsers crashed on an empty cart.\n\n## What changed\nAdded a null check.\n\n## Evidence\nStack trace matched.\n\n---\n_disclaimer_",
      },
      {
        number: 202,
        title: "Unrelated human PR",
        headRefName: "feature/not-a-day2-fix",
        url: "https://github.com/example/repo/pull/202",
        body: "irrelevant",
      },
    ]);
    const prView = JSON.stringify({ files: [{ path: "src/cart.ts" }] });

    const { stdout, exitCode } = await runApprovalCli(["--repo", repoDir], {
      OUT_PR_LIST: prList,
      OUT_PR_VIEW: prView,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Fix: crash on empty cart/);
    expect(stdout).toMatch(/Users crashed on an empty cart\./);
    expect(stdout).not.toMatch(/Unrelated human PR/);
  });
});

describe("approval-cli.ts — --apply", () => {
  test("merges the given PR number via `gh pr merge <n> --squash` and confirms", async () => {
    const argsFile = join(workDir, `apply-args-${fileCounter}.bin`);
    const { stdout, exitCode } = await runApprovalCli(["--repo", repoDir, "--apply", "55"], {
      GH_ARGS_FILE: argsFile,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Applied \(merged\) PR #55\./);
    expect(readArgs(argsFile)).toEqual(["pr", "merge", "55", "--squash"]);
  });

  test("a failing gh pr merge surfaces as a fatal error with a non-zero exit", async () => {
    const { stderr, exitCode } = await runApprovalCli(["--repo", repoDir, "--apply", "55"], {
      FAIL: "1",
      FAIL_MSG: "gh: pull request is not mergeable",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/\[day2-approval\] Fatal error:/);
  });
});

describe("approval-cli.ts — --undo", () => {
  test("closes the given PR number via `gh pr close <n>` without merging, and confirms", async () => {
    const argsFile = join(workDir, `undo-args-${fileCounter}.bin`);
    const { stdout, exitCode } = await runApprovalCli(["--repo", repoDir, "--undo", "55"], {
      GH_ARGS_FILE: argsFile,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Undone \(closed without merging\) PR #55\./);
    expect(readArgs(argsFile)).toEqual(["pr", "close", "55"]);
  });
});

describe("approval-cli.ts — --ask", () => {
  test("posts the question as a PR comment via `gh pr comment <n> --body <question>`", async () => {
    const argsFile = join(workDir, `ask-args-${fileCounter}.bin`);
    const { stdout, exitCode } = await runApprovalCli(
      ["--repo", repoDir, "--ask", "55", "Why not just revert?"],
      { GH_ARGS_FILE: argsFile },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Posted question on PR #55\./);
    expect(readArgs(argsFile)).toEqual(["pr", "comment", "55", "--body", "Why not just revert?"]);
  });
});
