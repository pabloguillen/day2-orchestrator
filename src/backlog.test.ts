import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareTickets,
  createTicket,
  deleteTicket,
  emptyBacklog,
  findTicket,
  ingest,
  loadBacklog,
  nextToStart,
  parseSettingsPatch,
  rankBacklog,
  saveBacklog,
  scoreTicket,
  updateTicket,
  withBacklog,
  type Backlog,
  type NewTicketInput,
} from "./backlog";

const now = new Date("2026-10-10T12:00:00Z");

function add(b: Backlog, input: Partial<NewTicketInput> & { title: string }): Backlog {
  return createTicket(b, { type: "bug", source: { kind: "user" }, ...input }, now).backlog;
}

describe("tickets", () => {
  test("ids count up, a picked priority is pinned, no priority means day2 decides", () => {
    let b = add(emptyBacklog(), { title: "A", priority: 2 });
    b = add(b, { title: "B" });
    const [a, bb] = b.tickets;
    expect(a).toMatchObject({ id: "D2-1", priority: 2, pinned: true, prioritySource: "user", state: "todo" });
    expect(bb).toMatchObject({ id: "D2-2", priority: 3, pinned: false, prioritySource: "day2" });
    expect(a!.activity[0]!.kind).toBe("created");
    expect(() => add(b, { title: "   " })).toThrow(/title/);
  });

  test("day2 can't change a pinned priority; the owner can, and can hand it back", () => {
    const b = add(emptyBacklog(), { title: "A", priority: 2 });
    const byDay2 = updateTicket(b, "D2-1", { priority: 1 }, now, { kind: "day2" });
    expect(byDay2.refused).toMatch(/pinned P2/);
    expect(findTicket(byDay2.backlog, "D2-1")!.priority).toBe(2);
    const byOwner = updateTicket(b, "D2-1", { priority: 4 }, now);
    expect(byOwner.ticket).toMatchObject({ priority: 4, pinned: true });
    const back = updateTicket(byOwner.backlog, "D2-1", { priority: null }, now);
    expect(back.ticket).toMatchObject({ pinned: false, prioritySource: "day2" });
    expect(back.ticket.activity.at(-1)!.text).toMatch(/handed the priority back/);
  });

  test("edits are logged; state changes clear progress and approval", () => {
    let b = add(emptyBacklog(), { title: "A" });
    b = updateTicket(b, "D2-1", { title: "A2", doneWhen: [" x ", ""], description: "d" }, now).backlog;
    const t = findTicket(b, "D2-1")!;
    expect(t.title).toBe("A2");
    expect(t.doneWhen).toEqual(["x"]);
    expect(t.activity.filter((a) => a.kind === "edit")).toHaveLength(3);
    const done = updateTicket(b, "D2-1", { state: "done" }, now).ticket;
    expect(done.doneAt).toBe(now.toISOString());
    expect(updateTicket(b, "D2-1", {}, now).ticket).toBe(t);
  });

  test("deleting forgets the source so it isn't imported again", () => {
    const item = { source: { kind: "sentry" as const, key: "42" }, title: "Crash", type: "bug" as const, description: "" };
    const first = ingest(emptyBacklog(), [item], now);
    const deleted = deleteTicket(first.backlog, first.created[0]!);
    expect(ingest(deleted, [item], now).created).toEqual([]);
  });
});

describe("ranking", () => {
  test("bugs hitting more than 10 people become P1 with the rule as the reason", () => {
    const b = add(emptyBacklog(), { title: "OCR", signals: { users: 23, errors: 41, errorsPrev: 12 } });
    const { backlog, changes } = rankBacklog(b, now);
    const t = backlog.tickets[0]!;
    expect(t.priority).toBe(1);
    expect(t.rankReason.rule).toBe("Bugs that affect more than 10 people are P1.");
    expect(t.rankReason.errors).toBe("41 error events this week, up from 12.");
    expect(changes).toEqual([{ id: "D2-1", from: 3, to: 1, reason: "Bugs that affect more than 10 people are P1." }]);
    expect(t.activity.at(-1)!.text).toMatch(/raised priority P3 → P1/);
  });

  test("pinned, signal-less and tracker priorities are left alone", () => {
    let b = add(emptyBacklog(), { title: "Pinned", priority: 4, signals: { users: 500 } });
    b = add(b, { title: "No signal" });
    b = createTicket(b, { title: "From Linear", type: "task", source: { kind: "linear", key: "x" }, priority: 2, prioritySource: "linear", signals: { competitor: "Rivals do it" } }, now).backlog;
    const r = rankBacklog(b, now);
    expect(r.changes).toEqual([]);
    expect(r.backlog.tickets.map((t) => t.priority)).toEqual([4, 3, 2]);
  });

  test("security problems are P1 and start even when the WIP limit is full", () => {
    let b = add(emptyBacklog(), { title: "Busy" });
    b = updateTicket(b, "D2-1", { state: "doing" }, now).backlog;
    b = add(b, { title: "Leak", signals: { security: true } });
    b = add(b, { title: "Normal", priority: 1 });
    b = { ...b, settings: { ...b.settings, wipLimit: 1 } };
    b = rankBacklog(b, now).backlog;
    expect(findTicket(b, "D2-2")!.priority).toBe(1);
    expect(nextToStart(b).map((t) => t.id)).toEqual(["D2-2"]);
  });

  test("auto-start follows the owner's choices and the WIP limit", () => {
    let b = add(emptyBacklog(), { title: "Bug P1", priority: 1 });
    b = add(b, { title: "Bug P3", priority: 3 });
    b = add(b, { title: "Feature", type: "feature", priority: 1 });
    b = add(b, { title: "Task", type: "task", priority: 2 });
    expect(nextToStart(b).map((t) => t.title)).toEqual(["Bug P1", "Task"]);
    const noTasks = { ...b, settings: { ...b.settings, autoStart: { ...b.settings.autoStart, tasks: false } } };
    expect(nextToStart(noTasks).map((t) => t.title)).toEqual(["Bug P1"]);
    const zero = { ...b, settings: { ...b.settings, wipLimit: 0 } };
    expect(nextToStart(zero)).toEqual([]);
  });

  test("no new signal for 60 days drops one priority, once per 60 days", () => {
    const old = new Date("2026-07-01T00:00:00Z");
    let b = createTicket(emptyBacklog(), { title: "Old", type: "improvement", source: { kind: "user" }, signals: { competitor: "x", updatedAt: old.toISOString() } }, old).backlog;
    b = rankBacklog(b, old).backlog;
    const before = b.tickets[0]!.priority;
    b = rankBacklog(b, now).backlog;
    expect(b.tickets[0]!.priority).toBe(Math.min(4, before + 1));
    const again = rankBacklog(b, new Date(now.getTime() + 86_400_000)).backlog;
    expect(again.tickets[0]!.priority).toBe(b.tickets[0]!.priority);
  });

  test("score follows the owner's weights", () => {
    const b = add(emptyBacklog(), { title: "x", signals: { competitor: "y" } });
    const t = b.tickets[0]!;
    const low = scoreTicket(t, { usage: 2, errors: 2, goals: 0, competition: 0, quickWins: 0 });
    const high = scoreTicket(t, { usage: 0, errors: 0, goals: 0, competition: 2, quickWins: 0 });
    expect(high).toBeGreaterThan(low);
  });

  test("board order: priority, then score, then oldest", () => {
    let b = add(emptyBacklog(), { title: "a", priority: 2 });
    b = add(b, { title: "b", priority: 1 });
    expect([...b.tickets].sort(compareTickets).map((t) => t.title)).toEqual(["b", "a"]);
  });
});

describe("ingest", () => {
  test("creates once, refreshes signals, notes when errors jump", () => {
    const item = (errors: number) => ({ source: { kind: "sentry" as const, key: "1", url: "https://s/1" }, title: "Crash", type: "bug" as const, description: "d", signals: { errors, users: 3 } });
    const a = ingest(emptyBacklog(), [item(10)], now);
    expect(a.created).toHaveLength(1);
    const b = ingest(a.backlog, [item(10)], now);
    expect(b.updated).toEqual([]);
    const c = ingest(b.backlog, [item(30)], now);
    expect(c.updated).toEqual(["D2-1"]);
    const t = c.backlog.tickets[0]!;
    expect(t.signals).toMatchObject({ errors: 30, errorsPrev: 10 });
    expect(t.activity.at(-1)!.text).toBe("errors went from 10 to 30 a week.");
  });
});

describe("settings", () => {
  test("validates weights, limits, auto-start and rules; built-ins can be switched off but not lost", () => {
    const s = emptyBacklog().settings;
    const next = parseSettingsPatch(
      { weights: { usage: 0 }, wipLimit: 3, autoStart: { features: true }, rules: [{ id: "r-bugs", enabled: false }, { text: "Bugs before features this week" }] },
      s,
    );
    expect(next.weights.usage).toBe(0);
    expect(next.wipLimit).toBe(3);
    expect(next.autoStart.features).toBe(true);
    expect(next.rules.find((r) => r.id === "r-bugs")!.enabled).toBe(false);
    expect(next.rules.find((r) => r.kind === "custom")!.text).toBe("Bugs before features this week");
    expect(next.rules.filter((r) => r.kind === "builtin")).toHaveLength(5);
    expect(() => parseSettingsPatch({ wipLimit: 11 }, s)).toThrow(/0 to 10/);
    expect(() => parseSettingsPatch({ weights: { usage: 3 } }, s)).toThrow(/low/);
    expect(() => parseSettingsPatch({ rules: [{ text: " " }] }, s)).toThrow(/words/);
    expect(() => parseSettingsPatch({ sentry: { org: "a" } }, s)).toThrow(/project/);
  });
});

describe("store", () => {
  const dir = mkdtempSync(join(tmpdir(), "day2-backlog-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("missing file is an empty backlog; round-trips; concurrent edits don't lose each other", async () => {
    const file = join(dir, "day2-backlog.json");
    expect(loadBacklog(file).tickets).toEqual([]);
    saveBacklog(file, add(emptyBacklog(), { title: "A" }));
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => withBacklog(file, (b) => ({ backlog: add(b, { title: `T${i}` }), result: null }))),
    );
    const b = loadBacklog(file);
    expect(b.tickets).toHaveLength(11);
    expect(new Set(b.tickets.map((t) => t.id)).size).toBe(11);
  });
});
