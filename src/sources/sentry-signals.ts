import type { Signal } from "../signals/types";

/**
 * General-purpose error-tracking scout — generic across every day2-managed
 * app (parameterized by org/project, never hardcoded to one). Extends
 * `sources/sentry.ts`'s original single-issue fetch (which only ever grabs
 * the single latest unresolved issue, no clustering/prioritization input)
 * into a real multi-issue signal source: enough real evidence per issue
 * (event count, affected-user count) for `cluster.ts` to prioritize
 * correctly, matching PostHog's own "revenue/affected-user impact" framing
 * for what makes a report P1 — the old function is left untouched since
 * `index.ts`/`onboarding.ts` still call it for their own narrower purpose.
 */

type SentryIssue = {
  id: string;
  title: string;
  culprit?: string;
  metadata?: { value?: string; type?: string };
  permalink: string;
  count: string;
  userCount: number;
  firstSeen: string;
};

export async function fetchUnresolvedIssuesAsSignals(
  appId: string,
  org: string,
  project: string,
  opts: { limit?: number } = {},
): Promise<Signal[]> {
  const token = process.env.SENTRY_AUTH_TOKEN;
  const regionUrl = process.env.SENTRY_REGION_URL ?? "https://sentry.io";
  if (!token) {
    throw new Error("SENTRY_AUTH_TOKEN is not set.");
  }

  const limit = opts.limit ?? 25;
  const res = await fetch(
    `${regionUrl}/api/0/projects/${org}/${project}/issues/?query=is:unresolved&limit=${limit}&sort=freq`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error(`Sentry API error ${res.status}: ${await res.text()}`);
  }

  const issues = (await res.json()) as SentryIssue[];
  return issues.map((issue) => ({
    id: `sentry-${issue.id}`,
    source: "sentry" as const,
    appId,
    at: issue.firstSeen,
    finding: issue.title,
    evidence: {
      culprit: issue.culprit ?? "unknown",
      type: issue.metadata?.type,
      value: issue.metadata?.value,
      permalink: issue.permalink,
    },
    occurrences: Number(issue.count) || 0,
    affectedUsers: issue.userCount ?? 0,
    path: issue.culprit, // Sentry's own "where" field, the closest generic proxy to a route/screen
    suggestedAction: `Investigate and fix: ${issue.title}`,
  }));
}
