import type { SQL } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appDir } from "./tokens";
import { DEFAULT_SETTINGS, SENDS_KEEP_DAYS, type MessagesSettings, type MessagesState, type SendRecord, type SendStatus } from "./types";

/**
 * Messages' own store: settings and campaigns per app, and one record per
 * planned/held/sent message per user (no token, no text). Files locally
 * (`<data>/messages/<app>/`), Postgres in accounts mode (016_messages.sql).
 */

export type SendQuery = { since?: Date; status?: SendStatus[]; campaignId?: string };

export interface MessagesStore {
  state(appId: string): Promise<MessagesState>;
  setState(appId: string, state: MessagesState, now: Date): Promise<void>;
  addSends(appId: string, records: SendRecord[]): Promise<void>;
  updateSends(appId: string, patches: Array<Pick<SendRecord, "id"> & Partial<SendRecord>>): Promise<void>;
  /** `since` filters on eligibleAt. */
  sends(appId: string, q?: SendQuery): Promise<SendRecord[]>;
  prune(now: Date): Promise<void>;
}

const DAY = 86_400_000;
const KEEP_LOG = 60;

export function emptyState(): MessagesState {
  return { settings: { ...DEFAULT_SETTINGS, quietHours: { ...DEFAULT_SETTINGS.quietHours }, autonomy: { ...DEFAULT_SETTINGS.autonomy } }, campaigns: [], ran: {}, setupTicketId: null, problem: null, log: [] };
}

/** Pure. Fills what an older or partial state lacks. */
export function normalizeState(raw: Partial<MessagesState> | null | undefined): MessagesState {
  const e = emptyState();
  if (!raw || typeof raw !== "object") return e;
  const s = (raw.settings ?? {}) as Partial<MessagesSettings>;
  return {
    settings: {
      ...e.settings,
      ...s,
      quietHours: { ...e.settings.quietHours, ...(s.quietHours ?? {}) },
      autonomy: { ...e.settings.autonomy, ...(s.autonomy ?? {}) },
    },
    campaigns: Array.isArray(raw.campaigns) ? raw.campaigns : [],
    ran: raw.ran ?? {},
    setupTicketId: raw.setupTicketId ?? null,
    problem: raw.problem ?? null,
    log: Array.isArray(raw.log) ? raw.log.slice(0, KEEP_LOG) : [],
  };
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}

const matches = (r: SendRecord, q: SendQuery) =>
  (!q.since || r.eligibleAt >= q.since.toISOString()) && (!q.status || q.status.includes(r.status)) && (!q.campaignId || r.campaignId === q.campaignId);

export function fileMessagesStore(root: string): MessagesStore {
  const statePath = (appId: string) => join(appDir(root, appId), "messages.json");
  const sendsPath = (appId: string) => join(appDir(root, appId), "sends.json");
  const loadSends = (appId: string) => readJson<SendRecord[]>(sendsPath(appId), []);
  return {
    async state(appId) {
      return normalizeState(readJson<Partial<MessagesState> | null>(statePath(appId), null));
    },
    async setState(appId, state) {
      writeJson(statePath(appId), { ...state, log: state.log.slice(0, KEEP_LOG) });
    },
    async addSends(appId, records) {
      if (!records.length) return;
      const all = loadSends(appId);
      const have = new Set(all.map((r) => r.id));
      writeJson(sendsPath(appId), [...all, ...records.filter((r) => !have.has(r.id))]);
    },
    async updateSends(appId, patches) {
      if (!patches.length) return;
      const by = new Map(patches.map((p) => [p.id, p]));
      writeJson(
        sendsPath(appId),
        loadSends(appId).map((r) => (by.has(r.id) ? { ...r, ...by.get(r.id)! } : r)),
      );
    },
    async sends(appId, q = {}) {
      return loadSends(appId).filter((r) => matches(r, q));
    },
    async prune(now) {
      if (!existsSync(root)) return;
      const cut = new Date(now.getTime() - SENDS_KEEP_DAYS * DAY).toISOString();
      for (const appId of readdirSync(root)) {
        const all = loadSends(appId);
        const keep = all.filter((r) => r.eligibleAt >= cut);
        if (keep.length !== all.length) writeJson(sendsPath(appId), keep);
      }
    },
  };
}

type SendRow = {
  id: string;
  campaign_id: string;
  user_id: string;
  channel: SendRecord["channel"];
  arm: SendRecord["arm"];
  status: SendStatus;
  locale: SendRecord["locale"];
  eligible_at: Date;
  due_at: Date;
  expires_at: Date;
  sent_at: Date | null;
  receipts: SendRecord["receipts"] | string;
  error: string | null;
  checked_at: Date | null;
};
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const fromRow = (r: SendRow): SendRecord => ({
  id: r.id,
  campaignId: r.campaign_id,
  user: r.user_id,
  channel: r.channel,
  arm: r.arm,
  status: r.status,
  locale: r.locale,
  eligibleAt: iso(r.eligible_at)!,
  dueAt: iso(r.due_at)!,
  expiresAt: iso(r.expires_at)!,
  sentAt: iso(r.sent_at),
  receipts: typeof r.receipts === "string" ? (JSON.parse(r.receipts) as SendRecord["receipts"]) : (r.receipts ?? []),
  error: r.error,
  checkedAt: iso(r.checked_at),
});

export function dbMessagesStore(sql: SQL): MessagesStore {
  return {
    async state(appId) {
      const rows = (await sql`SELECT state FROM app_messages WHERE app_id = ${appId}`) as Array<{ state: MessagesState | string }>;
      const s = rows[0]?.state;
      return normalizeState(typeof s === "string" ? (JSON.parse(s) as MessagesState) : s);
    },
    async setState(appId, state, now) {
      const s = { ...state, log: state.log.slice(0, KEEP_LOG) };
      await sql`INSERT INTO app_messages (app_id, state, updated_at) VALUES (${appId}, ${s}::jsonb, ${now.toISOString()})
        ON CONFLICT (app_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`;
    },
    async addSends(appId, records) {
      for (const r of records) {
        await sql`INSERT INTO message_sends (id, app_id, campaign_id, user_id, channel, arm, status, locale, eligible_at, due_at, expires_at, sent_at, receipts, error, checked_at)
          VALUES (${r.id}, ${appId}, ${r.campaignId}, ${r.user}, ${r.channel}, ${r.arm}, ${r.status}, ${r.locale}, ${r.eligibleAt}, ${r.dueAt}, ${r.expiresAt}, ${r.sentAt}, ${r.receipts}::jsonb, ${r.error}, ${r.checkedAt})
          ON CONFLICT (id) DO NOTHING`;
      }
    },
    async updateSends(appId, patches) {
      for (const p of patches) {
        const [cur] = (await sql`SELECT * FROM message_sends WHERE app_id = ${appId} AND id = ${p.id}`) as SendRow[];
        if (!cur) continue;
        const r = { ...fromRow(cur), ...p };
        await sql`UPDATE message_sends SET status = ${r.status}, locale = ${r.locale}, due_at = ${r.dueAt}, expires_at = ${r.expiresAt}, sent_at = ${r.sentAt},
          receipts = ${r.receipts}::jsonb, error = ${r.error}, checked_at = ${r.checkedAt} WHERE app_id = ${appId} AND id = ${p.id}`;
      }
    },
    async sends(appId, q = {}) {
      const since = (q.since ?? new Date(0)).toISOString();
      const rows = (
        q.campaignId
          ? await sql`SELECT * FROM message_sends WHERE app_id = ${appId} AND campaign_id = ${q.campaignId} AND eligible_at >= ${since} ORDER BY eligible_at`
          : await sql`SELECT * FROM message_sends WHERE app_id = ${appId} AND eligible_at >= ${since} ORDER BY eligible_at`
      ) as SendRow[];
      return rows.map(fromRow).filter((r) => !q.status || q.status.includes(r.status));
    },
    async prune(now) {
      await sql`DELETE FROM message_sends WHERE eligible_at < ${new Date(now.getTime() - SENDS_KEEP_DAYS * DAY).toISOString()}`;
    },
  };
}
