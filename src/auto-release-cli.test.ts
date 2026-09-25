import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { deriveFilesChanged, loadAutonomyConfig, parseArgs } from "./auto-release-cli";
import { DEFAULT_AUTONOMY_CONFIG } from "./autonomy";

describe("parseArgs", () => {
  test("parses --summary as a single value even with embedded spaces (W8: PR titles are multi-word)", () => {
    // Mirrors how the value actually arrives: a shell array element like
    // `ARGS+=(--summary "$PR_TITLE")` hands this process one argv entry
    // containing the whole title, not a value that itself needs splitting —
    // same reasoning as --repo or --sha, unlike the comma-split
    // --files-changed.
    const original = process.argv;
    try {
      process.argv = [
        ...original.slice(0, 2),
        "--repo", "/tmp/x",
        "--sha", "abc123",
        "--summary", "Fix checkout crash on empty cart",
      ];
      expect(parseArgs().summary).toBe("Fix checkout crash on empty cart");
    } finally {
      process.argv = original;
    }
  });

  test("summary is undefined when --summary isn't passed", () => {
    const original = process.argv;
    try {
      process.argv = [...original.slice(0, 2), "--repo", "/tmp/x", "--sha", "abc123"];
      expect(parseArgs().summary).toBeUndefined();
    } finally {
      process.argv = original;
    }
  });
});

describe("loadAutonomyConfig", () => {
  test("falls back to DEFAULT_AUTONOMY_CONFIG (L2 everywhere) when no .day2-autonomy.json exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-autonomy-cfg-"));
    try {
      expect(loadAutonomyConfig(dir)).toEqual(DEFAULT_AUTONOMY_CONFIG);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads a repo's .day2-autonomy.json when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-autonomy-cfg-"));
    try {
      const custom = { defaultLevel: "L3", areas: [{ area: "ui", pathGlobs: ["src/*"], level: "L4" }] };
      writeFileSync(join(dir, ".day2-autonomy.json"), JSON.stringify(custom));
      expect(loadAutonomyConfig(dir)).toEqual(custom as any);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deriveFilesChanged", () => {
  test("lists the files touched by a real commit in a scratch repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-derive-files-"));
    try {
      await $`git init -q`.cwd(dir);
      await $`git config user.email test@example.com`.cwd(dir);
      await $`git config user.name test`.cwd(dir);
      writeFileSync(join(dir, "a.txt"), "one");
      await $`git add a.txt`.cwd(dir);
      await $`git commit -q -m init`.cwd(dir);

      writeFileSync(join(dir, "a.txt"), "two");
      writeFileSync(join(dir, "b.txt"), "new");
      await $`git add a.txt b.txt`.cwd(dir);
      await $`git commit -q -m change`.cwd(dir);

      const sha = (await $`git rev-parse HEAD`.cwd(dir).text()).trim();
      const files = await deriveFilesChanged(dir, sha);
      expect(files.sort()).toEqual(["a.txt", "b.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lists the files touched by a real merge commit — the actual GitHub-trigger shape", async () => {
    // A plain `git diff-tree <sha>` (no -m/-c) returns nothing for a merge
    // commit, since git doesn't know which parent to diff against by
    // default — this is exactly the bug a live auto-release.yml run
    // surfaced (filesChanged came back empty on a real PR merge). Every
    // real trigger for this function is a merge commit, so this case
    // matters more than the linear-history one above.
    const dir = mkdtempSync(join(tmpdir(), "day2-derive-files-merge-"));
    try {
      await $`git init -q -b main`.cwd(dir);
      await $`git config user.email test@example.com`.cwd(dir);
      await $`git config user.name test`.cwd(dir);
      writeFileSync(join(dir, "base.txt"), "base");
      await $`git add base.txt`.cwd(dir);
      await $`git commit -q -m init`.cwd(dir);

      await $`git checkout -q -b feature`.cwd(dir);
      writeFileSync(join(dir, "feature.txt"), "new");
      await $`git add feature.txt`.cwd(dir);
      await $`git commit -q -m "add feature file"`.cwd(dir);

      await $`git checkout -q main`.cwd(dir);
      await $`git merge -q --no-ff -m "Merge pull request #1 from x/feature" feature`.cwd(dir);

      const sha = (await $`git rev-parse HEAD`.cwd(dir).text()).trim();
      const files = await deriveFilesChanged(dir, sha);
      expect(files).toEqual(["feature.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
