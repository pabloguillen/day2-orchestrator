import { describe, expect, test } from "bun:test";
import { createTicket, emptyBacklog, findTicket, updateTicket, addActivity, type Backlog, type Priority, type Ticket, type TicketState } from "./backlog";
import {
  adfToText,
  describeSync,
  jiraClient,
  linearClient,
  linearPriorityToDay2,
  linearStateToDay2,
  publicIntegrations,
  syncTracker,
  textToAdf,
  type RemoteIssue,
  type TrackerClient,
} from "./backlog-trackers";

const t0 = new Date("2026-10-10T10:00:00Z");
const t1 = new Date("2026-10-10T11:00:00Z");
const t2 = new Date("2026-10-10T12:00:00Z");

/** In-memory tracker that records what day2 sent it. */
function fakeTracker(system: "linear" | "jira", issues: RemoteIssue[]) {
  const calls: Array<{ kind: string; id?: string; body?: unknown }> = [];
  let n = 100;
  const client: TrackerClient = {
    system,
    async listChanged(since) {
      return issues.filter((i) => !since || i.updatedAt > since);
    },
    async create(t: Ticket) {
      const r: RemoteIssue = { id: `id-${n}`, key: `EXP-${n++}`, title: t.title, description: "", priority: t.priority, state: "todo", type: t.type, updatedAt: t2.toISOString(), comments: [] };
      calls.push({ kind: "create", body: t.title });
      issues.push(r);
      return r;
    },
    async update(id, change) {
      calls.push({ kind: "update", id, body: change });
      return { updatedAt: t2.toISOString() };
    },
    async addComment(id, body) {
      calls.push({ kind: "comment", id, body });
      return { id: `c-${n++}` };
    },
  };
  return { client, calls, issues };
}

const issue = (over: Partial<RemoteIssue> = {}): RemoteIssue => ({
  id: "lin-1",
  key: "EXP-112",
  url: "https://linear.app/x/issue/EXP-112",
  title: "Update privacy policy link",
  description: "Footer link is stale",
  priority: 3,
  state: "todo",
  type: "task",
  updatedAt: t0.toISOString(),
  comments: [],
  ...over,
});

async function imported(): Promise<{ backlog: Backlog; tracker: ReturnType<typeof fakeTracker> }> {
  const tracker = fakeTracker("linear", [issue()]);
  const r = await syncTracker(emptyBacklog(), tracker.client, { mirror: false, commentsBothWays: true, now: t0 });
  return { backlog: r.backlog, tracker };
}

describe("syncTracker", () => {
  test("imports issues in scope as tickets with the tracker's priority (not pinned)", async () => {
    const { backlog } = await imported();
    const t = backlog.tickets[0]!;
    expect(t).toMatchObject({ title: "Update privacy policy link", priority: 3, pinned: false, prioritySource: "linear", source: { kind: "linear", ref: "EXP-112" } });
    expect(t.trackers[0]).toMatchObject({ system: "linear", key: "EXP-112", syncedPriority: 3, syncedState: "todo" });
    expect(t.activity[0]!.text).toBe("Imported from Linear EXP-112.");
  });

  test("a remote change is pulled; a local change is pushed", async () => {
    const { backlog, tracker } = await imported();
    tracker.issues[0] = issue({ priority: 1, updatedAt: t1.toISOString() });
    const pulled = await syncTracker(backlog, tracker.client, { mirror: false, commentsBothWays: true, lastSyncAt: t0.toISOString(), now: t1 });
    expect(pulled.backlog.tickets[0]!.priority).toBe(1);
    expect(pulled.report.pulled).toBe(1);

    const local = updateTicket(pulled.backlog, "D2-1", { state: "done" }, t2).backlog;
    const pushed = await syncTracker(local, tracker.client, { mirror: false, commentsBothWays: true, lastSyncAt: t1.toISOString(), now: t2 });
    expect(tracker.calls.filter((c) => c.kind === "update")).toEqual([{ kind: "update", id: "lin-1", body: { state: "done" } }]);
    expect(pushed.backlog.tickets[0]!.trackers[0]!.syncedState).toBe("done");
  });

  test("both sides changed: the newer change wins and both are written down", async () => {
    const { backlog, tracker } = await imported();
    // Local change at t2 (newer) vs remote change at t1.
    const local = updateTicket(backlog, "D2-1", { title: "x" }, t2).backlog;
    const withLocalPriority = { ...local, tickets: local.tickets.map((t) => ({ ...t, priority: 2 as Priority, updatedAt: t2.toISOString() })) };
    tracker.issues[0] = issue({ priority: 4, updatedAt: t1.toISOString() });
    const r = await syncTracker(withLocalPriority, tracker.client, { mirror: false, commentsBothWays: true, lastSyncAt: t0.toISOString(), now: t2 });
    expect(r.report.conflicts).toBe(1);
    expect(r.backlog.tickets[0]!.priority).toBe(2);
    expect(r.backlog.tickets[0]!.activity.some((a) => a.kind === "conflict" && a.text.includes("here P2, in Linear P4") && a.text.includes("Kept P2"))).toBe(true);
    expect(tracker.calls).toContainEqual({ kind: "update", id: "lin-1", body: { priority: 2 } });
  });

  test("an owner's pinned priority wins and is sent back", async () => {
    const { backlog, tracker } = await imported();
    const pinned = updateTicket(backlog, "D2-1", { priority: 1 }, t0).backlog;
    tracker.issues[0] = issue({ priority: 4, updatedAt: t1.toISOString() });
    const r = await syncTracker(pinned, tracker.client, { mirror: false, commentsBothWays: true, lastSyncAt: t0.toISOString(), now: t1 });
    expect(findTicket(r.backlog, "D2-1")!.priority).toBe(1);
    expect(tracker.calls).toContainEqual({ kind: "update", id: "lin-1", body: { priority: 1 } });
  });

  test("comments: new tracker comments come in once; owner comments go out once", async () => {
    const { backlog, tracker } = await imported();
    tracker.issues[0] = issue({ updatedAt: t1.toISOString(), comments: [{ id: "c1", author: "Ana", body: "Seeing this in Madrid too.", createdAt: t1.toISOString() }] });
    const withComment = addActivity(backlog, "D2-1", { actor: "user", name: "Pablo", kind: "comment", text: "On it next week." }, t1);
    const r1 = await syncTracker(withComment, tracker.client, { mirror: false, commentsBothWays: true, lastSyncAt: t0.toISOString(), now: t1 });
    const acts = findTicket(r1.backlog, "D2-1")!.activity;
    expect(acts.filter((a) => a.actor === "linear" && a.kind === "comment").map((a) => [a.name, a.text])).toEqual([["Ana", "Seeing this in Madrid too."]]);
    expect(tracker.calls.filter((c) => c.kind === "comment")).toHaveLength(1);
    expect(String(tracker.calls.find((c) => c.kind === "comment")!.body)).toContain("On it next week.");
    const r2 = await syncTracker(r1.backlog, tracker.client, { mirror: false, commentsBothWays: true, lastSyncAt: t0.toISOString(), now: t2 });
    expect(tracker.calls.filter((c) => c.kind === "comment")).toHaveLength(1);
    expect(findTicket(r2.backlog, "D2-1")!.activity.filter((a) => a.kind === "comment" && a.actor === "linear")).toHaveLength(1);
  });

  test("JIRA comments stay in JIRA when comments only go one way", async () => {
    const tracker = fakeTracker("jira", [issue({ id: "EB-1", key: "EB-1", comments: [{ id: "j1", author: "Ana", body: "hi", createdAt: t0.toISOString() }] })]);
    const first = await syncTracker(emptyBacklog(), tracker.client, { mirror: false, commentsBothWays: false, now: t0 });
    tracker.issues[0] = { ...tracker.issues[0]!, updatedAt: t1.toISOString(), comments: [...tracker.issues[0]!.comments, { id: "j2", author: "Ana", body: "more", createdAt: t1.toISOString() }] };
    const r = await syncTracker(first.backlog, tracker.client, { mirror: false, commentsBothWays: false, lastSyncAt: t0.toISOString(), now: t1 });
    expect(r.backlog.tickets[0]!.activity.filter((a) => a.kind === "comment")).toEqual([]);
  });

  test("mirroring creates issues for day2's own open tickets only", async () => {
    let b = createTicket(emptyBacklog(), { title: "Ours", type: "bug", source: { kind: "sentry", key: "1" } }, t0).backlog;
    b = createTicket(b, { title: "Theirs", type: "task", source: { kind: "jira", key: "EB-9" } }, t0).backlog;
    b = createTicket(b, { title: "Done", type: "task", source: { kind: "user" }, state: "done" as TicketState }, t0).backlog;
    const tracker = fakeTracker("linear", []);
    const r = await syncTracker(b, tracker.client, { mirror: true, commentsBothWays: true, now: t0 });
    expect(tracker.calls.filter((c) => c.kind === "create").map((c) => c.body)).toEqual(["Ours"]);
    expect(findTicket(r.backlog, "D2-1")!.activity.at(-1)!.text).toBe("Mirrored to Linear as EXP-100.");
    expect(describeSync(r.report)).toBe("1 mirrored");
    const again = await syncTracker(r.backlog, tracker.client, { mirror: true, commentsBothWays: true, lastSyncAt: t0.toISOString(), now: t1 });
    expect(again.report.mirrored).toBe(0);
  });

  test("done or cancelled issues aren't imported", async () => {
    const tracker = fakeTracker("linear", [issue({ state: "done" }), issue({ id: "2", key: "EXP-2", state: "parked" })]);
    const r = await syncTracker(emptyBacklog(), tracker.client, { mirror: false, commentsBothWays: true, now: t0 });
    expect(r.backlog.tickets).toEqual([]);
  });
});

describe("Linear client", () => {
  test("sends the personal key as-is and maps states and priorities", async () => {
    const requests: Array<{ url: string; auth: string; body: { query: string; variables: Record<string, unknown> } }> = [];
    const fetchFake = async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ url, auth: (init?.headers as Record<string, string>).authorization, body });
      if (body.query.includes("teams(")) return Response.json({ data: { teams: { nodes: [{ id: "team-1", key: "EXP" }] } } });
      if (body.query.includes("issues(")) {
        return Response.json({
          data: {
            issues: {
              nodes: [
                {
                  id: "i1",
                  identifier: "EXP-1",
                  url: "u",
                  title: "T",
                  description: null,
                  priority: 0,
                  updatedAt: t0.toISOString(),
                  state: { id: "s", name: "In Progress", type: "started" },
                  labels: { nodes: [{ name: "Bug" }] },
                  comments: { nodes: [{ id: "c", body: "b", createdAt: t0.toISOString(), user: null }] },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      return Response.json({ errors: [{ message: "nope" }] });
    };
    const c = linearClient({ apiKey: "lin_api_x", teamKey: "EXP", mirror: true }, fetchFake as typeof fetch);
    const list = await c.listChanged();
    expect(requests[0]!.url).toBe("https://api.linear.app/graphql");
    expect(requests[0]!.auth).toBe("lin_api_x");
    expect(list[0]).toMatchObject({ key: "EXP-1", priority: null, state: "doing", type: "bug", comments: [{ author: "Linear" }] });
    expect(await c.resolveTeam()).toBe("team-1");
    await expect(c.addComment("i1", "x")).rejects.toThrow(/Linear: nope/);
    expect(linearStateToDay2("canceled")).toBe("parked");
    expect(linearPriorityToDay2(4)).toBe(4);
  });
});

describe("JIRA client", () => {
  test("searches with the new JQL endpoint scoped to project + label, with basic auth", async () => {
    const seen: Array<{ url: string; method?: string; auth: string; body?: unknown }> = [];
    const fetchFake = async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method, auth: (init?.headers as Record<string, string>).authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/rest/api/3/search/jql")) {
        return Response.json({
          isLast: true,
          issues: [
            {
              id: "1",
              key: "EB-48",
              fields: {
                summary: "Faster switching",
                description: textToAdf("First para.\n\nSecond para."),
                priority: { name: "High" },
                status: { statusCategory: { key: "indeterminate" } },
                issuetype: { name: "Story" },
                updated: "2026-10-10T10:00:00.000+0200",
                comment: { comments: [] },
              },
            },
          ],
        });
      }
      if (url.includes("/transitions") && init?.method === "GET") return Response.json({ transitions: [{ id: "31", to: { statusCategory: { key: "done" } } }] });
      if (url.includes("?fields=updated")) return Response.json({ id: "1", key: "EB-48", fields: { updated: "2026-10-10T11:00:00.000+0200", summary: "" } });
      return new Response("", { status: 204 });
    };
    const c = jiraClient({ site: "https://acme.atlassian.net/", email: "a@b.c", apiToken: "tok", projectKey: "EB", label: "day2", mirror: false }, fetchFake as typeof fetch);
    const list = await c.listChanged("2026-10-01T00:00:00.000Z");
    expect(seen[0]!.url).toBe("https://acme.atlassian.net/rest/api/3/search/jql");
    expect(seen[0]!.auth).toBe(`Basic ${Buffer.from("a@b.c:tok").toString("base64")}`);
    expect((seen[0]!.body as { jql: string }).jql).toBe('project = "EB" AND labels = "day2" AND updated >= "2026-10-01 00:00" ORDER BY updated ASC');
    expect(list[0]).toMatchObject({ key: "EB-48", priority: 2, state: "doing", type: "feature", url: "https://acme.atlassian.net/browse/EB-48" });
    expect(list[0]!.description).toBe("First para.\n\nSecond para.");
    const u = await c.update("EB-48", { state: "done", priority: 1 });
    expect(seen.some((s) => s.method === "PUT" && JSON.stringify(s.body).includes("Highest"))).toBe(true);
    expect(seen.some((s) => s.method === "POST" && JSON.stringify(s.body) === '{"transition":{"id":"31"}}')).toBe(true);
    expect(u.updatedAt).toBe("2026-10-10T09:00:00.000Z");
  });

  test("ADF converts both ways", () => {
    expect(adfToText(textToAdf("a\n\nb")).trim()).toBe("a\n\nb");
    expect(adfToText(null)).toBe("");
  });
});

describe("publicIntegrations", () => {
  test("never includes a token", () => {
    const p = publicIntegrations({
      linear: { apiKey: "secret-1", teamKey: "EXP", mirror: true },
      jira: { site: "https://a.atlassian.net", email: "e", apiToken: "secret-2", projectKey: "EB", label: "day2", mirror: false },
    });
    expect(JSON.stringify(p)).not.toMatch(/secret/);
    expect(p.linear).toMatchObject({ connected: true, teamKey: "EXP" });
    expect(publicIntegrations(undefined)).toEqual({ linear: { connected: false }, jira: { connected: false } });
  });
});
