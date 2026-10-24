import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "./apps-registry";
import { emptyBacklog, loadBacklog, saveBacklog, updateTicket } from "./backlog";
import { backlogFile } from "./backlog-work";
import { fileFieldStore, type UserActivity } from "./field-store";
import type { AppProfile } from "./onboarding";
import {
  computeSnapshot,
  identifyTicket,
  loadRetention,
  measureTreatment,
  nextTreatment,
  parseResearch,
  RETENTION_FILENAME,
  retentionView,
  rhythmFromUsage,
  treatmentTicket,
  updateTreatments,
  type RetentionResearch,
  type Treatment,
} from "./retention";
import { retentionPass } from "./retention-pass";
import { arm, hashUser } from "../packages/sensors/src/lifecycle";

const NOW = new Date("2026-10-24T15:00:00Z");
const DAY = 86_400_000;
const day = (ago: number) => new Date(NOW.getTime() - ago * DAY).toISOString().slice(0, 10);
const user = (id: string, ago: number[], firstAgo?: number): UserActivity => {
  const days = [...new Set(ago.map(day))].sort();
  return { user: hashUser("d2k_test", id), firstSeen: firstAgo !== undefined ? day(firstAgo) : days[0]!, lastSeen: days.at(-1)!, days };
};
const range = (from: number, to: number, step = 1) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
const many = (n: number, prefix: string, ago: (i: number) => number[]) => Array.from({ length: n }, (_, i) => user(`${prefix}${i}`, ago(i)));

describe("lifecycle states and return rates", () => {
  // A daily-habit app: 60 people every day, 30 who stopped 3 days ago,
  // 25 brand new today, 10 long gone.
  const users = [...many(60, "daily", () => range(0, 20)), ...many(30, "stopped", () => range(3, 20)), ...many(25, "new", () => [0])];
  const snap = computeSnapshot({ users, older: 10, productType: "habit", now: NOW });

  test("everyone in one state, in the rhythm usage shows", () => {
    expect(snap.rhythm).toBe("daily");
    expect(snap.rhythmFrom).toBe("usage");
    expect(snap.states).toEqual({ new: 25, current: 60, reactivated: 0, resurrected: 0, at_risk: 30, lapsing: 0, dormant: 10 });
    expect(snap.users).toBe(125);
  });
  test("where users are lost: the at-risk ones, not the current ones", () => {
    expect(snap.rates.current).toBe(1);
    expect(snap.rates.at_risk).toBe(0);
    expect(snap.lost.at_risk).toBe(30);
    expect(snap.leak).toBe("at_risk");
    expect(snap.status).toBe("ready");
    expect(snap.trend).toHaveLength(8);
  });
  test("rhythm: weekly users, and the product type when usage is too thin", () => {
    expect(rhythmFromUsage(many(25, "w", () => range(0, 70, 7)), NOW)).toBe("weekly");
    expect(rhythmFromUsage(many(25, "m", () => range(0, 100, 30)), NOW)).toBe("monthly");
    const thin = computeSnapshot({ users: [user("a", [0])], older: 0, productType: "episodic", now: NOW });
    expect(thin).toMatchObject({ rhythm: "monthly", rhythmFrom: "product_type", status: "collecting" });
    expect(computeSnapshot({ users: [], older: 0, productType: null, now: NOW }).status).toBe("no_users");
  });
});

const research: RetentionResearch = {
  id: "rr-1",
  at: NOW.toISOString(),
  category: "language-learning apps",
  productType: "habit",
  leaders: ["Duolingo", "Babbel"],
  credits: 30,
  ideas: [
    {
      id: "at_risk-streak-reminder",
      target: "at_risk",
      channel: "push",
      name: "Streak reminder",
      practice: "A reminder at the user's usual time about keeping their streak.",
      change: "Send a push at the user's usual practice hour when today's goal isn't met.",
      leaders: [{ app: "Duolingo", example: "Practice reminders", source: "https://blog.duolingo.com/" }],
    },
    {
      id: "back-welcome-back",
      target: "back",
      channel: "in_app",
      name: "Welcome back",
      practice: "An easy first lesson after a break.",
      change: "Start returning users with a short review.",
      leaders: [{ app: "Duolingo", example: "Welcome-back review", source: "https://blog.duolingo.com/" }],
    },
  ],
};

describe("research", () => {
  test("only cited, valid treatments; at most two per state", () => {
    const leaders = [{ app: "Duolingo", example: "x", source: "https://duolingo.com" }];
    const text = `done\nRETENTION_RESEARCH_JSON:\n${JSON.stringify({
      category: "language-learning apps",
      productType: "habit",
      leaders: ["Duolingo"],
      treatments: [
        { target: "at_risk", channel: "push", name: "Streak reminder", practice: "p", change: "c", leaders },
        { target: "at_risk", channel: "email", name: "Weekly recap", practice: "p", change: "c", leaders },
        { target: "at_risk", channel: "push", name: "Third", practice: "p", change: "c", leaders },
        { target: "back", channel: "in_app", name: "Uncited", practice: "p", change: "c", leaders: [] },
        { target: "everyone", channel: "push", name: "Bad target", practice: "p", change: "c", leaders },
      ],
    })}`;
    const r = parseResearch(text)!;
    expect(r.productType).toBe("habit");
    expect(r.ideas.map((i) => i.id)).toEqual(["at_risk-streak-reminder", "at_risk-weekly-recap"]);
    expect(parseResearch(text.replace('"habit"', '"social"'))).toBeNull();
  });
});

describe("treatments", () => {
  const users = [...many(60, "daily", () => range(0, 20)), ...many(30, "stopped", () => range(3, 20)), ...many(25, "back", () => [0, 15])];
  const snap = computeSnapshot({ users, older: 0, productType: "habit", now: NOW });

  test("the biggest leak first; the ticket asks for the holdout and reminder limits", () => {
    const idea = nextTreatment({ research: [research], treatments: [] }, snap, emptyBacklog())!;
    expect(idea.id).toBe("at_risk-streak-reminder");
    const t = treatmentTicket(idea, research, snap);
    expect(t.source.key).toBe("retention:at_risk-streak-reminder");
    expect(t.description).toContain('day2.treatment("at_risk-streak-reminder") === "on"');
    expect(t.description).toContain("mayNudge");
    expect(t.description).toContain("Duolingo: Practice reminders");
    expect(t.doneWhen).toContain('Held-out users (treatment "at_risk-streak-reminder") never get it');
  });

  // 3000 users enter "at risk" after the treatment shipped; treated ones come
  // back 50% of the time, held-out ones 20%.
  const shippedAgo = 30;
  const entering = (effect: "helps" | "hurts") =>
    Array.from({ length: 3000 }, (_, i) => {
      const id = hashUser("d2k_test", `p${i}`);
      const held = arm(id, "at_risk-streak-reminder") === "holdout";
      const comesBack = effect === "helps" ? (held ? i % 5 === 0 : i % 2 === 0) : held ? i % 2 === 0 : i % 5 === 0;
      // Active 25..22 days ago (so "at risk" at the boundary 20 days ago), back 19 days ago or not.
      const ago = [25, 24, 23, 22, 21, ...(comesBack ? [19.5] : [])];
      return { ...user(`p${i}`, ago), user: id };
    });
  const live: Treatment = {
    ...research.ideas[0]!,
    researchId: "rr-1",
    rhythm: "daily",
    holdout: 0.1,
    ticketId: "D2-90",
    createdAt: day(40),
    shippedAt: new Date(NOW.getTime() - shippedAgo * DAY).toISOString(),
    result: { state: "collecting", note: "" },
    undoTicketId: null,
  };

  test("measured against its holdout: better", () => {
    const r = measureTreatment(live, entering("helps"), NOW);
    expect(r.state).toBe("better");
    if (r.state === "better") {
      expect(r.treatedRate).toBeCloseTo(0.5, 1);
      expect(r.heldRate).toBeCloseTo(0.2, 1);
      expect(r.held).toBeGreaterThan(200);
      expect(r.note).toContain("with it");
    }
  });
  test("worse: a ticket to remove it", () => {
    const tickets = [{ ...emptyBacklog().tickets[0], id: "D2-90", state: "done" } as never];
    const upd = updateTreatments({ research: [research], treatments: [live] }, tickets, entering("hurts"), NOW);
    expect(upd.decided[0]!.result.state).toBe("worse");
    expect(upd.undo[0]!.ticket.source.key).toBe("retention:undo:at_risk-streak-reminder");
  });
  test("not enough people yet: collecting", () => {
    expect(measureTreatment(live, entering("helps").slice(0, 100), NOW).state).toBe("collecting");
    expect(measureTreatment({ ...live, shippedAt: null }, [], NOW).state).toBe("building");
  });
});

describe("the retention pass", () => {
  const root = mkdtempSync(join(tmpdir(), "day2-retention-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), '{"dependencies":{"react":"19","expo-notifications":"0.30"}}');
  const app: AppEntry = { id: "app_r", name: "lingo", repoPath: root, connectionMethod: "local_path", appBaseUrl: "https://lingo.example", addedAt: "2026-09-01T00:00:00Z" };
  const store = fileFieldStore(join(root, "field"));
  const profile = { purpose: "Learn Spanish in 5 minutes a day", targetUsers: "Busy adults", featureMap: ["Lessons", "Streaks"] } as AppProfile;
  const logs: string[] = [];
  let researched = 0;
  const deps = {
    store,
    async research(input: { senders: string[]; usageRhythm: string | null }) {
      researched++;
      expect(input.senders).toEqual(["expo-notifications"]);
      expect(input.usageRhythm).toBe("daily");
      return { result: { category: research.category, productType: research.productType, leaders: research.leaders, ideas: research.ideas }, credits: 30 };
    },
  };

  test("nobody identified: asks the app to identify users (once the library reports)", async () => {
    saveBacklog(backlogFile(app), emptyBacklog());
    let r = await retentionPass(app, profile, deps, (t) => logs.push(t), NOW);
    expect(r.ticketsCreated).toEqual([]); // the library isn't reporting yet
    await store.record(app.id, { v: 1, device: { id: "d1", platform: "web" }, passes: {}, failures: [], events: [{ type: "visit", at: NOW.toISOString() }] }, NOW);
    r = await retentionPass(app, profile, deps, (t) => logs.push(t), new Date(NOW.getTime() + 7 * 3_600_000));
    expect(r.ticketsCreated).toHaveLength(1);
    const t = loadBacklog(backlogFile(app)).tickets.find((x) => x.source.key === "retention:identify")!;
    expect(t.title).toBe(identifyTicket(false).title);
    expect(researched).toBe(0);
  });

  test("with users: research, then one treatment for the biggest leak, measured against a holdout", async () => {
    // Real reports: identified users' activity as the library sends it.
    const pop = [...many(60, "daily", () => range(0, 20)), ...many(30, "stopped", () => range(3, 20))];
    for (const u of pop) {
      await store.record(app.id, { v: 1, device: { id: `dev-${u.user}`, platform: "web" }, passes: {}, failures: [], events: u.days.map((d) => ({ type: "active", at: `${d}T09:00:00Z`, user: u.user })) }, NOW);
    }
    const later = new Date(NOW.getTime() + 14 * 3_600_000);
    const r = await retentionPass(app, profile, deps, (t) => logs.push(t), later);
    expect(r.snapshot).toMatchObject({ status: "ready", leak: "at_risk", rhythm: "daily" });
    expect(researched).toBe(1);
    expect(r.ticketsCreated).toHaveLength(1);
    const backlog = loadBacklog(backlogFile(app));
    const t = backlog.tickets.find((x) => x.source.key === "retention:at_risk-streak-reminder")!;
    expect(t.title).toBe("Keep at-risk users: Streak reminder");
    expect(logs.at(-1)).toContain("10% are held out");
    expect(await store.retention(app.id)).toMatchObject({ leak: "at_risk" });

    // One at a time: nothing new while it's being built.
    const again = await retentionPass(app, profile, deps, () => {}, new Date(later.getTime() + 7 * 3_600_000));
    expect(again.ticketsCreated).toEqual([]);
    expect(researched).toBe(1);

    // Shipped → collecting against the holdout.
    saveBacklog(backlogFile(app), updateTicket(backlog, t.id, { state: "done" }, later).backlog);
    await retentionPass(app, profile, deps, () => {}, new Date(later.getTime() + 2 * DAY));
    const file = loadRetention(join(root, RETENTION_FILENAME));
    expect(file.treatments[0]).toMatchObject({ id: "at_risk-streak-reminder", result: { state: "collecting" } });
    const view = retentionView(file, await store.retention(app.id), loadBacklog(backlogFile(app)));
    expect(view).toMatchObject({ productType: { id: "habit", label: "Daily habit" }, category: "language-learning apps" });
    expect(view.next.map((n) => n.id)).toEqual(["back-welcome-back"]);
  });
});
