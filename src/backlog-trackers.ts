import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  createTicket,
  putTicket,
  type ActivityEntry,
  type Backlog,
  type Priority,
  type Ticket,
  type TicketState,
  type TicketType,
  type TrackerLink,
  type TrackerSystem,
} from "./backlog";

/**
 * Two-way sync between an app's backlog and the team's JIRA or Linear.
 *
 * What moves: status and priority both ways; comments both ways for Linear
 * and day2 → JIRA for JIRA (JIRA comments stay in JIRA, as designed); and
 * optionally every day2 ticket is mirrored as a new issue. What's imported:
 * Linear issues of one team; JIRA issues of one project carrying the label
 * (default "day2") — never a whole JIRA instance.
 *
 * Conflicts: when the same field changed on both sides since the last sync,
 * the newer change wins and both values are written to the ticket's
 * activity. A priority the owner pinned in day2 always wins and is pushed
 * back to the tracker.
 *
 * Credentials are the customer's own tokens, kept in the operator-level
 * `.day2-integrations.json` (gitignored), never in the app's repo and never
 * returned by the API.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type LinearConfig = {
  apiKey: string;
  teamKey: string;
  /** Resolved from teamKey on first sync. */
  teamId?: string;
  mirror: boolean;
  lastSyncAt?: string;
  lastError?: string | null;
};

export type JiraConfig = {
  /** e.g. "https://acme.atlassian.net" */
  site: string;
  email: string;
  apiToken: string;
  projectKey: string;
  label: string;
  mirror: boolean;
  lastSyncAt?: string;
  lastError?: string | null;
};

export type AppIntegrations = { linear?: LinearConfig; jira?: JiraConfig };
export type IntegrationsFile = Record<string, AppIntegrations>;

export const INTEGRATIONS_FILENAME = ".day2-integrations.json";

export function loadIntegrations(file: string): IntegrationsFile {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf-8")) as IntegrationsFile;
}

export function saveIntegrations(file: string, data: IntegrationsFile): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** What the console may see — never a token. */
export function publicIntegrations(i: AppIntegrations | undefined) {
  return {
    linear: i?.linear
      ? { connected: true, teamKey: i.linear.teamKey, mirror: i.linear.mirror, lastSyncAt: i.linear.lastSyncAt ?? null, lastError: i.linear.lastError ?? null }
      : { connected: false as const },
    jira: i?.jira
      ? {
          connected: true,
          site: i.jira.site,
          projectKey: i.jira.projectKey,
          label: i.jira.label,
          mirror: i.jira.mirror,
          lastSyncAt: i.jira.lastSyncAt ?? null,
          lastError: i.jira.lastError ?? null,
        }
      : { connected: false as const },
  };
}

// ---------------------------------------------------------------------------
// Tracker clients
// ---------------------------------------------------------------------------

export type RemoteComment = { id: string; author: string; body: string; createdAt: string };

export type RemoteIssue = {
  id: string;
  key: string;
  url?: string;
  title: string;
  description: string;
  priority: Priority | null;
  /** Mapped into day2's states; null when the tracker's status has no
   * day2 equivalent. */
  state: TicketState | null;
  type: TicketType;
  updatedAt: string;
  comments: RemoteComment[];
};

export interface TrackerClient {
  system: TrackerSystem;
  /** Issues in scope changed after `since` (all in scope when omitted). */
  listChanged(since?: string): Promise<RemoteIssue[]>;
  create(t: Ticket): Promise<RemoteIssue>;
  update(id: string, change: { priority?: Priority | null; state?: TicketState }): Promise<{ updatedAt: string }>;
  addComment(id: string, body: string): Promise<{ id: string }>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function readJson(res: Response, what: string): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// ---- Linear (GraphQL) ----

const LINEAR_ISSUE_FIELDS = `id identifier url title description priority updatedAt
  state { id name type }
  labels { nodes { name } }
  comments(first: 50) { nodes { id body createdAt user { name } } }`;

type LinearIssueNode = {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  priority: number;
  updatedAt: string;
  state: { id: string; name: string; type: string };
  labels?: { nodes: Array<{ name: string }> };
  comments?: { nodes: Array<{ id: string; body: string; createdAt: string; user: { name: string } | null }> };
};

export function linearStateToDay2(type: string): TicketState | null {
  if (type === "triage" || type === "backlog" || type === "unstarted") return "todo";
  if (type === "started") return "doing";
  if (type === "completed") return "done";
  if (type === "canceled") return "parked";
  return null;
}

export function linearPriorityToDay2(p: number): Priority | null {
  return p >= 1 && p <= 4 ? (p as Priority) : null;
}

function typeFromLabels(names: string[]): TicketType {
  const l = names.map((n) => n.toLowerCase());
  if (l.some((n) => n.includes("bug"))) return "bug";
  if (l.some((n) => n.includes("feature"))) return "feature";
  if (l.some((n) => n.includes("improvement") || n.includes("enhancement"))) return "improvement";
  return "task";
}

export function linearClient(cfg: LinearConfig, fetchImpl: FetchLike = fetch): TrackerClient & { resolveTeam(): Promise<string> } {
  const gql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const res = await fetchImpl("https://api.linear.app/graphql", {
      method: "POST",
      // Personal API keys go in the header as-is (no "Bearer").
      headers: { "content-type": "application/json", authorization: cfg.apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await readJson(res, "Linear")) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) throw new Error(`Linear: ${body.errors.map((e) => e.message).join("; ")}`);
    return body.data as T;
  };
  let states: Array<{ id: string; name: string; type: string }> | null = null;
  const teamId = async () => {
    if (cfg.teamId) return cfg.teamId;
    const d = await gql<{ teams: { nodes: Array<{ id: string; key: string }> } }>(
      `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key } } }`,
      { key: cfg.teamKey },
    );
    const team = d.teams.nodes[0];
    if (!team) throw new Error(`Linear has no team with key "${cfg.teamKey}".`);
    cfg.teamId = team.id;
    return team.id;
  };
  const teamStates = async () => {
    if (states) return states;
    const d = await gql<{ team: { states: { nodes: Array<{ id: string; name: string; type: string }> } } }>(
      `query($id: String!) { team(id: $id) { states { nodes { id name type } } } }`,
      { id: await teamId() },
    );
    states = d.team.states.nodes;
    return states;
  };
  const toRemote = (n: LinearIssueNode): RemoteIssue => ({
    id: n.id,
    key: n.identifier,
    url: n.url,
    title: n.title,
    description: n.description ?? "",
    priority: linearPriorityToDay2(n.priority),
    state: linearStateToDay2(n.state.type),
    type: typeFromLabels(n.labels?.nodes.map((l) => l.name) ?? []),
    updatedAt: n.updatedAt,
    comments: (n.comments?.nodes ?? []).map((c) => ({ id: c.id, author: c.user?.name ?? "Linear", body: c.body, createdAt: c.createdAt })),
  });

  return {
    system: "linear",
    resolveTeam: teamId,
    async listChanged(since) {
      const out: RemoteIssue[] = [];
      let after: string | null = null;
      for (let page = 0; page < 20; page++) {
        const d: { issues: { nodes: LinearIssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await gql(
          `query($team: String!, $since: DateTimeOrDuration, $after: String) {
            issues(first: 50, after: $after, orderBy: updatedAt,
              filter: { team: { key: { eq: $team } }, updatedAt: { gt: $since } }) {
              nodes { ${LINEAR_ISSUE_FIELDS} }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { team: cfg.teamKey, since: since ?? "1970-01-01T00:00:00.000Z", after },
        );
        out.push(...d.issues.nodes.map(toRemote));
        if (!d.issues.pageInfo.hasNextPage) break;
        after = d.issues.pageInfo.endCursor;
      }
      return out;
    },
    async create(t) {
      const d = await gql<{ issueCreate: { issue: LinearIssueNode } }>(
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${LINEAR_ISSUE_FIELDS} } } }`,
        { input: { teamId: await teamId(), title: t.title, description: ticketBody(t), priority: t.priority } },
      );
      return toRemote(d.issueCreate.issue);
    },
    async update(id, change) {
      const input: Record<string, unknown> = {};
      if (change.priority !== undefined) input.priority = change.priority ?? 0;
      if (change.state !== undefined) {
        const wanted = change.state === "todo" ? ["unstarted", "backlog"] : change.state === "done" ? ["completed"] : change.state === "parked" ? ["canceled"] : ["started"];
        const all = await teamStates();
        const preferReview = change.state === "to_approve" ? all.find((s) => s.type === "started" && /review/i.test(s.name)) : undefined;
        const target = preferReview ?? wanted.map((w) => all.find((s) => s.type === w)).find(Boolean);
        if (target) input.stateId = target.id;
      }
      const d = await gql<{ issueUpdate: { issue: { updatedAt: string } } }>(
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { updatedAt } } }`,
        { id, input },
      );
      return { updatedAt: d.issueUpdate.issue.updatedAt };
    },
    async addComment(id, body) {
      const d = await gql<{ commentCreate: { comment: { id: string } } }>(
        `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`,
        { input: { issueId: id, body } },
      );
      return { id: d.commentCreate.comment.id };
    },
  };
}

// ---- JIRA Cloud (REST v3) ----

type AdfNode = { type: string; text?: string; content?: AdfNode[] };

export function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return typeof node === "string" ? node : "";
  const n = node as AdfNode;
  if (n.type === "text") return n.text ?? "";
  const inner = (n.content ?? []).map(adfToText);
  const block = ["paragraph", "heading", "listItem", "codeBlock", "blockquote"].includes(n.type);
  return inner.join(n.type === "bulletList" || n.type === "orderedList" || n.type === "doc" ? "\n" : "") + (block ? "\n" : "");
}

export function textToAdf(text: string): AdfNode & { version: 1 } {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return {
    version: 1,
    type: "doc",
    content: (paras.length ? paras : [""]).map((p) => ({ type: "paragraph", content: p ? [{ type: "text", text: p }] : [] })),
  };
}

const JIRA_TO_DAY2_PRIORITY: Record<string, Priority> = { highest: 1, high: 2, medium: 3, low: 4, lowest: 4 };
const DAY2_TO_JIRA_PRIORITY: Record<Priority, string> = { 1: "Highest", 2: "High", 3: "Medium", 4: "Low" };

export function jiraStatusToDay2(categoryKey: string | undefined): TicketState | null {
  if (categoryKey === "new") return "todo";
  if (categoryKey === "indeterminate") return "doing";
  if (categoryKey === "done") return "done";
  return null;
}

type JiraIssue = {
  id: string;
  key: string;
  fields: {
    summary: string;
    description?: unknown;
    priority?: { name: string } | null;
    status?: { statusCategory?: { key: string } };
    issuetype?: { name: string };
    updated: string;
    comment?: { comments: Array<{ id: string; body: unknown; created: string; author?: { displayName?: string } }> };
  };
};

export function jiraClient(cfg: JiraConfig, fetchImpl: FetchLike = fetch): TrackerClient {
  const base = cfg.site.replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString("base64")}`;
  const call = async (method: string, path: string, body?: unknown) =>
    readJson(
      await fetchImpl(`${base}${path}`, {
        method,
        headers: { authorization: auth, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }),
      `JIRA ${method} ${path.split("?")[0]}`,
    );
  const toRemote = (i: JiraIssue): RemoteIssue => {
    const t = (i.fields.issuetype?.name ?? "").toLowerCase();
    return {
      id: i.key,
      key: i.key,
      url: `${base}/browse/${i.key}`,
      title: i.fields.summary,
      description: adfToText(i.fields.description).trim(),
      priority: i.fields.priority ? (JIRA_TO_DAY2_PRIORITY[i.fields.priority.name.toLowerCase()] ?? null) : null,
      state: jiraStatusToDay2(i.fields.status?.statusCategory?.key),
      type: t.includes("bug") ? "bug" : t.includes("story") || t.includes("feature") || t.includes("epic") ? "feature" : t.includes("improvement") ? "improvement" : "task",
      updatedAt: new Date(i.fields.updated).toISOString(),
      comments: (i.fields.comment?.comments ?? []).map((c) => ({
        id: c.id,
        author: c.author?.displayName ?? "JIRA",
        body: adfToText(c.body).trim(),
        createdAt: new Date(c.created).toISOString(),
      })),
    };
  };
  const quote = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

  return {
    system: "jira",
    async listChanged(since) {
      const sinceJql = since ? ` AND updated >= ${quote(new Date(since).toISOString().slice(0, 16).replace("T", " "))}` : "";
      const jql = `project = ${quote(cfg.projectKey)} AND labels = ${quote(cfg.label)}${sinceJql} ORDER BY updated ASC`;
      const out: RemoteIssue[] = [];
      let nextPageToken: string | undefined;
      for (let page = 0; page < 20; page++) {
        const d = (await call("POST", "/rest/api/3/search/jql", {
          jql,
          fields: ["summary", "description", "priority", "status", "issuetype", "updated", "comment"],
          maxResults: 50,
          ...(nextPageToken ? { nextPageToken } : {}),
        })) as { issues: JiraIssue[]; nextPageToken?: string; isLast?: boolean };
        out.push(...d.issues.map(toRemote));
        if (d.isLast !== false || !d.nextPageToken) break;
        nextPageToken = d.nextPageToken;
      }
      return out;
    },
    async create(t) {
      const created = (await call("POST", "/rest/api/3/issue", {
        fields: {
          project: { key: cfg.projectKey },
          summary: t.title,
          description: textToAdf(ticketBody(t)),
          issuetype: { name: t.type === "bug" ? "Bug" : t.type === "feature" ? "Story" : "Task" },
          labels: [cfg.label],
          priority: { name: DAY2_TO_JIRA_PRIORITY[t.priority] },
        },
      })) as { key: string };
      return toRemote((await call("GET", `/rest/api/3/issue/${created.key}?fields=summary,description,priority,status,issuetype,updated,comment`)) as JiraIssue);
    },
    async update(id, change) {
      if (change.priority !== undefined && change.priority !== null) {
        await call("PUT", `/rest/api/3/issue/${id}`, { fields: { priority: { name: DAY2_TO_JIRA_PRIORITY[change.priority] } } });
      }
      if (change.state !== undefined && change.state !== "parked") {
        const want = change.state === "todo" ? "new" : change.state === "done" ? "done" : "indeterminate";
        const t = (await call("GET", `/rest/api/3/issue/${id}/transitions`)) as {
          transitions: Array<{ id: string; to: { statusCategory?: { key: string } } }>;
        };
        const tr = t.transitions.find((x) => x.to.statusCategory?.key === want);
        if (tr) await call("POST", `/rest/api/3/issue/${id}/transitions`, { transition: { id: tr.id } });
      }
      const after = (await call("GET", `/rest/api/3/issue/${id}?fields=updated`)) as JiraIssue;
      return { updatedAt: new Date(after.fields.updated).toISOString() };
    },
    async addComment(id, body) {
      const c = (await call("POST", `/rest/api/3/issue/${id}/comment`, { body: textToAdf(body) })) as { id: string };
      return { id: c.id };
    },
  };
}

function ticketBody(t: Ticket): string {
  const parts = [t.description];
  if (t.doneWhen.length) parts.push(`Done when:\n${t.doneWhen.map((d) => `- ${d}`).join("\n")}`);
  parts.push(`Tracked by day2 as ${t.id}.`);
  return parts.filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Sync (pure decisions + the calls)
// ---------------------------------------------------------------------------

/** Doing and To be approved are both "in progress" to a tracker. */
function bucket(s: TicketState | null | undefined): string | null {
  if (!s) return null;
  return s === "to_approve" ? "doing" : s;
}

const pl = (p: Priority | null | undefined) => (p ? `P${p}` : "no priority");
const NAMES: Record<TrackerSystem, string> = { linear: "Linear", jira: "JIRA" };

export type SyncReport = { system: TrackerSystem; imported: number; pulled: number; pushed: number; mirrored: number; conflicts: number; comments: number };

function link(t: Ticket, system: TrackerSystem): TrackerLink | undefined {
  return t.trackers.find((l) => l.system === system);
}

function withLink(t: Ticket, l: TrackerLink): Ticket {
  return { ...t, trackers: [...t.trackers.filter((x) => x.system !== l.system), l] };
}

function log(t: Ticket, entry: Omit<ActivityEntry, "at">, at: string): Ticket {
  return { ...t, activity: [...t.activity, { ...entry, at }] };
}

export async function syncTracker(
  backlog: Backlog,
  client: TrackerClient,
  opts: { mirror: boolean; commentsBothWays: boolean; lastSyncAt?: string; now: Date },
): Promise<{ backlog: Backlog; report: SyncReport }> {
  const system = client.system;
  const name = NAMES[system];
  const at = opts.now.toISOString();
  const report: SyncReport = { system, imported: 0, pulled: 0, pushed: 0, mirrored: 0, conflicts: 0, comments: 0 };
  let b = backlog;

  const remote = await client.listChanged(opts.lastSyncAt);
  for (const r of remote) {
    const existing = b.tickets.find((t) => link(t, system)?.id === r.id);
    if (!existing) {
      if (r.state === "done" || r.state === "parked") continue;
      const created = createTicket(
        b,
        {
          title: r.title,
          type: r.type,
          description: r.description,
          ...(r.priority ? { priority: r.priority, prioritySource: system } : {}),
          source: { kind: system, key: r.id, ref: r.key, url: r.url },
          state: r.state ?? "todo",
          actor: system,
          createdNote: `Imported from ${name} ${r.key}.`,
        },
        opts.now,
      );
      b = putTicket(
        created.backlog,
        withLink(created.ticket, {
          system,
          id: r.id,
          key: r.key,
          url: r.url,
          remoteUpdatedAt: r.updatedAt,
          syncedPriority: r.priority,
          syncedState: r.state ?? "todo",
          seenCommentIds: r.comments.map((c) => c.id),
          lastSyncedAt: at,
        }),
      );
      report.imported++;
      continue;
    }

    let t = existing;
    const l = { ...link(t, system)! };
    const localNewer = new Date(t.updatedAt).getTime() > new Date(r.updatedAt).getTime();

    // Priority
    const remoteP = r.priority !== l.syncedPriority;
    const localP = t.priority !== l.syncedPriority;
    if (remoteP && r.priority !== null && r.priority !== t.priority) {
      if (t.pinned) {
        t = log(t, { actor: "day2", kind: "sync", text: `${name} changed priority to ${pl(r.priority)}; your pinned ${pl(t.priority)} was kept and sent back.` }, at);
      } else if (localP && localNewer) {
        report.conflicts++;
        t = log(t, { actor: "day2", kind: "conflict", text: `Priority changed on both sides — here ${pl(t.priority)}, in ${name} ${pl(r.priority)}. Kept ${pl(t.priority)} (newer).` }, at);
      } else {
        if (localP) {
          report.conflicts++;
          t = log(t, { actor: "day2", kind: "conflict", text: `Priority changed on both sides — here ${pl(t.priority)}, in ${name} ${pl(r.priority)}. Kept ${pl(r.priority)} (newer).` }, at);
        }
        t = log({ ...t, priority: r.priority, prioritySource: system, pinned: false, updatedAt: at }, { actor: system, kind: "priority", text: `changed priority ${pl(existing.priority)} → ${pl(r.priority)}.` }, at);
        l.syncedPriority = r.priority;
        report.pulled++;
      }
    } else if (remoteP) {
      l.syncedPriority = r.priority;
    }

    // State
    const remoteS = bucket(r.state) !== bucket(l.syncedState);
    const localS = bucket(t.state) !== bucket(l.syncedState);
    if (remoteS && r.state && bucket(r.state) !== bucket(t.state)) {
      if (localS && localNewer) {
        report.conflicts++;
        t = log(t, { actor: "day2", kind: "conflict", text: `Status changed on both sides — kept “${t.state}” here (newer) over “${r.state}” in ${name}.` }, at);
      } else {
        if (localS) report.conflicts++;
        t = log({ ...t, state: r.state, ...(r.state === "done" ? { doneAt: at } : {}), updatedAt: at }, { actor: system, kind: "state", text: `moved it to ${r.state === "todo" ? "To do" : r.state === "doing" ? "Doing" : r.state === "done" ? "Done" : "Parked"} in ${name}.` }, at);
        l.syncedState = r.state;
        report.pulled++;
      }
    } else if (remoteS && r.state) {
      l.syncedState = r.state;
    }

    // Comments into day2
    const seen = new Set(l.seenCommentIds ?? []);
    for (const c of r.comments) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if (!opts.commentsBothWays) continue;
      if (c.body.includes("— sent from day2")) continue;
      t = log(t, { actor: system, name: c.author, kind: "comment", text: c.body.slice(0, 2000) }, c.createdAt);
      report.comments++;
    }
    l.seenCommentIds = [...seen];
    l.remoteUpdatedAt = r.updatedAt;
    l.lastSyncedAt = at;
    b = putTicket(b, withLink(t, l));
  }

  // Push local changes on linked tickets.
  for (const t0 of b.tickets) {
    const l = link(t0, system);
    if (!l) continue;
    let t = t0;
    const nl = { ...l };
    const change: { priority?: Priority; state?: TicketState } = {};
    if (t.priority !== l.syncedPriority && (l.syncedPriority !== null || t.prioritySource !== system)) change.priority = t.priority;
    if (bucket(t.state) !== bucket(l.syncedState) && !(system === "jira" && t.state === "parked")) change.state = t.state;
    if (change.priority !== undefined || change.state !== undefined) {
      const res = await client.update(l.id, change);
      if (change.priority !== undefined) nl.syncedPriority = change.priority;
      if (change.state !== undefined) nl.syncedState = change.state;
      nl.remoteUpdatedAt = res.updatedAt;
      report.pushed++;
    }
    // Comments out: owner comments not yet sent to this tracker.
    const activity: ActivityEntry[] = [];
    for (const a of t.activity) {
      if (a.kind === "comment" && a.actor === "user" && !a.sentTo?.includes(system)) {
        const c = await client.addComment(l.id, `${a.text}\n\n— sent from day2 (${t.id}) by ${a.name ?? "the owner"}`);
        nl.seenCommentIds = [...(nl.seenCommentIds ?? []), c.id];
        activity.push({ ...a, sentTo: [...(a.sentTo ?? []), system] });
        report.comments++;
      } else activity.push(a);
    }
    t = { ...t, activity };
    nl.lastSyncedAt = at;
    b = putTicket(b, withLink(t, nl));
  }

  // Mirror day2's own tickets as new issues.
  if (opts.mirror) {
    for (const t of b.tickets) {
      if (link(t, system) || t.state === "done" || t.state === "parked") continue;
      if (t.source.kind === "linear" || t.source.kind === "jira") continue;
      const r = await client.create(t);
      const mirrored = log(
        withLink(t, {
          system,
          id: r.id,
          key: r.key,
          url: r.url,
          remoteUpdatedAt: r.updatedAt,
          syncedPriority: t.priority,
          syncedState: t.state,
          seenCommentIds: r.comments.map((c) => c.id),
          lastSyncedAt: at,
        }),
        { actor: "day2", kind: "sync", text: `Mirrored to ${name} as ${r.key}.` },
        at,
      );
      b = putTicket(b, mirrored);
      report.mirrored++;
    }
  }

  return { backlog: b, report };
}

/** For tests and the console: a short description of a sync. */
export function describeSync(r: SyncReport): string {
  const parts = [
    r.imported && `${r.imported} imported`,
    r.pulled && `${r.pulled} updated from ${NAMES[r.system]}`,
    r.pushed && `${r.pushed} sent to ${NAMES[r.system]}`,
    r.mirrored && `${r.mirrored} mirrored`,
    r.comments && `${r.comments} comments`,
    r.conflicts && `${r.conflicts} conflicts (newest kept)`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing changed";
}

