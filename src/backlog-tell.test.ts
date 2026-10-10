import { describe, expect, test } from "bun:test";
import { createTicket, emptyBacklog, findTicket, type Backlog } from "./backlog";
import { applyTellPlan, buildTellPrompt, parseTellPlan, undoTell, validateInstruction } from "./backlog-tell";

const now = new Date("2026-10-10T12:00:00Z");

function seed(): Backlog {
  let b = emptyBacklog();
  b = createTicket(b, { title: "Receipt OCR misreads comma decimals", type: "bug", source: { kind: "sentry", key: "1" }, priority: 1, prioritySource: "day2" }, now).backlog;
  b = createTicket(b, { title: "Export to CSV", type: "feature", source: { kind: "user" }, priority: 2 }, now).backlog; // pinned
  b = createTicket(b, { title: "Recurring reminders", type: "feature", source: { kind: "day2_proposal", key: "x" } }, now).backlog;
  b = createTicket(b, { title: "Faster group switching", type: "improvement", source: { kind: "jira", key: "EB-48" } }, now).backlog;
  return b;
}

const PLAN = `Sure — here it is:
{"summary":"Readied the app for Spain.","operations":[
 {"op":"create","title":"Spanish launch","type":"feature","priority":2,"effort":"L","children":[
   {"title":"Move every UI text into a translation file","type":"task","priority":2,"effort":"S","doneWhen":["No hard-coded strings"]},
   {"title":"Spanish copy for all screens","type":"task","priority":2,"effort":"M"},
   {"title":"","type":"task"}
 ]},
 {"op":"reprioritize","id":"D2-1","priority":1,"reason":"moved to the top — Spanish receipts use commas."},
 {"op":"reprioritize","id":"D2-3","priority":3,"reason":"pushed back."},
 {"op":"reprioritize","id":"D2-2","priority":4},
 {"op":"edit","id":"D2-2","addDoneWhen":["Spanish column headers"]},
 {"op":"park","id":"D2-4","reason":"not needed for the launch."},
 {"op":"reprioritize","id":"D2-99","priority":1},
 {"op":"delete","id":"D2-1"},
 {"op":"question","text":"Which date do you launch?"}
]}`;

describe("parseTellPlan", () => {
  test("keeps only operations it can apply exactly", () => {
    const plan = parseTellPlan(PLAN)!;
    expect(plan.summary).toBe("Readied the app for Spain.");
    expect(plan.operations.map((o) => o.op)).toEqual(["create", "reprioritize", "reprioritize", "reprioritize", "edit", "park", "reprioritize", "question"]);
    const create = plan.operations[0] as { children: unknown[] };
    expect(create.children).toHaveLength(2);
    expect(parseTellPlan("no json here")).toBeNull();
    expect(parseTellPlan("{not json}")).toBeNull();
  });
});

describe("applyTellPlan", () => {
  test("creates and breaks down, re-ranks, edits, parks — and never moves a pin", () => {
    const { backlog, record } = applyTellPlan(seed(), parseTellPlan(PLAN)!, "We launch in Spain next month.", now);
    const kinds = record.changes.map((c) => c.kind);
    expect(kinds).toEqual(["created", "reranked", "reranked", "kept_pin", "edited", "parked", "skipped"]);
    expect(record.question).toEqual({ text: "Which date do you launch?" });

    const created = record.changes[0]!;
    expect(created.ticketIds).toHaveLength(3);
    expect(created.text).toBe("Spanish launch — feature, broken into 2 tickets.");
    const child = findTicket(backlog, created.ticketIds[1]!)!;
    expect(child.parentId).toBe(created.ticketIds[0]);
    expect(child.estimateCredits).toBeGreaterThan(0);
    expect(child.pinned).toBe(false);

    expect(record.changes[1]).toMatchObject({ note: "P1, unchanged" });
    expect(record.changes[2]).toMatchObject({ note: "P3, unchanged" });
    expect(findTicket(backlog, "D2-2")).toMatchObject({ priority: 2, pinned: true });
    expect(record.changes[3]).toMatchObject({ note: "Your P2 pin kept" });
    expect(findTicket(backlog, "D2-2")!.doneWhen).toContain("Spanish column headers");
    expect(record.changes[4]!.note).toBe("Your P2 pin kept");
    expect(findTicket(backlog, "D2-4")!.state).toBe("parked");
  });

  test("undo one change, then undo all — the backlog goes back exactly", () => {
    const before = seed();
    const applied = applyTellPlan(before, parseTellPlan(PLAN)!, "Spain", now);
    const parkIndex = applied.record.changes.findIndex((c) => c.kind === "parked");
    const one = undoTell(applied.backlog, applied.record, now, parkIndex);
    expect(findTicket(one.backlog, "D2-4")!.state).toBe("todo");
    expect(findTicket(one.backlog, "D2-4")!.activity.at(-1)!.text).toMatch(/undid/);
    expect(one.record.changes[parkIndex]!.undone).toBe(true);
    expect(findTicket(one.backlog, applied.record.changes[0]!.ticketIds[0]!)).toBeDefined();

    const all = undoTell(one.backlog, one.record, now);
    expect(all.backlog.tickets.map((t) => t.id)).toEqual(before.tickets.map((t) => t.id));
    for (const t of before.tickets) {
      const after = findTicket(all.backlog, t.id)!;
      expect({ ...after, activity: [], updatedAt: "" }).toEqual({ ...t, activity: [], updatedAt: "" });
    }
    expect(all.record.changes.filter((c) => c.undone).map((c) => c.kind)).toEqual(["created", "edited", "parked"]);
  });
});

describe("undo order", () => {
  test("re-rank then edit of the same ticket: Undo all restores both, and undoing just the re-rank keeps the edit", () => {
    let b = emptyBacklog();
    b = createTicket(b, { title: "Comma decimals", type: "bug", source: { kind: "user" } }, now).backlog;
    const plan = parseTellPlan('{"summary":"s","operations":[{"op":"reprioritize","id":"D2-1","priority":1},{"op":"edit","id":"D2-1","addDoneWhen":["12,50 parses"]}]}')!;
    const applied = applyTellPlan(b, plan, "Spain", now);
    expect(findTicket(applied.backlog, "D2-1")).toMatchObject({ priority: 1, doneWhen: ["12,50 parses"] });
    const all = undoTell(applied.backlog, applied.record, now);
    expect(findTicket(all.backlog, "D2-1")).toMatchObject({ priority: 3, doneWhen: [] });
    const onlyRank = undoTell(applied.backlog, applied.record, now, 0);
    expect(findTicket(onlyRank.backlog, "D2-1")).toMatchObject({ priority: 3, doneWhen: ["12,50 parses"] });
  });
});

describe("prompt and validation", () => {
  test("fences outside text and the owner's words; leaves out done tickets", () => {
    let b = seed();
    b = { ...b, tickets: b.tickets.map((t) => (t.id === "D2-4" ? { ...t, state: "done" as const } : t)) };
    const p = buildTellPrompt({ instruction: "Bugs first", backlog: b, appName: "buddy", appContext: "Splits bills" });
    expect(p).toContain("<<<UNTRUSTED_BACKLOG_START>>>");
    expect(p).toContain("<<<OWNER_INSTRUCTION_START>>>\nBugs first\n<<<OWNER_INSTRUCTION_END>>>");
    expect(p).not.toContain("Faster group switching");
    expect(p).toContain("Bugs that affect more than 10 people are P1.");
  });

  test("instructions must be present and not too long", () => {
    expect(validateInstruction("  ")).toMatchObject({ ok: false });
    expect(validateInstruction("x".repeat(2001))).toMatchObject({ ok: false });
    expect(validateInstruction(" Park dark mode ")).toEqual({ ok: true, instruction: "Park dark mode" });
  });
});
