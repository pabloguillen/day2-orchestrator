import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { deriveFilesChanged, loadAutonomyConfig } from "./auto-release-cli";
import { DEFAULT_AUTONOMY_CONFIG } from "./autonomy";

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
});
