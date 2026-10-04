import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAtRiskDeviceIds } from "./growth-winback-cli";

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "day2-winback-cli-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("resolveAtRiskDeviceIds", () => {
  test("parses a comma-separated --device-ids list, trimming whitespace", () => {
    expect(resolveAtRiskDeviceIds({ deviceIds: "a, b ,c" })).toEqual(["a", "b", "c"]);
  });

  test("drops empty entries from a trailing comma", () => {
    expect(resolveAtRiskDeviceIds({ deviceIds: "a,b," })).toEqual(["a", "b"]);
  });

  test("reads real device IDs from --device-ids-file, one per line, skipping blanks and comments", () => {
    withTmpDir((dir) => {
      const path = join(dir, "ids.txt");
      writeFileSync(path, "device-1\ndevice-2\n\n# a comment\ndevice-3\n");
      expect(resolveAtRiskDeviceIds({ deviceIdsFile: path })).toEqual(["device-1", "device-2", "device-3"]);
    });
  });

  test("--device-ids-file takes priority over --device-ids when both are given", () => {
    withTmpDir((dir) => {
      const path = join(dir, "ids.txt");
      writeFileSync(path, "file-device\n");
      expect(resolveAtRiskDeviceIds({ deviceIds: "inline-device", deviceIdsFile: path })).toEqual(["file-device"]);
    });
  });

  test("throws when a device-ids-file exists but contains no real IDs", () => {
    withTmpDir((dir) => {
      const path = join(dir, "empty.txt");
      writeFileSync(path, "\n# just a comment\n\n");
      expect(() => resolveAtRiskDeviceIds({ deviceIdsFile: path })).toThrow("no real device IDs");
    });
  });

  test("throws when neither --device-ids nor --device-ids-file is given", () => {
    expect(() => resolveAtRiskDeviceIds({})).toThrow(/required/);
  });
});
