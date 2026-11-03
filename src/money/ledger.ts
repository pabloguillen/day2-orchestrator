import type { SQL } from "bun";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Revenue truth: what Apple and Google confirmed (and what apps report for
 * ads), per hashed user — never a receipt, an email or a raw user id. Plus
 * the verification queue: every store notification is kept until it has
 * been checked and recorded, retried with backoff when a store lookup
 * fails, and remembered (by id) so a redelivery never counts twice.
 *
 * Two versions, like field-store.ts: JSON files per app (local mode) and
 * Postgres (accounts mode, migration 015_money.sql).
 */

export type RevenueKind = "subscription" | "purchase" | "ad";
export type MoneyEventType = "purchase_verified" | "renewal" | "trial_started" | "refund" | "cancellation" | "expired" | "billing_issue" | "recovered" | "ad_revenue";
export type StoreId = "apple" | "google" | "revenuecat" | "device";

export type MoneyRecord = {
  /** Unique per store event, e.g. "apple:2000000123:purchase_verified". */
  id: string;
  store: StoreId;
  type: MoneyEventType;
  kind: RevenueKind;
  productId: string | null;
  at: string;
  /** Gross, what the user paid (tax included), in `currency`. Refunds are positive amounts of type "refund". 0 for trials/cancellations. */
  amount: number;
  currency: string;
  /** Hashed user (hashUser), when the purchase carried day2's purchase token. */
  user: string | null;
  /** Experiment → variant the user was in. */
  variants: Record<string, string>;
  /** Where the user came from (acquisition channel), when known. */
  source: string | null;
  /** The subscription chain (Apple originalTransactionId / hash of Google's linked token chain). */
  chain: string | null;
  sandbox: boolean;
  /** Subscriptions: when the paid period ends (to notice a missed notification). */
  expiresAt: string | null;
};

export type QueueItem = {
  /** The store's notification id (Apple notificationUUID, Pub/Sub messageId). */
  id: string;
  store: "apple" | "google" | "revenuecat";
  receivedAt: string;
  state: "queued" | "done" | "ignored" | "failed";
  attempts: number;
  nextAt: string | null;
  error: string | null;
  /** What's needed to (re)check it: Apple's signedPayload; Google's token and product. Cleared once done. */
  payload: Record<string, unknown> | null;
  /** Plain-language outcome, e.g. "Renewal of dotty.pro.monthly.v1, 4,99 €". */
  note: string | null;
};

export interface MoneyLedger {
  /** Adds a notification unless one with this id exists; false when it did (a redelivery). */
  enqueue(appId: string, item: Omit<QueueItem, "state" | "attempts" | "nextAt" | "error" | "note">): Promise<boolean>;
  /** Queued items whose next attempt is due. */
  due(appId: string, now: Date, limit?: number): Promise<QueueItem[]>;
  settle(appId: string, id: string, r: { state: QueueItem["state"]; error?: string | null; nextAt?: string | null; note?: string | null; keepPayload?: boolean }): Promise<void>;
  queue(appId: string, limit?: number): Promise<QueueItem[]>;
  /** Upserts by id; returns how many were new. */
  record(appId: string, records: MoneyRecord[]): Promise<number>;
  records(appId: string, since: Date): Promise<MoneyRecord[]>;
}

/** Backoff for a failed check: 1 min, 5 min, 30 min, 2 h, 12 h, then every 24 h; gives up after 10 tries. */
export const RETRY_MINUTES = [1, 5, 30, 120, 720, 1440];
export const MAX_ATTEMPTS = 10;
export const nextAttempt = (attempts: number, now: Date) => new Date(now.getTime() + RETRY_MINUTES[Math.min(attempts, RETRY_MINUTES.length) - 1]! * 60_000).toISOString();

/** A stable, non-reversible id for a store token (Google purchase tokens are credentials). */
export const tokenId = (token: string) => createHash("sha256").update(`day2-money:${token}`).digest("hex").slice(0, 32);

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

type AppFile = { queue: QueueItem[]; records: MoneyRecord[] };
const KEEP_QUEUE = 2000;

/**
 * Unverified notifications (inbox replays without Google's OIDC token) that
 * may wait at once per app; more are turned away. Verified ones are never
 * limited by them, so a flood of replays can't crowd out real retries.
 */
export const MAX_UNVERIFIED_QUEUED = 200;
const isUnverified = (q: { payload: Record<string, unknown> | null }) => q.payload?.unverified === true;

/**
 * Pure. The file queue past KEEP_QUEUE: settled items go first (oldest
 * first), then unverified waiting ones; verified items still waiting for a
 * retry are always kept.
 */
export function trimQueue(queue: QueueItem[], keep = KEEP_QUEUE): QueueItem[] {
  let over = queue.length - keep;
  if (over <= 0) return queue;
  const drop = new Set<number>();
  for (const pass of [(q: QueueItem) => q.state !== "queued", (q: QueueItem) => q.state === "queued" && isUnverified(q)]) {
    for (let i = 0; i < queue.length && over > 0; i++) {
      if (!drop.has(i) && pass(queue[i]!)) {
        drop.add(i);
        over--;
      }
    }
  }
  return queue.filter((_, i) => !drop.has(i));
}

export function fileMoneyLedger(dir: string): MoneyLedger {
  const path = (appId: string) => join(dir, `${appId.replace(/[^\w-]/g, "_")}.json`);
  const load = (appId: string): AppFile => {
    const p = path(appId);
    if (!existsSync(p)) return { queue: [], records: [] };
    try {
      const j = JSON.parse(readFileSync(p, "utf-8")) as Partial<AppFile>;
      return { queue: j.queue ?? [], records: j.records ?? [] };
    } catch {
      return { queue: [], records: [] };
    }
  };
  const save = (appId: string, f: AppFile) => {
    const p = path(appId);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ queue: trimQueue(f.queue), records: f.records }));
    chmodSync(tmp, 0o600);
    renameSync(tmp, p);
  };
  return {
    async enqueue(appId, item) {
      const f = load(appId);
      if (f.queue.some((q) => q.id === item.id)) return false;
      if (isUnverified(item) && f.queue.filter((q) => q.state === "queued" && isUnverified(q)).length >= MAX_UNVERIFIED_QUEUED) return false;
      f.queue.push({ ...item, state: "queued", attempts: 0, nextAt: item.receivedAt, error: null, note: null });
      save(appId, f);
      return true;
    },
    async due(appId, now, limit = 50) {
      return load(appId)
        .queue.filter((q) => q.state === "queued" && (!q.nextAt || Date.parse(q.nextAt) <= now.getTime()))
        .sort((a, b) => Number(isUnverified(a)) - Number(isUnverified(b))) // verified first (stable: oldest first within each)
        .slice(0, limit);
    },
    async settle(appId, id, r) {
      const f = load(appId);
      f.queue = f.queue.map((q) =>
        q.id === id
          ? { ...q, state: r.state, attempts: q.attempts + 1, error: r.error ?? null, nextAt: r.nextAt ?? null, note: r.note ?? q.note, payload: r.keepPayload || r.state === "queued" ? q.payload : null }
          : q,
      );
      save(appId, f);
    },
    async queue(appId, limit = 50) {
      return load(appId).queue.slice(-limit).reverse();
    },
    async record(appId, records) {
      const f = load(appId);
      const have = new Map(f.records.map((r, i) => [r.id, i]));
      let added = 0;
      for (const r of records) {
        const i = have.get(r.id);
        if (i === undefined) {
          have.set(r.id, f.records.length);
          f.records.push(r);
          added++;
        } else f.records[i] = r;
      }
      save(appId, f);
      return added;
    },
    async records(appId, since) {
      return load(appId).records.filter((r) => Date.parse(r.at) >= since.getTime());
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

type QueueRow = { id: string; store: QueueItem["store"]; received_at: Date | string; state: QueueItem["state"]; attempts: number; next_at: Date | string | null; error: string | null; payload: Record<string, unknown> | string | null; note: string | null };
type RecordRow = {
  id: string;
  store: StoreId;
  type: MoneyEventType;
  kind: RevenueKind;
  product_id: string | null;
  at: Date | string;
  amount: string | number;
  currency: string;
  user_hash: string | null;
  variants: Record<string, string> | string | null;
  source: string | null;
  chain: string | null;
  sandbox: boolean;
  expires_at: Date | string | null;
};

const iso = (d: Date | string) => new Date(d).toISOString();
const parsed = <T>(v: T | string | null): T | null => (typeof v === "string" ? (JSON.parse(v) as T) : v);
const toItem = (r: QueueRow): QueueItem => ({
  id: r.id,
  store: r.store,
  receivedAt: iso(r.received_at),
  state: r.state,
  attempts: r.attempts,
  nextAt: r.next_at ? iso(r.next_at) : null,
  error: r.error,
  payload: parsed(r.payload),
  note: r.note,
});

export function dbMoneyLedger(sql: SQL): MoneyLedger {
  return {
    async enqueue(appId, item) {
      if (isUnverified(item)) {
        const [w] = (await sql`SELECT count(*)::int AS n FROM money_queue WHERE app_id = ${appId} AND state = 'queued' AND payload->>'unverified' = 'true'`) as Array<{ n: number }>;
        if ((w?.n ?? 0) >= MAX_UNVERIFIED_QUEUED) return false;
      }
      const rows = await sql`INSERT INTO money_queue (app_id, id, store, received_at, state, attempts, next_at, payload)
        VALUES (${appId}, ${item.id}, ${item.store}, ${item.receivedAt}, 'queued', 0, ${item.receivedAt}, ${item.payload ? JSON.stringify(item.payload) : null}::jsonb)
        ON CONFLICT (app_id, id) DO NOTHING RETURNING id`;
      return rows.length > 0;
    },
    async due(appId, now, limit = 50) {
      const rows = (await sql`SELECT * FROM money_queue WHERE app_id = ${appId} AND state = 'queued' AND (next_at IS NULL OR next_at <= ${now.toISOString()})
        ORDER BY (COALESCE(payload->>'unverified', 'false') = 'true'), received_at LIMIT ${limit}`) as QueueRow[];
      return rows.map(toItem);
    },
    async settle(appId, id, r) {
      const clear = !(r.keepPayload || r.state === "queued");
      await sql`UPDATE money_queue SET state = ${r.state}, attempts = attempts + 1, error = ${r.error ?? null}, next_at = ${r.nextAt ?? null},
        note = COALESCE(${r.note ?? null}, note), payload = CASE WHEN ${clear} THEN NULL ELSE payload END WHERE app_id = ${appId} AND id = ${id}`;
    },
    async queue(appId, limit = 50) {
      const rows = (await sql`SELECT * FROM money_queue WHERE app_id = ${appId} ORDER BY received_at DESC LIMIT ${limit}`) as QueueRow[];
      return rows.map(toItem);
    },
    async record(appId, records) {
      let added = 0;
      for (const r of records) {
        const rows = (await sql`INSERT INTO money_records (app_id, id, store, type, kind, product_id, at, amount, currency, user_hash, variants, source, chain, sandbox, expires_at)
          VALUES (${appId}, ${r.id}, ${r.store}, ${r.type}, ${r.kind}, ${r.productId}, ${r.at}, ${r.amount}, ${r.currency}, ${r.user}, ${JSON.stringify(r.variants)}::jsonb, ${r.source}, ${r.chain}, ${r.sandbox}, ${r.expiresAt})
          ON CONFLICT (app_id, id) DO UPDATE SET amount = EXCLUDED.amount, user_hash = COALESCE(EXCLUDED.user_hash, money_records.user_hash), variants = EXCLUDED.variants, source = EXCLUDED.source
          RETURNING (xmax = 0) AS inserted`) as Array<{ inserted: boolean }>;
        if (rows[0]?.inserted) added++;
      }
      return added;
    },
    async records(appId, since) {
      const rows = (await sql`SELECT * FROM money_records WHERE app_id = ${appId} AND at >= ${since.toISOString()} ORDER BY at`) as RecordRow[];
      return rows.map((r) => ({
        id: r.id,
        store: r.store,
        type: r.type,
        kind: r.kind,
        productId: r.product_id,
        at: iso(r.at),
        amount: Number(r.amount),
        currency: r.currency,
        user: r.user_hash,
        variants: parsed(r.variants) ?? {},
        source: r.source,
        chain: r.chain,
        sandbox: r.sandbox,
        expiresAt: r.expires_at ? iso(r.expires_at) : null,
      }));
    },
  };
}
