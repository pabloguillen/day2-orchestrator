/**
 * App memory ("What day2 knows"): what the owner has told day2 about one
 * app, distilled into short items every agent that works on the app reads.
 * docs/memory-and-learning.md.
 */

export const MEMORY_FILENAME = "day2-memory.json";

export const MEMORY_KINDS = ["fact", "preference", "rule", "do_not", "audience", "tech"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_SOURCES = ["owner_comment", "answer", "decline", "correction", "approval_note", "backlog_rule", "onboarding", "day2_observed"] as const;
export type MemorySourceKind = (typeof MEMORY_SOURCES)[number];

export type MemoryStatus = "active" | "needs_confirmation" | "retired";

/** What an agent is about to do with the app — memoryFor ranks by it. */
export const PURPOSES = ["build", "plan", "bug", "growth", "money", "store", "messages", "create", "answer"] as const;
export type Purpose = (typeof PURPOSES)[number];

/** Where an item came from, with a link the console can open. */
export type MemoryRef = {
  /** ticket | pr | page | proposal | rule */
  type: "ticket" | "pr" | "page" | "proposal" | "rule" | "memory";
  /** "D2-12", "#41", "money/products/pro_monthly", a console path… */
  id: string;
  /** A console path ("/apps/x/backlog/D2-12") or an external URL. */
  url?: string;
  /** Plain words: "ticket D2-12", "Store proposal (subtitle)". */
  label?: string;
};

export type MemoryItem = {
  id: string;
  kind: MemoryKind;
  /** Short, plain words. */
  text: string;
  source: { kind: MemorySourceKind; ref: MemoryRef | null };
  /** Who said it (display name), or "day2". */
  who: string;
  /** When it was said / learned. */
  at: string;
  updatedAt: string;
  /** 0..1 — how sure day2 is this is what the owner means. */
  confidence: number;
  status: MemoryStatus;
  /** The item this one replaced (newer wins). */
  supersedes: string | null;
  supersededBy?: string | null;
  /** Which kinds of work it matters for; empty = all. */
  scope: Purpose[];
  /** Proposal keys this item blocks (do_not), e.g. "money.product:lifetime" or "store.text:subtitle". */
  keys: string[];
  /** The last time it shaped a decision (memoryFor included it). */
  lastUsedAt?: string | null;
  lastUsedFor?: Purpose | null;
  /** For backlog_rule mirrors: the rule's id, so edits and deletes follow it. */
  ruleId?: string;
};

/** Owner input waiting to be distilled by the memory keeper. */
export type OwnerInputKind = "comment" | "question" | "answer" | "tell" | "decline" | "edit" | "approval_note";

export type OwnerInput = {
  id: string;
  kind: OwnerInputKind;
  /** What they wrote (already passed through the privacy filter). */
  text: string;
  /** For edits: day2's text and the owner's version. */
  before?: string;
  after?: string;
  /** What it was about, in plain words: "Store subtitle", "ticket D2-4 'Dark mode'". */
  about?: string;
  /** Declines: what was declined. */
  proposal?: { kind: ProposalKind; target: string };
  ref: MemoryRef | null;
  who: string;
  at: string;
};

/** A proposal the owner said no to — blocks proposing the same kind and target again for 90 days. */
export type Decline = {
  key: string;
  kind: ProposalKind;
  target: string;
  reason: string | null;
  who: string;
  at: string;
  ref: MemoryRef | null;
};

/** A change the owner should see: something new replaced an older item. */
export type MemoryChange = { at: string; text: string; itemId: string; replacedId: string | null };

export type MemoryDoc = {
  version: 1;
  items: MemoryItem[];
  inbox: OwnerInput[];
  declines: Decline[];
  changes: MemoryChange[];
  lastCaptureAt: string | null;
};

/** Kinds of things day2 proposes; the hard filter keys are "<kind>:<target>". */
export const PROPOSAL_KINDS = [
  "live.idea",
  "money.strategy",
  "money.product",
  "money.test",
  "money.ad",
  "store.text",
  "store.screenshots",
  "store.test",
  "store.page",
  "messages.campaign",
  "retention.treatment",
  "growth.bet",
  "backlog.ticket",
  "create.screen",
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const emptyMemory = (): MemoryDoc => ({ version: 1, items: [], inbox: [], declines: [], changes: [], lastCaptureAt: null });

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function normalizeMemory(raw: unknown): MemoryDoc {
  if (!isObj(raw)) return emptyMemory();
  return {
    version: 1,
    items: Array.isArray(raw.items) ? (raw.items as MemoryItem[]).map((i) => ({ scope: [], keys: [], supersedes: null, ...i })) : [],
    inbox: Array.isArray(raw.inbox) ? (raw.inbox as OwnerInput[]) : [],
    declines: Array.isArray(raw.declines) ? (raw.declines as Decline[]) : [],
    changes: Array.isArray(raw.changes) ? (raw.changes as MemoryChange[]) : [],
    lastCaptureAt: typeof raw.lastCaptureAt === "string" ? raw.lastCaptureAt : null,
  };
}
