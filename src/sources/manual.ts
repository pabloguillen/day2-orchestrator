import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BugReport } from "../types";

/**
 * Reads a hand-written bug report from a text file — the same interface a
 * Sentry issue or a session-replay-derived report would fill. Useful for
 * testing the pipeline today without depending on Sentry API access, and for
 * the case where a friendly tester or the owner just describes what's wrong
 * in plain language (per the "in-app feedback widget" trigger path).
 */
export function loadManualReport(path: string): BugReport {
  const text = readFileSync(path, "utf-8").trim();
  const [title, ...rest] = text.split("\n");
  const sourceId = createHash("sha256").update(text).digest("hex").slice(0, 16);
  return {
    title: title ?? "Untitled bug report",
    description: rest.join("\n").trim() || (title ?? ""),
    sourceId,
    source: "manual",
  };
}
