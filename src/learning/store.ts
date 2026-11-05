import type { SQL } from "bun";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Outcome } from "./library";
import { forgetInPlaybook, type OpenFailure, type PlaybookEntry } from "./playbook";
import type { ChangeKind } from "./taxonomy";

/**
 * The platform's learning store — one for all apps of all accounts: the
 * outcome library, the build playbook (and failures waiting for their fix),
 * false-positive candidates for review, and each account's opt-out.
 * `day2-learning.json` in day2's data folder (local mode), or the tables of
 * migration 023_learning.sql (accounts mode).
 */

export type FpCandidate = { id: string; persona: string; text: string; status: "candidate" | "approved" | "dismissed"; seen: number; createdAt: string; updatedAt: string };

export type PlaybookState = { entries: PlaybookEntry[]; open: OpenFailure[] };

export interface LearningStore {
  /** False when the same result was recorded before. */
  record(o: Outcome): Promise<boolean>;
  outcomes(q?: { kind?: ChangeKind }): Promise<Outcome[]>;
  playbook(): Promise<PlaybookState>;
  updatePlaybook<T>(fn: (s: PlaybookState) => { state: PlaybookState; result: T }): Promise<T>;
  candidates(): Promise<FpCandidate[]>;
  addCandidate(persona: string, text: string, now: Date): Promise<void>;
  setCandidate(id: string, status: FpCandidate["status"], now: Date): Promise<FpCandidate | null>;
  /** Whether the account shares anonymous outcomes (default yes). */
  sharing(accountId: string): Promise<boolean>;
  setSharing(accountId: string, on: boolean): Promise<void>;
  /**
   * Removes everything of these accounts and/or apps: their outcomes, open
   * build failures and their hashes on playbook entries (an account that
   * stops sharing, an app that's deleted). Returns how many outcomes went.
   */
  forget(who: { accounts?: string[]; apps?: string[] }): Promise<number>;
}

type FileDoc = { outcomes: Outcome[]; playbook: PlaybookState; candidates: FpCandidate[]; optedOut: string[] };
const empty = (): FileDoc => ({ outcomes: [], playbook: { entries: [], open: [] }, candidates: [], optedOut: [] });
const KEEP_OUTCOMES = 50_000;

const sameText = (a: string, b: string) => a.toLowerCase().replace(/\W+/g, " ").trim() === b.toLowerCase().replace(/\W+/g, " ").trim();

export function fileLearningStore(path: string): LearningStore {
  let chain: Promise<unknown> = Promise.resolve();
  const read = (): FileDoc => {
    if (!existsSync(path)) return empty();
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<FileDoc>;
      return { ...empty(), ...raw, playbook: { entries: raw.playbook?.entries ?? [], open: raw.playbook?.open ?? [] } };
    } catch {
      return empty();
    }
  };
  const write = (d: FileDoc) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(d)}\n`);
    renameSync(tmp, path);
  };
  const change = <T>(fn: (d: FileDoc) => { doc: FileDoc | null; result: T }): Promise<T> => {
    const run = chain.catch(() => undefined).then(() => {
      const r = fn(read());
      if (r.doc) write(r.doc);
      return r.result;
    });
    chain = run;
    return run;
  };
  return {
    record: (o) =>
      change((d) => {
        if (d.outcomes.some((x) => x.refHash === o.refHash)) return { doc: null, result: false };
        return { doc: { ...d, outcomes: [...d.outcomes, o].slice(-KEEP_OUTCOMES) }, result: true };
      }),
    async outcomes(q) {
      const all = read().outcomes;
      return q?.kind ? all.filter((o) => o.kind === q.kind) : all;
    },
    async playbook() {
      return read().playbook;
    },
    updatePlaybook: (fn) =>
      change((d) => {
        const r = fn(d.playbook);
        return { doc: { ...d, playbook: r.state }, result: r.result };
      }),
    async candidates() {
      return read().candidates;
    },
    addCandidate: (persona, text, now) =>
      change((d) => {
        const at = now.toISOString();
        const same = d.candidates.find((c) => c.persona === persona && sameText(c.text, text));
        const candidates = same ? d.candidates.map((c) => (c.id === same.id ? { ...c, seen: c.seen + 1, updatedAt: at } : c)) : [{ id: `fp-${randomUUID().slice(0, 8)}`, persona, text, status: "candidate" as const, seen: 1, createdAt: at, updatedAt: at }, ...d.candidates].slice(0, 500);
        return { doc: { ...d, candidates }, result: undefined };
      }),
    setCandidate: (id, status, now) =>
      change((d) => {
        const c = d.candidates.find((x) => x.id === id);
        if (!c) return { doc: null, result: null };
        const next = { ...c, status, updatedAt: now.toISOString() };
        return { doc: { ...d, candidates: d.candidates.map((x) => (x.id === id ? next : x)) }, result: next };
      }),
    async sharing(accountId) {
      return !read().optedOut.includes(accountId);
    },
    setSharing: (accountId, on) =>
      change((d) => ({ doc: { ...d, optedOut: on ? d.optedOut.filter((x) => x !== accountId) : [...new Set([...d.optedOut, accountId])] }, result: undefined })),
    forget: (who) =>
      change((d) => {
        const accounts = new Set(who.accounts ?? []);
        const apps = new Set(who.apps ?? []);
        const outcomes = d.outcomes.filter((o) => !accounts.has(o.accountHash) && !apps.has(o.appHash));
        return { doc: { ...d, outcomes, playbook: forgetInPlaybook(d.playbook, who) }, result: d.outcomes.length - outcomes.length };
      }),
  };
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: Date | string) => new Date(v).toISOString();
const parse = <T>(v: unknown, fallback: T): T => (v === null || v === undefined ? fallback : typeof v === "string" ? (JSON.parse(v) as T) : (v as T));
const LOCK = 7_207_323;

type OutcomeRow = { id: string; at: Date | string; app_hash: string; account_hash: string; ref_hash: string; category: string; product_type: string; platform: string; kind: string; pattern: string; metric: string; effect: unknown; low: unknown; high: unknown; n_bucket: string; verdict: string; source: string };

const fromOutcomeRow = (r: OutcomeRow): Outcome => ({
  id: r.id,
  at: iso(r.at).slice(0, 10),
  appHash: r.app_hash,
  accountHash: r.account_hash,
  refHash: r.ref_hash,
  category: r.category as Outcome["category"],
  productType: r.product_type as Outcome["productType"],
  platform: r.platform as Outcome["platform"],
  kind: r.kind as Outcome["kind"],
  pattern: r.pattern,
  metric: r.metric as Outcome["metric"],
  effect: num(r.effect),
  low: num(r.low),
  high: num(r.high),
  n: r.n_bucket as Outcome["n"],
  verdict: r.verdict as Outcome["verdict"],
  source: r.source as Outcome["source"],
});

type EntryRow = { id: string; key: string; framework: string; pkg: string | null; error_type: string; fix: string; status: string; apps: unknown; fixed_in: unknown; seen: number; created_at: Date | string; updated_at: Date | string };
type FailRow = { ref: string; app_hash: string; account_hash: string; key: string; framework: string; pkg: string | null; error_type: string; at: Date | string };
type FpRow = { id: string; persona: string; text: string; status: string; seen: number; created_at: Date | string; updated_at: Date | string };

const fromEntry = (r: EntryRow): PlaybookEntry => ({ id: r.id, key: r.key, framework: r.framework, pkg: r.pkg, errorType: r.error_type, fix: r.fix, status: r.status as PlaybookEntry["status"], apps: parse(r.apps, []), fixedIn: parse(r.fixed_in, []), seen: Number(r.seen), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });
const fromFail = (r: FailRow): OpenFailure => ({ ref: r.ref, app: r.app_hash, account: r.account_hash, key: r.key, framework: r.framework, pkg: r.pkg, errorType: r.error_type, at: iso(r.at) });
const fromFp = (r: FpRow): FpCandidate => ({ id: r.id, persona: r.persona, text: r.text, status: r.status as FpCandidate["status"], seen: Number(r.seen), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });

export function dbLearningStore(sql: SQL): LearningStore {
  return {
    async record(o) {
      const rows = (await sql`INSERT INTO learning_outcomes (id, at, app_hash, account_hash, ref_hash, category, product_type, platform, kind, pattern, metric, effect, low, high, n_bucket, verdict, source)
        VALUES (${o.id}, ${o.at}, ${o.appHash}, ${o.accountHash}, ${o.refHash}, ${o.category}, ${o.productType}, ${o.platform}, ${o.kind}, ${o.pattern}, ${o.metric}, ${o.effect}, ${o.low}, ${o.high}, ${o.n}, ${o.verdict}, ${o.source})
        ON CONFLICT (ref_hash) DO NOTHING RETURNING id`) as unknown[];
      return rows.length > 0;
    },
    async outcomes(q) {
      const rows = (q?.kind ? await sql`SELECT * FROM learning_outcomes WHERE kind = ${q.kind} ORDER BY at` : await sql`SELECT * FROM learning_outcomes ORDER BY at`) as OutcomeRow[];
      return rows.map(fromOutcomeRow);
    },
    async playbook() {
      const entries = ((await sql`SELECT * FROM learning_playbook ORDER BY updated_at DESC`) as EntryRow[]).map(fromEntry);
      const open = ((await sql`SELECT * FROM learning_failures ORDER BY at DESC`) as FailRow[]).map(fromFail);
      return { entries, open };
    },
    async updatePlaybook(fn) {
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${LOCK})`;
        const entries = ((await tx`SELECT * FROM learning_playbook`) as EntryRow[]).map(fromEntry);
        const open = ((await tx`SELECT * FROM learning_failures`) as FailRow[]).map(fromFail);
        const r = fn({ entries, open });
        const before = new Map(entries.map((e) => [e.id, JSON.stringify(e)]));
        for (const e of r.state.entries) {
          if (before.get(e.id) === JSON.stringify(e)) continue;
          await tx`INSERT INTO learning_playbook (id, key, framework, pkg, error_type, fix, status, apps, fixed_in, seen, created_at, updated_at)
            VALUES (${e.id}, ${e.key}, ${e.framework}, ${e.pkg}, ${e.errorType}, ${e.fix}, ${e.status}, ${JSON.stringify(e.apps)}::jsonb, ${JSON.stringify(e.fixedIn)}::jsonb, ${e.seen}, ${e.createdAt}, ${e.updatedAt})
            ON CONFLICT (id) DO UPDATE SET fix = EXCLUDED.fix, status = EXCLUDED.status, apps = EXCLUDED.apps, fixed_in = EXCLUDED.fixed_in, seen = EXCLUDED.seen, updated_at = EXCLUDED.updated_at`;
        }
        const keep = new Set(r.state.entries.map((e) => e.id));
        for (const id of before.keys()) if (!keep.has(id)) await tx`DELETE FROM learning_playbook WHERE id = ${id}`;
        const openNow = new Set(r.state.open.map((f) => f.ref));
        for (const f of open) if (!openNow.has(f.ref)) await tx`DELETE FROM learning_failures WHERE ref = ${f.ref}`;
        const had = new Map(open.map((f) => [f.ref, JSON.stringify(f)]));
        for (const f of r.state.open) {
          if (had.get(f.ref) === JSON.stringify(f)) continue;
          await tx`INSERT INTO learning_failures (ref, app_hash, account_hash, key, framework, pkg, error_type, at) VALUES (${f.ref}, ${f.app}, ${f.account}, ${f.key}, ${f.framework}, ${f.pkg}, ${f.errorType}, ${f.at})
            ON CONFLICT (ref) DO UPDATE SET key = EXCLUDED.key, framework = EXCLUDED.framework, pkg = EXCLUDED.pkg, error_type = EXCLUDED.error_type, at = EXCLUDED.at`;
        }
        return r.result;
      });
    },
    async candidates() {
      return ((await sql`SELECT * FROM learning_fp_candidates ORDER BY updated_at DESC`) as FpRow[]).map(fromFp);
    },
    async addCandidate(persona, text, now) {
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${LOCK + 1})`;
        const all = ((await tx`SELECT * FROM learning_fp_candidates WHERE persona = ${persona}`) as FpRow[]).map(fromFp);
        const same = all.find((c) => sameText(c.text, text));
        if (same) await tx`UPDATE learning_fp_candidates SET seen = seen + 1, updated_at = ${now.toISOString()} WHERE id = ${same.id}`;
        else await tx`INSERT INTO learning_fp_candidates (id, persona, text, status, seen, created_at, updated_at) VALUES (${`fp-${randomUUID().slice(0, 8)}`}, ${persona}, ${text}, 'candidate', 1, ${now.toISOString()}, ${now.toISOString()})`;
      });
    },
    async setCandidate(id, status, now) {
      const rows = (await sql`UPDATE learning_fp_candidates SET status = ${status}, updated_at = ${now.toISOString()} WHERE id = ${id} RETURNING *`) as FpRow[];
      return rows[0] ? fromFp(rows[0]) : null;
    },
    async sharing(accountId) {
      const rows = (await sql`SELECT share FROM learning_settings WHERE account_id = ${accountId}`) as Array<{ share: boolean }>;
      return rows[0]?.share ?? true;
    },
    async setSharing(accountId, on) {
      await sql`INSERT INTO learning_settings (account_id, share) VALUES (${accountId}, ${on}) ON CONFLICT (account_id) DO UPDATE SET share = EXCLUDED.share, updated_at = now()`;
    },
    async forget(who) {
      const accounts = who.accounts ?? [];
      const apps = who.apps ?? [];
      if (!accounts.length && !apps.length) return 0;
      const none = ["-"]; // IN () needs at least one value; no hash is "-"
      const rows = (await sql`DELETE FROM learning_outcomes WHERE account_hash IN ${sql(accounts.length ? accounts : none)} OR app_hash IN ${sql(apps.length ? apps : none)} RETURNING id`) as unknown[];
      await this.updatePlaybook((s) => ({ state: forgetInPlaybook(s, who), result: null }));
      return rows.length;
    },
  };
}
