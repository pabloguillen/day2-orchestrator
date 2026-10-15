import type { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Batch, ContractFile, DeviceInfo, Failure } from "../packages/sensors/src/types";
import type { Candidate } from "./contracts-gen";
import type { EventLike } from "./metrics/types";

/**
 * What apps report from users' devices (packages/sensors), per app:
 * how often each contract held and broke per day, the failure reports in
 * full (30 days), growth events (180 days), and the contracts day2
 * generated from the app's code. Postgres in production, files locally.
 */

export const FAILURE_DAYS = 30;
export const EVENT_DAYS = 180;
const DAY = 86_400_000;

export type StoredFailure = Failure & { deviceId: string; release: string | null; device: DeviceInfo };

export type ContractHealth = {
  contract: string;
  passes: number;
  failures: number;
  /** Input the app rejected and said so: working as designed. */
  rejected: number;
  /** Distinct devices among the reported failures. */
  devices: number;
  firstFailureAt: string | null;
  lastFailureAt: string | null;
  sample: StoredFailure | null;
};

export type FieldMeta = { lastSeenAt: string; lastRelease: string | null; platforms: string[] };
export type StoredContracts = { file: ContractFile; candidates: Candidate[]; head: string | null; generatedAt: string };

export interface FieldStore {
  record(appId: string, batch: Batch, now: Date): Promise<void>;
  health(appId: string, since: Date): Promise<ContractHealth[]>;
  failures(appId: string, contract: string, limit: number): Promise<StoredFailure[]>;
  events(appId: string, since: Date): Promise<EventLike[]>;
  meta(appId: string): Promise<FieldMeta | null>;
  setContracts(appId: string, c: Omit<StoredContracts, "generatedAt">, now: Date): Promise<void>;
  contracts(appId: string): Promise<StoredContracts | null>;
  prune(now: Date): Promise<void>;
}

export interface IngestKeys {
  /** The app's key, made on first use. */
  forApp(appId: string): Promise<string>;
  /** Which app a key belongs to. */
  resolve(key: string): Promise<{ appId: string; accountId: string } | null>;
}

export const newIngestKey = () => `d2k_${randomBytes(18).toString("base64url")}`;
export const INGEST_KEY_RE = /^d2k_[A-Za-z0-9_-]{20,40}$/;

const dayOf = (iso: string) => iso.slice(0, 10);

/** Splits a batch's counters: held, broken beyond what was reported in full, rejected input. */
function counters(batch: Batch): Array<{ contract: string; passes: number; failures: number }> {
  const m = new Map<string, { passes: number; failures: number }>();
  const get = (c: string) => {
    let v = m.get(c);
    if (!v) m.set(c, (v = { passes: 0, failures: 0 }));
    return v;
  };
  for (const [k, n] of Object.entries(batch.passes)) {
    if (k.endsWith("#failed")) get(k.slice(0, -7)).failures += n;
    else get(k).passes += n; // "<id>#rejected" stays its own counter
  }
  for (const f of batch.failures) get(f.contract).failures += 1;
  return [...m.entries()].map(([contract, v]) => ({ contract, ...v }));
}

function mergeHealth(
  rows: Array<{ contract: string; passes: number; failures: number }>,
  failureInfo: Map<string, { devices: number; first: string | null; last: string | null; sample: StoredFailure | null }>,
): ContractHealth[] {
  const by = new Map<string, ContractHealth>();
  const get = (c: string) => {
    let h = by.get(c);
    if (!h) {
      const fi = failureInfo.get(c);
      h = { contract: c, passes: 0, failures: 0, rejected: 0, devices: fi?.devices ?? 0, firstFailureAt: fi?.first ?? null, lastFailureAt: fi?.last ?? null, sample: fi?.sample ?? null };
      by.set(c, h);
    }
    return h;
  };
  for (const r of rows) {
    if (r.contract.endsWith("#rejected")) get(r.contract.slice(0, -9)).rejected += r.passes;
    else {
      const h = get(r.contract);
      h.passes += r.passes;
      h.failures += r.failures;
    }
  }
  return [...by.values()].sort((a, b) => b.failures - a.failures || a.contract.localeCompare(b.contract));
}

// ---------------------------------------------------------------------------
// Files (local mode)
// ---------------------------------------------------------------------------

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

function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
}

export function fileFieldStore(root: string): FieldStore {
  const dir = (appId: string) => join(root, appId.replace(/[^A-Za-z0-9_-]/g, "_"));
  type Counts = Record<string, { p: number; f: number }>;
  return {
    async record(appId, batch, now) {
      const d = dir(appId);
      mkdirSync(d, { recursive: true });
      const counts = readJson<Counts>(join(d, "counts.json"), {});
      const day = dayOf(now.toISOString());
      for (const c of counters(batch)) {
        const k = `${c.contract}|${day}`;
        const v = (counts[k] ??= { p: 0, f: 0 });
        v.p += c.passes;
        v.f += c.failures;
      }
      writeJson(join(d, "counts.json"), counts);
      const { id: deviceId, ...device } = batch.device;
      for (const f of batch.failures) appendFileSync(join(d, "failures.jsonl"), `${JSON.stringify({ ...f, deviceId, release: batch.release ?? null, device: { id: deviceId, ...device } })}\n`);
      for (const e of batch.events) appendFileSync(join(d, "events.jsonl"), `${JSON.stringify({ type: e.type, at: e.at, deviceId, ...(e.acquisition ? { acquisition: e.acquisition } : {}) })}\n`);
      const meta = readJson<FieldMeta | null>(join(d, "meta.json"), null);
      writeJson(join(d, "meta.json"), {
        lastSeenAt: now.toISOString(),
        lastRelease: batch.release ?? meta?.lastRelease ?? null,
        platforms: [...new Set([...(meta?.platforms ?? []), batch.device.platform])],
      } satisfies FieldMeta);
    },
    async health(appId, since) {
      const counts = readJson<Counts>(join(dir(appId), "counts.json"), {});
      const from = dayOf(since.toISOString());
      const rows = Object.entries(counts)
        .filter(([k]) => k.slice(k.lastIndexOf("|") + 1) >= from)
        .map(([k, v]) => ({ contract: k.slice(0, k.lastIndexOf("|")), passes: v.p, failures: v.f }));
      const info = new Map<string, { devices: number; first: string | null; last: string | null; sample: StoredFailure | null }>();
      const devs = new Map<string, Set<string>>();
      for (const f of readLines<StoredFailure>(join(dir(appId), "failures.jsonl"))) {
        if (f.at < since.toISOString()) continue;
        const cur = info.get(f.contract) ?? { devices: 0, first: f.at, last: f.at, sample: f };
        if (f.at < cur.first!) cur.first = f.at;
        if (f.at >= cur.last!) {
          cur.last = f.at;
          cur.sample = f;
        }
        const s = devs.get(f.contract) ?? new Set();
        s.add(f.deviceId);
        devs.set(f.contract, s);
        cur.devices = s.size;
        info.set(f.contract, cur);
      }
      return mergeHealth(rows, info);
    },
    async failures(appId, contract, limit) {
      return readLines<StoredFailure>(join(dir(appId), "failures.jsonl"))
        .filter((f) => f.contract === contract)
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, limit);
    },
    async events(appId, since) {
      const s = since.toISOString();
      return readLines<EventLike>(join(dir(appId), "events.jsonl")).filter((e) => e.at >= s);
    },
    async meta(appId) {
      return readJson<FieldMeta | null>(join(dir(appId), "meta.json"), null);
    },
    async setContracts(appId, c, now) {
      writeJson(join(dir(appId), "contracts.json"), { ...c, generatedAt: now.toISOString() });
    },
    async contracts(appId) {
      return readJson<StoredContracts | null>(join(dir(appId), "contracts.json"), null);
    },
    async prune(now) {
      if (!existsSync(root)) return;
      const { readdirSync } = await import("node:fs");
      const failCut = new Date(now.getTime() - FAILURE_DAYS * DAY).toISOString();
      const eventCut = new Date(now.getTime() - EVENT_DAYS * DAY).toISOString();
      for (const app of readdirSync(root)) {
        const d = join(root, app);
        for (const [f, cut] of [
          ["failures.jsonl", failCut],
          ["events.jsonl", eventCut],
        ] as const) {
          const p = join(d, f);
          if (!existsSync(p)) continue;
          const keep = readLines<{ at: string }>(p).filter((x) => x.at >= cut);
          writeFileSync(p, keep.map((x) => JSON.stringify(x)).join("\n") + (keep.length ? "\n" : ""));
        }
        const counts = readJson<Counts>(join(d, "counts.json"), {});
        const dayCut = dayOf(eventCut);
        writeJson(join(d, "counts.json"), Object.fromEntries(Object.entries(counts).filter(([k]) => k.slice(k.lastIndexOf("|") + 1) >= dayCut)));
      }
    },
  };
}

export function fileIngestKeys(path: string, accountId: string): IngestKeys {
  const load = () => readJson<Record<string, string>>(path, {});
  return {
    async forApp(appId) {
      const all = load();
      if (all[appId]) return all[appId]!;
      all[appId] = newIngestKey();
      writeJson(path, all);
      return all[appId]!;
    },
    async resolve(key) {
      const hit = Object.entries(load()).find(([, k]) => k === key);
      return hit ? { appId: hit[0], accountId } : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres (accounts mode)
// ---------------------------------------------------------------------------

type FailureRow = { at: Date | string; device_id: string; release: string | null; device: DeviceInfo | string; report: Failure | string };
const parse = <T>(v: T | string): T => (typeof v === "string" ? (JSON.parse(v) as T) : v);
const toFailure = (r: FailureRow): StoredFailure => ({ ...parse(r.report), deviceId: r.device_id, release: r.release, device: parse(r.device) });

export function dbFieldStore(sql: SQL): FieldStore {
  return {
    async record(appId, batch, now) {
      const day = dayOf(now.toISOString());
      await sql.begin(async (tx) => {
        for (const c of counters(batch)) {
          await tx`INSERT INTO field_counts (app_id, contract, day, passes, failures) VALUES (${appId}, ${c.contract.slice(0, 300)}, ${day}, ${c.passes}, ${c.failures})
                   ON CONFLICT (app_id, contract, day) DO UPDATE SET passes = field_counts.passes + EXCLUDED.passes, failures = field_counts.failures + EXCLUDED.failures`;
        }
        for (const f of batch.failures) {
          await tx`INSERT INTO field_failures (app_id, contract, at, device_id, release, device, report)
                   VALUES (${appId}, ${f.contract.slice(0, 300)}, ${f.at}, ${batch.device.id}, ${batch.release ?? null}, ${batch.device}::jsonb, ${f}::jsonb)`;
        }
        for (const e of batch.events) {
          await tx`INSERT INTO field_events (app_id, at, device_id, type, acquisition) VALUES (${appId}, ${e.at}, ${batch.device.id}, ${e.type}, ${e.acquisition ?? null}::jsonb)`;
        }
        await tx`INSERT INTO field_meta (app_id, last_seen_at, last_release, platforms) VALUES (${appId}, ${now.toISOString()}, ${batch.release ?? null}, ARRAY[${batch.device.platform}]::text[])
                 ON CONFLICT (app_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at,
                   last_release = COALESCE(EXCLUDED.last_release, field_meta.last_release),
                   platforms = (SELECT array_agg(DISTINCT p) FROM unnest(field_meta.platforms || EXCLUDED.platforms) AS p)`;
      });
    },
    async health(appId, since) {
      const rows = (await sql`SELECT contract, SUM(passes)::int AS passes, SUM(failures)::int AS failures FROM field_counts
                              WHERE app_id = ${appId} AND day >= ${dayOf(since.toISOString())} GROUP BY contract`) as Array<{ contract: string; passes: number; failures: number }>;
      const fails = (await sql`SELECT contract, COUNT(DISTINCT device_id)::int AS devices, MIN(at) AS first, MAX(at) AS last FROM field_failures
                               WHERE app_id = ${appId} AND at >= ${since.toISOString()} GROUP BY contract`) as Array<{ contract: string; devices: number; first: Date; last: Date }>;
      const latest = (await sql`SELECT DISTINCT ON (contract) contract, at, device_id, release, device, report FROM field_failures
                                WHERE app_id = ${appId} AND at >= ${since.toISOString()} ORDER BY contract, at DESC`) as Array<FailureRow & { contract: string }>;
      const info = new Map<string, { devices: number; first: string | null; last: string | null; sample: StoredFailure | null }>();
      for (const f of fails) info.set(f.contract, { devices: f.devices, first: new Date(f.first).toISOString(), last: new Date(f.last).toISOString(), sample: null });
      for (const l of latest) {
        const cur = info.get(l.contract);
        if (cur) cur.sample = toFailure(l);
      }
      return mergeHealth(rows, info);
    },
    async failures(appId, contract, limit) {
      const rows = (await sql`SELECT at, device_id, release, device, report FROM field_failures WHERE app_id = ${appId} AND contract = ${contract} ORDER BY at DESC LIMIT ${limit}`) as FailureRow[];
      return rows.map(toFailure);
    },
    async events(appId, since) {
      const rows = (await sql`SELECT at, device_id, type, acquisition FROM field_events WHERE app_id = ${appId} AND at >= ${since.toISOString()} ORDER BY at`) as Array<{
        at: Date;
        device_id: string;
        type: string;
        acquisition: EventLike["acquisition"] | string | null;
      }>;
      return rows.map((r) => ({ type: r.type, at: new Date(r.at).toISOString(), deviceId: r.device_id, ...(r.acquisition ? { acquisition: parse(r.acquisition) } : {}) }));
    },
    async meta(appId) {
      const rows = (await sql`SELECT last_seen_at, last_release, platforms FROM field_meta WHERE app_id = ${appId}`) as Array<{ last_seen_at: Date; last_release: string | null; platforms: string[] }>;
      const r = rows[0];
      return r ? { lastSeenAt: new Date(r.last_seen_at).toISOString(), lastRelease: r.last_release, platforms: r.platforms } : null;
    },
    async setContracts(appId, c, now) {
      await sql`INSERT INTO app_contracts (app_id, head, file, candidates, generated_at) VALUES (${appId}, ${c.head}, ${c.file}::jsonb, ${c.candidates}::jsonb, ${now.toISOString()})
                ON CONFLICT (app_id) DO UPDATE SET head = EXCLUDED.head, file = EXCLUDED.file, candidates = EXCLUDED.candidates, generated_at = EXCLUDED.generated_at`;
    },
    async contracts(appId) {
      const rows = (await sql`SELECT head, file, candidates, generated_at FROM app_contracts WHERE app_id = ${appId}`) as Array<{
        head: string | null;
        file: ContractFile | string;
        candidates: Candidate[] | string;
        generated_at: Date;
      }>;
      const r = rows[0];
      return r ? { head: r.head, file: parse(r.file), candidates: parse(r.candidates), generatedAt: new Date(r.generated_at).toISOString() } : null;
    },
    async prune(now) {
      await sql`DELETE FROM field_failures WHERE at < ${new Date(now.getTime() - FAILURE_DAYS * DAY).toISOString()}`;
      await sql`DELETE FROM field_events WHERE at < ${new Date(now.getTime() - EVENT_DAYS * DAY).toISOString()}`;
      await sql`DELETE FROM field_counts WHERE day < ${dayOf(new Date(now.getTime() - EVENT_DAYS * DAY).toISOString())}`;
    },
  };
}

export function dbIngestKeys(sql: SQL): IngestKeys {
  return {
    async forApp(appId) {
      const have = (await sql`SELECT key FROM app_ingest_keys WHERE app_id = ${appId}`) as Array<{ key: string }>;
      if (have[0]) return have[0].key;
      const key = newIngestKey();
      await sql`INSERT INTO app_ingest_keys (app_id, key) VALUES (${appId}, ${key}) ON CONFLICT (app_id) DO NOTHING`;
      const again = (await sql`SELECT key FROM app_ingest_keys WHERE app_id = ${appId}`) as Array<{ key: string }>;
      return again[0]!.key;
    },
    async resolve(key) {
      const rows = (await sql`SELECT k.app_id, a.account_id FROM app_ingest_keys k JOIN apps a ON a.id = k.app_id WHERE k.key = ${key}`) as Array<{ app_id: string; account_id: string }>;
      return rows[0] ? { appId: rows[0].app_id, accountId: rows[0].account_id } : null;
    },
  };
}
