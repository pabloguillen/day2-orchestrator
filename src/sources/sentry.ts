import type { BugReport } from "../types";

/**
 * Fetches the most recent unresolved issue for a Sentry project and maps it to
 * a BugReport. NOTE: as of Stage 0, the only available Sentry auth token is
 * scoped to a single project (pintoo-ios) and returns 403 on every other
 * project/org-level endpoint, including this one. To use this against
 * expense-buddy (or any other project), generate a new token under the
 * pintoo-05 org (Settings -> Auth Tokens) with `project:read` + `event:read`
 * scoped to "All Projects", and set SENTRY_AUTH_TOKEN + SENTRY_REGION_URL.
 */
export async function fetchLatestUnresolvedIssue(
  org: string,
  project: string,
): Promise<BugReport | null> {
  const token = process.env.SENTRY_AUTH_TOKEN;
  const regionUrl = process.env.SENTRY_REGION_URL ?? "https://sentry.io";
  if (!token) {
    throw new Error("SENTRY_AUTH_TOKEN is not set — see comment at top of this file.");
  }

  const res = await fetch(
    `${regionUrl}/api/0/projects/${org}/${project}/issues/?query=is:unresolved&limit=1&sort=freq`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error(`Sentry API error ${res.status}: ${await res.text()}`);
  }

  const issues = (await res.json()) as Array<{
    id: string;
    title: string;
    culprit?: string;
    metadata?: { value?: string; type?: string };
    permalink: string;
    count: string;
  }>;

  const issue = issues[0];
  if (!issue) return null;

  return {
    title: issue.title,
    description: `Sentry issue affecting ${issue.count} event(s). Culprit: ${issue.culprit ?? "unknown"}. ${issue.metadata?.value ?? ""}`,
    context: `${issue.metadata?.type ?? ""}: ${issue.metadata?.value ?? ""}\nSentry link: ${issue.permalink}`,
    sourceId: issue.id,
    source: "sentry",
  };
}
