import { resolve } from "node:path";
import type { AppEntry } from "../apps-registry";
import { authorize, CreditsError, type CreditService } from "../credits";
import { db } from "../db";
import { withCreditContext, type CreditContext } from "../metered-query";
import { serverMode, type Tenant } from "../tenant";
import { CAPTURE_MAX_USD, captureDue, finishCapture, nextBatch, runMemoryKeeper, buildCapturePrompt } from "./capture";
import { blockedTargets, isBlocked, kindBlocked, mirrorRules, normalizeTarget, recordDecline, recordInput, renderMemoryBlock, selectForPurpose, type BlockCheck } from "./core";
import { dbMemoryStore, fileMemoryStore, type MemoryStore } from "./store";
import { MEMORY_FILENAME, type MemoryRef, type OwnerInput, type ProposalKind, type Purpose } from "./types";

/**
 * App memory, wired to how day2 runs: the store for the mode, the one
 * function every prompt builder calls (`memoryFor`), the hooks that record
 * owner input and declines, the hard filter, and when the memory keeper runs.
 */

export const memoryFile = (app: Pick<AppEntry, "repoPath">) => resolve(app.repoPath, MEMORY_FILENAME);

/** The store for this app: its `day2-memory.json` locally, Postgres with accounts. */
export function memoryStore(app: Pick<AppEntry, "repoPath">): MemoryStore {
  if (serverMode() === "accounts") return dbMemoryStore(db());
  const path = memoryFile(app);
  return fileMemoryStore(async () => path);
}

/** Usage stamps are written at most this often per item and kind of work. */
const USED_EVERY_MS = 10 * 60 * 1000;

/**
 * The compact block of what day2 knows about the app, ranked for `purpose`
 * (≈1,500 tokens at most), for an agent prompt. Records which items were
 * used. Never throws: no memory is better than a broken prompt.
 */
export async function memoryFor(app: Pick<AppEntry, "id" | "repoPath">, purpose: Purpose, opts: { hint?: string; now?: Date } = {}): Promise<string> {
  try {
    const store = memoryStore(app);
    const doc = await store.load(app.id);
    const items = selectForPurpose(doc, purpose, { hint: opts.hint });
    if (!items.length) return "";
    const now = opts.now ?? new Date();
    const stale = items.filter((i) => i.lastUsedFor !== purpose || !i.lastUsedAt || now.getTime() - Date.parse(i.lastUsedAt) > USED_EVERY_MS).map((i) => i.id);
    if (stale.length) await store.markUsed(app.id, stale, purpose, now).catch(() => {});
    return renderMemoryBlock(items);
  } catch {
    return "";
  }
}

/** For prompt builders: the block with a blank line around it, or nothing. */
export const memorySection = (block: string | undefined | null): string => (block ? `\n${block}\n` : "");

export type InputNote = Omit<OwnerInput, "id" | "at" | "who"> & { who?: string | null; at?: Date };

/** Records owner input for the memory keeper. Never throws (it must not break the request it rides on). */
export async function noteOwnerInput(app: Pick<AppEntry, "id" | "repoPath">, input: InputNote): Promise<void> {
  if (!input.text.trim() && input.kind !== "edit" && input.kind !== "decline") return;
  if (input.kind === "edit" && (input.before ?? "").trim() === (input.after ?? "").trim()) return;
  try {
    await memoryStore(app).update(app.id, (d) => ({ doc: recordInput(d, { ...input, who: input.who || "the owner", at: (input.at ?? new Date()).toISOString() }), result: null }));
  } catch {
    /* memory is best-effort */
  }
}

export type DeclineNote = { kind: ProposalKind; target: string; reason?: string | null; who?: string | null; ref?: MemoryRef | null; about?: string; at?: Date };

/**
 * The owner said no to a proposal: blocks the same kind and target for 90
 * days, and — when they said why — queues the reason for the keeper.
 */
export async function noteDecline(app: Pick<AppEntry, "id" | "repoPath">, d: DeclineNote): Promise<void> {
  const at = (d.at ?? new Date()).toISOString();
  const who = d.who || "the owner";
  const reason = typeof d.reason === "string" && d.reason.trim() ? d.reason.trim().slice(0, 500) : null;
  try {
    await memoryStore(app).update(app.id, (doc) => {
      let next = recordDecline(doc, { kind: d.kind, target: d.target, reason, who, at, ref: d.ref ?? null });
      if (reason) next = recordInput(next, { kind: "decline", text: reason, proposal: { kind: d.kind, target: normalizeTarget(d.target) }, ref: d.ref ?? null, who, at, ...(d.about ? { about: d.about } : {}) });
      return { doc: next, result: null };
    });
  } catch {
    /* best-effort */
  }
}

/** The hard filter for one proposal. */
export async function checkProposal(app: Pick<AppEntry, "id" | "repoPath">, kind: ProposalKind, target: string, opts: { now?: Date; ownerAsked?: boolean } = {}): Promise<BlockCheck> {
  try {
    const doc = await memoryStore(app).load(app.id);
    return isBlocked(doc, `${kind}:${normalizeTarget(target)}`, opts.now ?? new Date(), { ownerAsked: opts.ownerAsked });
  } catch {
    return { blocked: false };
  }
}

/** Before spending credits on a whole kind of proposal ("money.strategy"): is it ruled out? */
export async function checkKind(app: Pick<AppEntry, "id" | "repoPath">, kind: ProposalKind, now = new Date()): Promise<BlockCheck> {
  try {
    return kindBlocked(await memoryStore(app).load(app.id), kind, now);
  } catch {
    return { blocked: false };
  }
}

/**
 * For a proposal generator, before it spends credits: what day2 knows for
 * this kind of work, and the targets the owner already said no to (for the
 * prompt's "don't propose these"). `blocked` is set when the whole kind is
 * ruled out — then the generator stops without running.
 */
export async function proposalContext(
  app: Pick<AppEntry, "id" | "repoPath">,
  purpose: Purpose,
  kinds: ProposalKind[],
  opts: { hint?: string; now?: Date } = {},
): Promise<{ memory: string; avoid: string[]; blocked: BlockCheck }> {
  const now = opts.now ?? new Date();
  const memory = await memoryFor(app, purpose, { hint: opts.hint, now });
  try {
    const doc = await memoryStore(app).load(app.id);
    const avoid = kinds.flatMap((k) => blockedTargets(doc, k, now).map((t) => `${k}:${t}`));
    const whole = kinds.map((k) => kindBlocked(doc, k, now)).find((c) => c.blocked) ?? { blocked: false as const };
    return { memory, avoid, blocked: whole };
  } catch {
    return { memory, avoid: [], blocked: { blocked: false } };
  }
}

/** For prompts: the "don't propose" line, or nothing. */
export const avoidLine = (avoid: string[]): string => (avoid.length ? `The owner said no to these before — don't propose them again: ${avoid.join("; ")}.` : "");

/** Drops proposals the owner already said no to. `targetOf` may give several targets: blocked when any is. */
export async function filterProposals<T>(app: Pick<AppEntry, "id" | "repoPath">, kind: ProposalKind, items: T[], targetOf: (x: T) => string | string[], now = new Date()): Promise<{ kept: T[]; blocked: Array<{ item: T; why: string }> }> {
  let doc;
  try {
    doc = await memoryStore(app).load(app.id);
  } catch {
    return { kept: items, blocked: [] };
  }
  const kept: T[] = [];
  const blocked: Array<{ item: T; why: string }> = [];
  for (const x of items) {
    const targets = ([] as string[]).concat(targetOf(x));
    const c = targets.map((t) => isBlocked(doc, `${kind}:${normalizeTarget(t)}`, now)).find((r) => r.blocked);
    if (c?.blocked) blocked.push({ item: x, why: c.why });
    else kept.push(x);
  }
  return { kept, blocked };
}

/** Custom backlog rules → rule items (owner-written: active at once). */
export async function mirrorBacklogRules(app: Pick<AppEntry, "id" | "repoPath">, rules: Array<{ id: string; kind: string; text: string; enabled: boolean }>, who: string | null | undefined): Promise<void> {
  try {
    await memoryStore(app).update(app.id, (d) => ({ doc: mirrorRules(d, rules, who || "the owner", new Date()), result: null }));
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// When the memory keeper runs
// ---------------------------------------------------------------------------

/** Runs `fn` paid from the account's credits (api-server's runWithCredits, or `chargedRunner` in the background). */
export type CreditRunner = <T>(service: CreditService, description: string, maxCostUsd: number, fn: () => Promise<T>) => Promise<{ result: T; credits: number }>;

/** For background work (the autopilot timer): the same check-then-charge as runWithCredits. */
export function chargedRunner(tenant: Pick<Tenant, "credits">, app: Pick<AppEntry, "id" | "name">): CreditRunner {
  return async (service, description, maxCostUsd, fn) => {
    const check = await authorize(tenant.credits, { appId: app.id, appName: app.name, service, maxCostUsd });
    if (!check.ok) throw new CreditsError(check);
    const ctx: CreditContext = { appId: app.id, appName: app.name, service, description };
    const result = await withCreditContext(ctx, fn);
    return { result, credits: ctx.charged ?? 0 };
  };
}

const capturing = new Set<string>();

/**
 * Distills new owner input when it's due (hourly), or now with `force`
 * (right after a decline or an answer). One run per app at a time. The
 * cheapest fitting credit service: "scan_answer" (a short text-only run).
 */
export async function captureMemory(
  app: Pick<AppEntry, "id" | "name" | "repoPath">,
  run: CreditRunner,
  opts: { force?: boolean; now?: Date; ask?: (prompt: string) => Promise<string> } = {},
): Promise<{ ran: boolean; added: number; credits: number }> {
  const now = opts.now ?? new Date();
  if (capturing.has(app.id)) return { ran: false, added: 0, credits: 0 };
  const store = memoryStore(app);
  const doc = await store.load(app.id);
  if (!captureDue(doc, now, opts.force)) return { ran: false, added: 0, credits: 0 };
  capturing.add(app.id);
  try {
    const batch = nextBatch(doc);
    const prompt = buildCapturePrompt(app.name, doc.items, batch);
    const { result: answer, credits } = await run("scan_answer", "Memory keeper", CAPTURE_MAX_USD, () => (opts.ask ?? runMemoryKeeper)(prompt));
    const added = await store.update(app.id, (d) => {
      const r = finishCapture(d, answer, batch, now);
      return { doc: r.doc, result: r.added.length };
    });
    return { ran: true, added, credits };
  } finally {
    capturing.delete(app.id);
  }
}

/** Fire-and-forget after a decline or answer: never delays or fails the request. */
export function captureSoon(app: Pick<AppEntry, "id" | "name" | "repoPath">, run: CreditRunner): void {
  void captureMemory(app, run, { force: true }).catch(() => {});
}
