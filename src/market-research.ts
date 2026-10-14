import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { CompetitorAngleInsight } from "./competitor-feed";

/**
 * "What's working for competitors?" — the research runs an app's owner asks
 * for, kept in the app's repo next to its other day2 files. Each finding is
 * a real, cited competitor angle; any of them can become an experiment
 * (growth-bets.ts).
 */

export const MARKET_RESEARCH_FILENAME = "day2-market-research.json";
const KEEP_RUNS = 10;

export type ResearchRun = {
  id: string;
  at: string;
  /** What the research was about (from the app profile). */
  topic: string;
  /** Connected tools the agent had (e.g. ["Foreplay"]); empty = web only. */
  usedTools: string[];
  findings: Array<CompetitorAngleInsight & { id: string }>;
  credits: number;
};

export type ResearchLog = { runs: ResearchRun[] };

export function loadResearch(path: string): ResearchLog {
  if (!existsSync(path)) return { runs: [] };
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ResearchLog>;
  return { runs: Array.isArray(parsed.runs) ? parsed.runs : [] };
}

export function recordResearch(path: string, run: Omit<ResearchRun, "id" | "findings"> & { findings: CompetitorAngleInsight[] }): ResearchRun {
  const full: ResearchRun = {
    ...run,
    id: `r-${randomUUID().slice(0, 8)}`,
    findings: run.findings.map((f, i) => ({ ...f, id: `f${i + 1}` })),
  };
  const log = loadResearch(path);
  const next = { runs: [full, ...log.runs].slice(0, KEEP_RUNS) };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path);
  return full;
}

/** The research topic for an app: what it does and for whom. */
export function researchTopic(profile: { purpose: string; targetUsers: string }): string {
  const t = `${profile.purpose.trim()} (for ${profile.targetUsers.trim()})`;
  return t.length > 300 ? `${t.slice(0, 297)}…` : t;
}
