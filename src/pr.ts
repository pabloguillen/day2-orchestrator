import { $ } from "bun";
import type { BugReport } from "./types";

/**
 * Opens a PR via `gh`. Never merges — a human always reviews and clicks merge,
 * per the Stage 0 design: fixes are delivered as PRs, not autonomous merges,
 * until there's a track record that earns higher autonomy.
 */
export async function openFixPr(
  cwd: string,
  branch: string,
  report: BugReport,
  agentSummary: string,
): Promise<string> {
  const title = `Fix: ${report.title}`;
  const body = [
    agentSummary.trim(),
    "",
    "---",
    `_Opened automatically by Day2 in response to a ${report.source} signal (${report.sourceId}). A human should review before merging — this is never auto-merged._`,
  ].join("\n");

  const result =
    await $`gh pr create --title ${title} --body ${body} --head ${branch} --base main`
      .cwd(cwd)
      .text();

  const url = result.trim().split("\n").pop() ?? result.trim();
  return url;
}
