/**
 * One backlog per app (console "Backlog"): bugs, features, improvements and
 * tasks from every source — day2's own proposals, Sentry, health checks,
 * people on the team, JIRA and Linear — ranked by day2 and worked on
 * within limits the owner sets.
 *
 * Pure core (ranking, rules, ticket operations) + a small JSON store in the
 * app's repo (`day2-backlog.json`), written atomically. Every change to a
 * ticket appends to that ticket's own activity, so the history of why a
 * priority moved or who changed what is always on the ticket itself.
 *
 * Honesty rules carried over from the rest of day2:
 *  - a priority the owner picked is pinned — nothing automatic changes it;
 *  - signals (people affected, error counts) are only ever what a source
 *    reported, never estimated; a ticket with no signal keeps its priority;
 *  - "why this order" is built from those same signals and the rule that
 *    applied, not written after the fact.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export const BACKLOG_FILENAME = "day2-backlog.json";

export type TicketType = "bug" | "feature" | "improvement" | "task";
export type TicketState = "todo" | "to_approve" | "doing" | "done" | "parked";
export type Priority = 1 | 2 | 3 | 4;
export type PrioritySource = "day2" | "user" | "linear" | "jira";
export type Effort = "S" | "M" | "L";

export type TicketSourceKind = "day2_proposal" | "user" | "linear" | "jira" | "sentry" | "health_check" | "github_issue";

export type TicketSource = {
  kind: TicketSourceKind;
  /** Stable key in the source system (Sentry issue id, proposal title hash,
   * JIRA/Linear issue key) — used to never create the same ticket twice. */
  key?: string;
  /** Human-facing reference ("EXP-112", "EB-48") and link. */
  ref?: string;
  url?: string;
  /** Who created a user ticket. */
  createdBy?: string;
};

export type TrackerSystem = "linear" | "jira";

export type TrackerLink = {
  system: TrackerSystem;
  /** Linear issue id / JIRA issue key used for API calls. */
  id: string;
  /** Human key, e.g. "EXP-118". */
  key: string;
  url?: string;
  /** The tracker's own updated-at for the last state day2 saw — used to
   * decide which side changed since the last sync. */
  remoteUpdatedAt?: string;
  /** What day2 last pushed / pulled, to detect changes on either side. */
  syncedPriority?: Priority | null;
  syncedState?: TicketState;
  /** Tracker comment ids already mirrored into the ticket. */
  seenCommentIds?: string[];
  lastSyncedAt?: string;
};

export type TicketSignals = {
  /** Distinct people affected in the last 7 days, as reported by a source. */
  users?: number;
  /** Error events this week / the week before, as reported by a source. */
  errors?: number;
  errorsPrev?: number;
  /** Share of weekly actives affected, when a source knows it (0..1). */
  activeShare?: number;
  /** Security or data-loss problem — always P1, starts right away. */
  security?: boolean;
  /** Moves one of the owner's goals (Budget page). */
  goal?: string;
  /** A competitor does this / just shipped it. */
  competitor?: string;
  /** Plain-language notes shown under "Why day2 ranked this". */
  usageNote?: string;
  errorsNote?: string;
  /** When any of the above last changed — the 60-day staleness rule. */
  updatedAt?: string;
};

export type ActivityActor = "day2" | "user" | "linear" | "jira" | "sentry" | "health_check";

export type ActivityEntry = {
  at: string;
  actor: ActivityActor;
  /** Display name for people (comment authors, the owner). */
  name?: string;
  kind: "created" | "priority" | "state" | "edit" | "comment" | "sync" | "work" | "conflict";
  text: string;
  /** Owner comments already sent to these trackers. */
  sentTo?: TrackerSystem[];
};

export type Approval =
  | { kind: "pr"; number: number; url: string }
  | { kind: "plan"; plan: string };

export type Ticket = {
  id: string;
  title: string;
  type: TicketType;
  state: TicketState;
  description: string;
  doneWhen: string[];
  priority: Priority;
  prioritySource: PrioritySource;
  /** Owner-set priority — never changed by ranking, Tell, or sync. */
  pinned: boolean;
  source: TicketSource;
  trackers: TrackerLink[];
  signals: TicketSignals;
  /** Why the current priority — rebuilt on every rank. */
  rankReason: { usage?: string; errors?: string; competition?: string; goal?: string; rule?: string; at?: string };
  /** Ranking score within a priority (higher first). */
  score: number;
  effort: Effort | null;
  estimateCredits: number | null;
  /** Set while day2 works on it. */
  progress?: { step: number; of: number; label: string };
  approval?: Approval;
  /** A feature broken into smaller tickets points at its parent. */
  parentId?: string;
  createdAt: string;
  updatedAt: string;
  doneAt?: string;
  activity: ActivityEntry[];
};

export type Weight = 0 | 1 | 2; // Low / Medium / High

export type BuiltinRuleKey = "bugs_many_users" | "security_now" | "features_wait" | "keep_tracker_priority" | "stale_drop";

export type BacklogRule =
  | { id: string; kind: "builtin"; key: BuiltinRuleKey; text: string; enabled: boolean }
  /** Plain-words rules the owner adds — applied by day2's agent when it
   * re-plans the backlog (Tell), shown alongside the built-in ones. */
  | { id: string; kind: "custom"; text: string; enabled: boolean };

export type AutoStart = { bugs: boolean; tasks: boolean; improvements: boolean; features: boolean };

export type BacklogSettings = {
  weights: { usage: Weight; errors: Weight; goals: Weight; competition: Weight; quickWins: Weight };
  rules: BacklogRule[];
  /** Tickets day2 works on at once. */
  wipLimit: number;
  /** What day2 may start without being asked. Bugs means P1–P2 bugs. */
  autoStart: AutoStart;
  /** Error sources day2 turns into bug tickets for this app. */
  sentry?: { org: string; project: string } | null;
};

export type Backlog = {
  version: 1;
  nextNumber: number;
  tickets: Ticket[];
  settings: BacklogSettings;
  lastRankedAt?: string;
  /** "<source kind>:<key>" of tickets the owner deleted — never re-imported. */
  forgotten?: string[];
};

export const DEFAULT_RULES: BacklogRule[] = [
  { id: "r-bugs", kind: "builtin", key: "bugs_many_users", text: "Bugs that affect more than 10 people are P1.", enabled: true },
  { id: "r-security", kind: "builtin", key: "security_now", text: "Security or data-loss bugs are P1 and start right away.", enabled: true },
  { id: "r-features", kind: "builtin", key: "features_wait", text: "New features wait for my OK before day2 builds them.", enabled: true },
  {
    id: "r-trackers",
    kind: "builtin",
    key: "keep_tracker_priority",
    text: "Keep the priority set in JIRA or Linear, unless day2 sees a P1 signal.",
    enabled: true,
  },
  { id: "r-stale", kind: "builtin", key: "stale_drop", text: "Tickets with no new signal for 60 days drop one priority.", enabled: true },
];

export function defaultSettings(): BacklogSettings {
  return {
    weights: { usage: 2, errors: 2, goals: 1, competition: 1, quickWins: 1 },
    rules: DEFAULT_RULES.map((r) => ({ ...r })),
    wipLimit: 2,
    autoStart: { bugs: true, tasks: true, improvements: false, features: false },
    sentry: null,
  };
}

export function emptyBacklog(): Backlog {
  return { version: 1, nextNumber: 1, tickets: [], settings: defaultSettings() };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const STALE_DAYS = 60;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const log10p = (n: number) => Math.log10(1 + Math.max(0, n));

function ruleOn(settings: BacklogSettings, key: BuiltinRuleKey): BacklogRule | undefined {
  return settings.rules.find((r) => r.kind === "builtin" && r.key === key && r.enabled);
}

export function hasSignal(s: TicketSignals): boolean {
  return Boolean(s.users || s.errors || s.security || s.goal || s.competitor);
}

/** 0..1 — how strongly the ticket's real signals and size argue for doing
 * it, weighted by the owner's "what counts most". */
export function scoreTicket(t: Ticket, weights: BacklogSettings["weights"]): number {
  const s = t.signals;
  const errorsTrend = s.errors && s.errorsPrev !== undefined && s.errors > 2 * Math.max(1, s.errorsPrev) ? 0.25 : 0;
  const parts: Array<[Weight, number]> = [
    [weights.usage, s.activeShare !== undefined ? clamp01(s.activeShare * 5) : clamp01(log10p(s.users ?? 0) / 2)],
    [weights.errors, clamp01(log10p(s.errors ?? 0) / 2.3 + errorsTrend)],
    [weights.goals, s.goal ? 1 : 0],
    [weights.competition, s.competitor ? 1 : 0],
    [weights.quickWins, t.effort === "S" ? 1 : t.effort === "M" ? 0.5 : t.effort === "L" ? 0 : 0.5],
  ];
  const total = parts.reduce((sum, [w]) => sum + w + 1, 0);
  const score = parts.reduce((sum, [w, v]) => sum + (w + 1) * v, 0) / total;
  return Math.round((score + (t.type === "bug" ? 0.05 : 0)) * 1000) / 1000;
}

function priorityForScore(score: number): Priority {
  if (score >= 0.6) return 1;
  if (score >= 0.42) return 2;
  if (score >= 0.25) return 3;
  return 4;
}

const pLabel = (p: Priority) => `P${p}`;

export type RankChange = { id: string; from: Priority; to: Priority; reason: string };

/**
 * Re-ranks every open ticket. Pure. Pinned tickets keep their priority;
 * tickets without any signal keep theirs too (there's nothing to rank them
 * on), except for the staleness rule. Returns the new backlog and what
 * moved, so callers can log it on each ticket.
 */
export function rankBacklog(backlog: Backlog, now: Date): { backlog: Backlog; changes: RankChange[] } {
  const settings = backlog.settings;
  const at = now.toISOString();
  const changes: RankChange[] = [];
  const tickets = backlog.tickets.map((t) => {
    if (t.state === "done" || t.state === "parked") return t;
    const score = scoreTicket(t, settings.weights);
    const s = t.signals;
    const reason: Ticket["rankReason"] = { at };
    if (s.usageNote) reason.usage = s.usageNote;
    else if (s.users) reason.usage = `${s.users} ${s.users === 1 ? "person" : "people"} hit it in 7 days.`;
    if (s.errorsNote) reason.errors = s.errorsNote;
    else if (s.errors)
      reason.errors = `${s.errors} error events this week${s.errorsPrev !== undefined ? `, up from ${s.errorsPrev}` : ""}.`;
    if (s.competitor) reason.competition = s.competitor;
    if (s.goal) reason.goal = `Moves your goal: ${s.goal}.`;

    let next: Priority = t.priority;
    let why = "";
    const security = ruleOn(settings, "security_now");
    const manyUsers = ruleOn(settings, "bugs_many_users");
    let p1Signal: BacklogRule | undefined;
    if (security && s.security) p1Signal = security;
    else if (manyUsers && t.type === "bug" && (s.users ?? 0) > 10) p1Signal = manyUsers;

    if (t.pinned) {
      next = t.priority;
    } else if (p1Signal) {
      next = 1;
      reason.rule = p1Signal.text;
      why = p1Signal.text;
    } else if ((t.prioritySource === "linear" || t.prioritySource === "jira") && ruleOn(settings, "keep_tracker_priority")) {
      next = t.priority;
      reason.rule = ruleOn(settings, "keep_tracker_priority")!.text;
    } else if (hasSignal(s)) {
      next = priorityForScore(score);
      why = [reason.usage, reason.errors, reason.competition, reason.goal].filter(Boolean).join(" ") || "Ranked from its signals.";
    }

    const stale = ruleOn(settings, "stale_drop");
    const lastSignal = s.updatedAt ?? t.createdAt;
    if (!t.pinned && stale && next < 4 && now.getTime() - new Date(lastSignal).getTime() > STALE_DAYS * 86_400_000 && !p1Signal) {
      const lastDrop = [...t.activity].reverse().find((a) => a.kind === "priority" && a.text.includes("no new signal"));
      if (!lastDrop || now.getTime() - new Date(lastDrop.at).getTime() > STALE_DAYS * 86_400_000) {
        next = (next + 1) as Priority;
        reason.rule = stale.text;
        why = `No new signal for ${STALE_DAYS} days.`;
      }
    }

    let updated: Ticket = { ...t, score, rankReason: reason };
    if (next !== t.priority) {
      changes.push({ id: t.id, from: t.priority, to: next, reason: why });
      updated = {
        ...updated,
        priority: next,
        prioritySource: "day2",
        updatedAt: at,
        activity: [
          ...t.activity,
          {
            at,
            actor: "day2",
            kind: "priority",
            text: `${next < t.priority ? "raised" : "lowered"} priority ${pLabel(t.priority)} → ${pLabel(next)}${why ? `: ${why.replace(/\.$/, "")}` : ""}.`,
          },
        ],
      };
    }
    return updated;
  });
  return { backlog: { ...backlog, tickets, lastRankedAt: at }, changes };
}

/** Board order for open columns: priority, then score, then oldest first. */
export function compareTickets(a: Ticket, b: Ticket): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.score !== b.score) return b.score - a.score;
  return a.createdAt.localeCompare(b.createdAt);
}

/** What day2 would pick up next, respecting the WIP limit and the owner's
 * "start on its own" choices. Security tickets bypass the WIP limit. */
export function nextToStart(backlog: Backlog): Ticket[] {
  const { settings } = backlog;
  const doing = backlog.tickets.filter((t) => t.state === "doing").length;
  const todo = backlog.tickets.filter((t) => t.state === "todo").sort(compareTickets);
  const securityRule = ruleOn(settings, "security_now");
  const urgent = securityRule ? todo.filter((t) => t.signals.security) : [];
  const allowed = (t: Ticket) =>
    (t.type === "bug" && settings.autoStart.bugs && t.priority <= 2) ||
    (t.type === "task" && settings.autoStart.tasks) ||
    (t.type === "improvement" && settings.autoStart.improvements) ||
    (t.type === "feature" && settings.autoStart.features);
  const slots = Math.max(0, settings.wipLimit - doing);
  const rest = todo.filter((t) => !urgent.includes(t) && allowed(t)).slice(0, slots);
  return [...urgent, ...rest];
}

/** Features wait for an OK on their plan when the owner's rule says so. */
export function needsPlanApproval(backlog: Backlog, t: Ticket): boolean {
  return t.type === "feature" && Boolean(ruleOn(backlog.settings, "features_wait"));
}

// ---------------------------------------------------------------------------
// Ticket operations (pure)
// ---------------------------------------------------------------------------

export type NewTicketInput = {
  title: string;
  type: TicketType;
  description?: string;
  doneWhen?: string[];
  /** Omitted = "let day2 decide" (P3 until a signal or day2 says otherwise). */
  priority?: Priority;
  source: TicketSource;
  signals?: TicketSignals;
  effort?: Effort | null;
  estimateCredits?: number | null;
  parentId?: string;
  prioritySource?: PrioritySource;
  state?: TicketState;
  actor?: ActivityActor;
  actorName?: string;
  createdNote?: string;
};

const SOURCE_NOTE: Record<TicketSourceKind, string> = {
  day2_proposal: "Proposed by day2.",
  user: "Created",
  linear: "Imported from Linear",
  jira: "Imported from JIRA",
  sentry: "Created from a Sentry issue.",
  health_check: "Created from a failed health check.",
  github_issue: "Imported from a GitHub issue",
};

export function createTicket(backlog: Backlog, input: NewTicketInput, now: Date): { backlog: Backlog; ticket: Ticket } {
  const at = now.toISOString();
  const title = input.title.trim();
  if (!title) throw new Error("A ticket needs a title.");
  const pinned = input.priority !== undefined && (input.prioritySource ?? "user") === "user";
  const note =
    input.createdNote ??
    (input.source.kind === "user"
      ? `Created${input.source.createdBy ? ` by ${input.source.createdBy}` : ""}.`
      : `${SOURCE_NOTE[input.source.kind]}${input.source.ref && !SOURCE_NOTE[input.source.kind].endsWith(".") ? ` ${input.source.ref}.` : ""}`);
  const ticket: Ticket = {
    id: `D2-${backlog.nextNumber}`,
    title,
    type: input.type,
    state: input.state ?? "todo",
    description: (input.description ?? "").trim(),
    doneWhen: (input.doneWhen ?? []).map((d) => d.trim()).filter(Boolean),
    priority: input.priority ?? 3,
    prioritySource: input.priority !== undefined ? (input.prioritySource ?? "user") : "day2",
    pinned,
    source: input.source,
    trackers: [],
    signals: { ...(input.signals ?? {}), ...(input.signals && hasSignal(input.signals) ? { updatedAt: input.signals.updatedAt ?? at } : {}) },
    rankReason: {},
    score: 0,
    effort: input.effort ?? null,
    estimateCredits: input.estimateCredits ?? null,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    createdAt: at,
    updatedAt: at,
    activity: [{ at, actor: input.actor ?? (input.source.kind === "user" ? "user" : "day2"), name: input.actorName, kind: "created", text: note }],
  };
  ticket.score = scoreTicket(ticket, backlog.settings.weights);
  return { backlog: { ...backlog, nextNumber: backlog.nextNumber + 1, tickets: [...backlog.tickets, ticket] }, ticket };
}

export function findTicket(backlog: Backlog, id: string): Ticket | undefined {
  return backlog.tickets.find((t) => t.id === id);
}

function replaceTicket(backlog: Backlog, ticket: Ticket): Backlog {
  return { ...backlog, tickets: backlog.tickets.map((t) => (t.id === ticket.id ? ticket : t)) };
}

export type TicketPatch = {
  title?: string;
  type?: TicketType;
  description?: string;
  doneWhen?: string[];
  state?: TicketState;
  /** A number pins it; null unpins and hands it back to day2. */
  priority?: Priority | null;
  effort?: Effort | null;
  estimateCredits?: number | null;
};

const STATE_NAMES: Record<TicketState, string> = {
  todo: "To do",
  to_approve: "To be approved",
  doing: "Doing",
  done: "Done",
  parked: "Parked",
};

export function stateName(s: TicketState): string {
  return STATE_NAMES[s];
}

/**
 * Applies an edit and logs it. `actor` decides pinning: an owner-set
 * priority pins; a priority from day2 or a tracker doesn't, and is refused
 * on a pinned ticket (returns the ticket unchanged with `refused`).
 */
export function updateTicket(
  backlog: Backlog,
  id: string,
  patch: TicketPatch,
  now: Date,
  actor: { kind: ActivityActor; name?: string } = { kind: "user" },
): { backlog: Backlog; ticket: Ticket; refused?: string } {
  const t = findTicket(backlog, id);
  if (!t) throw new Error(`No ticket ${id}.`);
  const at = now.toISOString();
  const log: ActivityEntry[] = [];
  let next: Ticket = { ...t };
  let refused: string | undefined;
  const who = actor.kind === "user" ? (actor.name ?? "You") : actor.kind === "day2" ? "day2" : (actor.name ?? actor.kind);

  if (patch.title !== undefined && patch.title.trim() && patch.title.trim() !== t.title) {
    next.title = patch.title.trim();
    log.push({ at, actor: actor.kind, name: actor.name, kind: "edit", text: `renamed it from “${t.title}”.` });
  }
  if (patch.type !== undefined && patch.type !== t.type) {
    next.type = patch.type;
    log.push({ at, actor: actor.kind, name: actor.name, kind: "edit", text: `changed the type to ${patch.type}.` });
  }
  if (patch.description !== undefined && patch.description.trim() !== t.description) {
    next.description = patch.description.trim();
    log.push({ at, actor: actor.kind, name: actor.name, kind: "edit", text: "edited the description." });
  }
  if (patch.doneWhen !== undefined) {
    const dw = patch.doneWhen.map((d) => d.trim()).filter(Boolean);
    if (JSON.stringify(dw) !== JSON.stringify(t.doneWhen)) {
      next.doneWhen = dw;
      log.push({ at, actor: actor.kind, name: actor.name, kind: "edit", text: "updated “Done when”." });
    }
  }
  if (patch.effort !== undefined && patch.effort !== t.effort) next.effort = patch.effort;
  if (patch.estimateCredits !== undefined) next.estimateCredits = patch.estimateCredits;

  if (patch.priority !== undefined) {
    if (patch.priority === null) {
      if (t.pinned) {
        next.pinned = false;
        next.prioritySource = "day2";
        log.push({ at, actor: actor.kind, name: actor.name, kind: "priority", text: "handed the priority back to day2." });
      }
    } else if (actor.kind === "user") {
      if (patch.priority !== t.priority || !t.pinned) {
        next.priority = patch.priority;
        next.pinned = true;
        next.prioritySource = "user";
        log.push({ at, actor: "user", name: actor.name, kind: "priority", text: `set priority ${pLabel(t.priority)} → ${pLabel(patch.priority)} (pinned).` });
      }
    } else if (t.pinned) {
      refused = `${who} left the pinned ${pLabel(t.priority)} alone.`;
    } else if (patch.priority !== t.priority) {
      next.priority = patch.priority;
      next.prioritySource = actor.kind === "linear" || actor.kind === "jira" ? actor.kind : "day2";
      log.push({ at, actor: actor.kind, name: actor.name, kind: "priority", text: `changed priority ${pLabel(t.priority)} → ${pLabel(patch.priority)}.` });
    }
  }

  if (patch.state !== undefined && patch.state !== t.state) {
    next.state = patch.state;
    if (patch.state === "done") next.doneAt = at;
    if (patch.state !== "doing") delete next.progress;
    if (patch.state !== "to_approve") delete next.approval;
    log.push({ at, actor: actor.kind, name: actor.name, kind: "state", text: `moved it to ${stateName(patch.state)}.` });
  }

  if (!log.length) return { backlog, ticket: t, refused };
  next = { ...next, updatedAt: at, activity: [...t.activity, ...log] };
  next.score = scoreTicket(next, backlog.settings.weights);
  return { backlog: replaceTicket(backlog, next), ticket: next, refused };
}

export function addActivity(backlog: Backlog, id: string, entry: Omit<ActivityEntry, "at">, now: Date): Backlog {
  const t = findTicket(backlog, id);
  if (!t) throw new Error(`No ticket ${id}.`);
  const at = now.toISOString();
  return replaceTicket(backlog, { ...t, updatedAt: at, activity: [...t.activity, { ...entry, at }] });
}

export function deleteTicket(backlog: Backlog, id: string): Backlog {
  const t = findTicket(backlog, id);
  if (!t) throw new Error(`No ticket ${id}.`);
  const forgotten = t.source.key ? [...(backlog.forgotten ?? []), `${t.source.kind}:${t.source.key}`] : backlog.forgotten;
  return {
    ...backlog,
    ...(forgotten ? { forgotten } : {}),
    tickets: backlog.tickets.filter((t) => t.id !== id).map((t) => (t.parentId === id ? { ...t, parentId: undefined } : t)),
  };
}

/** Raw replace for internal callers (worker progress, sync, undo). */
export function putTicket(backlog: Backlog, ticket: Ticket): Backlog {
  return findTicket(backlog, ticket.id) ? replaceTicket(backlog, ticket) : { ...backlog, tickets: [...backlog.tickets, ticket] };
}

// ---------------------------------------------------------------------------
// Ingesting signals (Sentry, health checks, day2 proposals)
// ---------------------------------------------------------------------------

export type IncomingItem = {
  source: TicketSource & { key: string };
  title: string;
  type: TicketType;
  description: string;
  signals?: TicketSignals;
  doneWhen?: string[];
  effort?: Effort | null;
};

/**
 * Upsert by source key: new findings become tickets; findings already on
 * the board get their signals refreshed (with a note when errors jump) —
 * never a duplicate ticket, and a ticket the owner deleted or finished
 * isn't recreated from the same source key.
 */
export function ingest(backlog: Backlog, items: IncomingItem[], now: Date): { backlog: Backlog; created: string[]; updated: string[] } {
  let b = backlog;
  const forgottenKeys = new Set(backlog.forgotten ?? []);
  const created: string[] = [];
  const updated: string[] = [];
  const at = now.toISOString();
  for (const item of items) {
    const key = `${item.source.kind}:${item.source.key}`;
    if (forgottenKeys.has(key)) continue;
    const existing = b.tickets.find((t) => t.source.kind === item.source.kind && t.source.key === item.source.key);
    if (!existing) {
      const r = createTicket(
        b,
        {
          title: item.title,
          type: item.type,
          description: item.description,
          doneWhen: item.doneWhen,
          source: item.source,
          signals: item.signals ? { ...item.signals, updatedAt: at } : undefined,
          effort: item.effort ?? null,
          actor: item.source.kind === "sentry" ? "sentry" : item.source.kind === "health_check" ? "health_check" : "day2",
        },
        now,
      );
      b = r.backlog;
      created.push(r.ticket.id);
      continue;
    }
    if (existing.state === "done" || existing.state === "parked" || !item.signals) continue;
    const prev = existing.signals;
    const nextSignals = { ...prev, ...item.signals };
    if (JSON.stringify({ ...nextSignals, updatedAt: undefined }) === JSON.stringify({ ...prev, updatedAt: undefined })) continue;
    const notes: ActivityEntry[] = [];
    if (item.signals.errors !== undefined && prev.errors !== undefined && item.signals.errors >= 2 * Math.max(1, prev.errors)) {
      notes.push({ at, actor: "day2", kind: "sync", text: `errors went from ${prev.errors} to ${item.signals.errors} a week.` });
    }
    b = putTicket(b, {
      ...existing,
      signals: { ...nextSignals, errorsPrev: item.signals.errors !== undefined ? (prev.errors ?? item.signals.errorsPrev) : prev.errorsPrev, updatedAt: at },
      updatedAt: at,
      activity: [...existing.activity, ...notes],
    });
    updated.push(existing.id);
  }
  return { backlog: b, created, updated };
}

// ---------------------------------------------------------------------------
// Settings validation
// ---------------------------------------------------------------------------

export function parseSettingsPatch(raw: unknown, current: BacklogSettings): BacklogSettings {
  if (!raw || typeof raw !== "object") throw new Error("settings must be an object.");
  const r = raw as Record<string, unknown>;
  const next: BacklogSettings = { ...current, weights: { ...current.weights }, autoStart: { ...current.autoStart }, rules: current.rules };
  if (r.weights !== undefined) {
    const w = r.weights as Record<string, unknown>;
    for (const k of Object.keys(next.weights) as Array<keyof BacklogSettings["weights"]>) {
      if (w[k] === undefined) continue;
      if (w[k] !== 0 && w[k] !== 1 && w[k] !== 2) throw new Error(`weights.${k} must be 0 (low), 1 (medium) or 2 (high).`);
      next.weights[k] = w[k] as Weight;
    }
  }
  if (r.wipLimit !== undefined) {
    if (typeof r.wipLimit !== "number" || !Number.isInteger(r.wipLimit) || r.wipLimit < 0 || r.wipLimit > 10) {
      throw new Error("wipLimit must be a whole number from 0 to 10.");
    }
    next.wipLimit = r.wipLimit;
  }
  if (r.autoStart !== undefined) {
    const a = r.autoStart as Record<string, unknown>;
    for (const k of Object.keys(next.autoStart) as Array<keyof AutoStart>) {
      if (a[k] === undefined) continue;
      if (typeof a[k] !== "boolean") throw new Error(`autoStart.${k} must be true or false.`);
      next.autoStart[k] = a[k] as boolean;
    }
  }
  if (r.rules !== undefined) {
    if (!Array.isArray(r.rules)) throw new Error("rules must be a list.");
    const builtins = new Map(current.rules.filter((x) => x.kind === "builtin").map((x) => [x.id, x]));
    const rules: BacklogRule[] = [];
    for (const raw of r.rules as unknown[]) {
      const x = raw as Record<string, unknown>;
      const enabled = x.enabled === undefined ? true : x.enabled === true;
      if (typeof x.id === "string" && builtins.has(x.id)) {
        rules.push({ ...builtins.get(x.id)!, enabled });
        builtins.delete(x.id);
        continue;
      }
      const text = typeof x.text === "string" ? x.text.trim() : "";
      if (!text) throw new Error("A rule needs some words.");
      if (text.length > 300) throw new Error("Keep a rule under 300 characters.");
      rules.push({ id: typeof x.id === "string" && x.id ? x.id : `r-${randomUUID().slice(0, 8)}`, kind: "custom", text, enabled });
    }
    // Built-in rules can be switched off but not lost.
    for (const b of builtins.values()) rules.push({ ...b, enabled: false });
    next.rules = rules;
  }
  if (r.sentry !== undefined) {
    if (r.sentry === null) next.sentry = null;
    else {
      const s = r.sentry as Record<string, unknown>;
      if (typeof s.org !== "string" || !s.org.trim() || typeof s.project !== "string" || !s.project.trim()) {
        throw new Error("sentry needs an org and a project.");
      }
      next.sentry = { org: s.org.trim(), project: s.project.trim() };
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function loadBacklog(file: string): Backlog {
  if (!existsSync(file)) return emptyBacklog();
  const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<Backlog>;
  const defaults = defaultSettings();
  const settings = { ...defaults, ...(raw.settings ?? {}) } as BacklogSettings;
  settings.weights = { ...defaults.weights, ...(raw.settings?.weights ?? {}) };
  settings.autoStart = { ...defaults.autoStart, ...(raw.settings?.autoStart ?? {}) };
  if (!raw.settings?.rules) settings.rules = defaults.rules;
  return {
    version: 1,
    nextNumber: raw.nextNumber ?? 1,
    tickets: raw.tickets ?? [],
    settings,
    lastRankedAt: raw.lastRankedAt,
    ...(raw.forgotten ? { forgotten: raw.forgotten } : {}),
  };
}

export function saveBacklog(file: string, backlog: Backlog): void {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(backlog, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Serializes read-modify-write per file within this process, so two
 * requests editing the same backlog can't lose each other's change. */
const chains = new Map<string, Promise<unknown>>();
export function withBacklog<T>(file: string, fn: (b: Backlog) => { backlog: Backlog; result: T } | Promise<{ backlog: Backlog; result: T }>): Promise<T> {
  const prev = chains.get(file) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async () => {
    const out = await fn(loadBacklog(file));
    if (out.backlog) saveBacklog(file, out.backlog);
    return out.result;
  });
  chains.set(file, run);
  return run;
}
