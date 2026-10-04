import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BugReport } from "./types";

/**
 * pr.ts shells real `gh pr create`. Same pattern established in git.test.ts
 * (see the comment there for why): run `openFixPr` for real, inside a fresh
 * `bun` subprocess whose PATH points at a fake, scriptable `gh` executable.
 * This both proves the failure path (what `openFixPr` does when `gh pr
 * create` fails mid-pipeline) and lets us capture the exact argv `gh` was
 * invoked with, to verify the title/body/head/base wiring — the part of
 * this file that's pure string-formatting logic, previously entirely
 * unverified.
 */

const PR_TS = join(import.meta.dir, "pr.ts");

const FAKE_GH_SCRIPT = `#!/usr/bin/env bash
if [[ -n "$GH_ARGS_FILE" ]]; then
  : > "$GH_ARGS_FILE"
  for a in "$@"; do printf '%s\\0' "$a" >> "$GH_ARGS_FILE"; done
fi
if [[ -n "$FAIL" ]]; then
  echo "\${FAIL_MSG:-fake gh failure}" >&2
  exit "\${FAIL_CODE:-1}"
fi
printf '%b' "\${GH_OUT:-https://github.com/example/repo/pull/1}"
exit 0
`;

const HARNESS_SCRIPT = `
import { openFixPr } from ${JSON.stringify(PR_TS)};
const [cwd, branch, reportJson, agentSummary] = process.argv.slice(2);
const report = JSON.parse(reportJson);
try {
  const result = await openFixPr(cwd, branch, report, agentSummary);
  console.log(JSON.stringify({ ok: true, result }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }));
}
`;

let workDir: string;
let fakeBinDir: string;
let harnessPath: string;
let fakeCwd: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "day2-pr-test-"));
  fakeBinDir = join(workDir, "fakebin");
  mkdirSync(fakeBinDir);
  const ghScriptPath = join(fakeBinDir, "gh");
  writeFileSync(ghScriptPath, FAKE_GH_SCRIPT);
  chmodSync(ghScriptPath, 0o755);
  harnessPath = join(workDir, "run-pr-fn.ts");
  writeFileSync(harnessPath, HARNESS_SCRIPT);
  fakeCwd = join(workDir, "repo");
  mkdirSync(fakeCwd);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

type FnResult = { ok: true; result: string } | { ok: false; error: string };

async function runOpenFixPr(
  cwd: string,
  branch: string,
  report: BugReport,
  agentSummary: string,
  env: Record<string, string | undefined> = {},
): Promise<FnResult> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", harnessPath, cwd, branch, JSON.stringify(report), agentSummary],
    env: { ...process.env, ...env, PATH: `${fakeBinDir}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const lastLine = out.trim().split("\n").pop() ?? "";
  return JSON.parse(lastLine) as FnResult;
}

const sampleReport: BugReport = {
  title: "Login button doesn't work",
  description: "Users on Android can't log in after the last release.",
  sourceId: "abc12345",
  source: "sentry",
};

describe("openFixPr — success path", () => {
  test("returns the last non-empty line of gh's output (the PR URL), trimmed", async () => {
    const res = await runOpenFixPr(fakeCwd, "day2-fix-login-abc12345", sampleReport, "Fixed the null check.", {
      GH_OUT: "Creating pull request for day2-fix-login-abc12345 into main\\nhttps://github.com/example/repo/pull/42\\n",
    });
    expect(res).toEqual({ ok: true, result: "https://github.com/example/repo/pull/42" });
  });
});

describe("openFixPr — argument wiring", () => {
  test("calls `gh pr create` with the exact title/body/head/base day2 promises a human reviewer", async () => {
    const argsFile = join(workDir, "gh-args.bin");
    const branch = "day2-fix-login-abc12345";
    const agentSummary = "  Fixed the null check on login.  \n";
    const res = await runOpenFixPr(fakeCwd, branch, sampleReport, agentSummary, { GH_ARGS_FILE: argsFile });
    expect(res.ok).toBe(true);

    const raw = readFileSync(argsFile, "utf-8");
    const argv = raw.split("\0").slice(0, -1);

    const expectedBody = [
      agentSummary.trim(),
      "",
      "---",
      `_Opened automatically by Day2 in response to a ${sampleReport.source} signal (${sampleReport.sourceId}). A human should review before merging — this is never auto-merged._`,
    ].join("\n");

    expect(argv).toEqual([
      "pr",
      "create",
      "--title",
      `Fix: ${sampleReport.title}`,
      "--body",
      expectedBody,
      "--head",
      branch,
      "--base",
      "main",
    ]);
  });

  test("never claims to merge anything — the PR body always carries the human-review disclaimer", async () => {
    const argsFile = join(workDir, "gh-args-2.bin");
    await runOpenFixPr(fakeCwd, "day2-fix-x", sampleReport, "Some summary", { GH_ARGS_FILE: argsFile });
    const raw = readFileSync(argsFile, "utf-8");
    const argv = raw.split("\0").slice(0, -1);
    const body = argv[argv.indexOf("--body") + 1];
    expect(body).toMatch(/never auto-merged/);
    expect(body).toMatch(/A human should review before merging/);
  });
});

describe("openFixPr — failure paths", () => {
  test("rejects when `gh pr create` fails mid-pipeline (e.g. auth expired, rate limited)", async () => {
    const res = await runOpenFixPr(fakeCwd, "day2-fix-x", sampleReport, "summary", {
      FAIL: "1",
      FAIL_MSG: "gh: authentication required",
      FAIL_CODE: "4",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/exit code/);
  });

  test("rejects when the given cwd doesn't exist (never silently falls back to some other directory)", async () => {
    const res = await runOpenFixPr(join(workDir, "does-not-exist"), "day2-fix-x", sampleReport, "summary");
    expect(res.ok).toBe(false);
  });
});
