import { existsSync, readFileSync } from "node:fs";

/**
 * Renders the autonomy audit trail (`recordAutonomyAudit()` in autonomy.ts)
 * as a plain-language feed, per the source doc's "Daily feed" requirement
 * (p.14): "Fixed a checkout crash affecting 2% of Android users, shipped to
 * canary, no regressions." Read-only against the audit log; writes nothing.
 *
 * Readability today is capped by what's in the audit log: `summary` (a
 * human title for the underlying change) is optional and nothing populates
 * it yet — that needs whoever wires `maybeAutoRelease()` in release.ts to
 * start passing the original bug report's title through. Until then this
 * falls back to a file/area/reason description, honest but less readable
 * than the source doc's own example.
 */

export type AuditEntry = {
  timestamp: string;
  sourceId: string;
  area: string;
  filesChanged: string[];
  level: string;
  autoShip: boolean;
  reason: string;
  summary?: string;
};

export function loadAuditEntries(auditFile: string, since?: Date): AuditEntry[] {
  if (!existsSync(auditFile)) return [];
  const lines = readFileSync(auditFile, "utf-8").trim().split("\n").filter(Boolean);
  const entries = lines.map((l) => JSON.parse(l) as AuditEntry);
  return since ? entries.filter((e) => new Date(e.timestamp) >= since) : entries;
}

function reasonAsClause(reason: string): string {
  // Audit reasons are written as standalone sentences ("CI has not passed —
  // cannot auto-ship..."); fold the first clause into a trailing "because"
  // so it reads as one sentence instead of two blunt statements stapled
  // together.
  const firstClause = reason.split(/[—.]/)[0].trim();
  return firstClause.charAt(0).toLowerCase() + firstClause.slice(1);
}

export function renderEntry(entry: AuditEntry): string {
  const n = entry.filesChanged.length;
  const fileWord = n === 1 ? "file" : "files";

  if (entry.summary) {
    return entry.autoShip
      ? `Fixed ${entry.summary} — shipped automatically to canary (${entry.area}).`
      : `Fixed ${entry.summary} — opened for review (${entry.area}), ${reasonAsClause(entry.reason)}.`;
  }

  return entry.autoShip
    ? `Change touching ${n} ${fileWord} in ${entry.area} — shipped automatically to canary. ${entry.reason}`
    : `Change touching ${n} ${fileWord} in ${entry.area} — opened for review. ${entry.reason}`;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD
}

export function renderFeed(entries: AuditEntry[]): string {
  if (entries.length === 0) return "No changes recorded yet.";

  const sorted = [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const days = [...new Set(sorted.map((e) => dayKey(e.timestamp)))];

  return days
    .map((day) => {
      const dayEntries = sorted.filter((e) => dayKey(e.timestamp) === day);
      const lines = dayEntries.map((e) => `  - ${renderEntry(e)}`).join("\n");
      return `${day}\n${lines}`;
    })
    .join("\n\n");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    auditFile: get("--audit-file") ?? "day2-autonomy-audit.jsonl",
    since: get("--since"),
  };
}

function main() {
  const opts = parseArgs();
  const since = opts.since ? new Date(opts.since) : undefined;
  const entries = loadAuditEntries(opts.auditFile, since);
  console.log(renderFeed(entries));
}

if (import.meta.main) {
  main();
}
