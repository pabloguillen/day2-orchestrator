import type { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Batch, ContractFile, DeviceInfo, Failure } from "../packages/sensors/src/types";
import type { Candidate } from "./contracts-gen";
import type { EventLike } from "./metrics/types";
import type { RetentionSnapshot } from "./retention";

/**
 * What apps report from users' devices (packages/sensors), per app:
 * how often each contract held and broke per day, the failure reports in
 * full (30 days), growth events (180 days), and the contracts day2
 * generated from the app's code. Postgres in production, files locally.
 */

export const FAILURE_DAYS = 30;
export const EVENT_DAYS = 180;
/** Active days per user, for lifecycle states and return rates. */
export const USER_DAY_DAYS = 400;
/** A user's first/last seen, so someone back after a long time isn't "new". */
export const USER_DAYS = 730;
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
  /** Failures confirmed by day2's simulation (reproduced twice there). */
  simulated: number;
  firstFailureAt: string | null;
  lastFailureAt: string | null;
  sample: StoredFailure | null;
};

export type FieldMeta = { lastSeenAt: string; lastRelease: string | null; platforms: string[] };

/** One scheduled simulation run (simulation.ts). */
export type SimulationRun = {
  at: string;
  durationMs: number;
  profiles: string[];
  screens: number;
  actions: number;
  links: number;
  /** Confirmed failures (reproduced on a second try). */
  failures: number;
  /** Failures that didn't reproduce, so weren't recorded. */
  flaky: number;
  skipped: string[];
};

/** One user's activity: the days they were active (UTC, "YYYY-MM-DD"). */
export type UserActivity = { user: string; firstSeen: string; lastSeen: string; days: string[] };

/** Simulated devices carry ids starting with this. */
export const SIM_DEVICE_PREFIX = "sim-";
export type StoredContracts = { file: ContractFile; candidates: Candidate[]; head: string | null; generatedAt: string };

export interface FieldStore {
  record(appId: string, batch: Batch, now: Date): Promise<void>;
  health(appId: string, since: Date): Promise<ContractHealth[]>;
  failures(appId: string, contract: string, limit: number): Promise<StoredFailure[]>;
  events(appId: string, since: Date): Promise<EventLike[]>;
  meta(appId: string): Promise<FieldMeta | null>;
  setContracts(appId: string, c: Omit<StoredContracts, "generatedAt">, now: Date): Promise<void>;
  setSimulation(appId: string, run: SimulationRun): Promise<void>;
  simulation(appId: string): Promise<SimulationRun | null>;
  contracts(appId: string): Promise<StoredContracts | null>;
  /** Users last seen on or after `sinceDay` with their active days since then; plus how many were last seen before. */
  activity(appId: string, sinceDay: string): Promise<{ users: UserActivity[]; older: number }>;
  setRetention(appId: string, snapshot: RetentionSnapshot): Promise<void>;
  retention(appId: string): Promise<RetentionSnapshot | null>;
  /**
   * Per release key: devices (launches, by default) since `since`, and how
   * many of them crashed or hit each failing check. A key is a release the
   * app reports ("1.4.0(23)" = that store build without updates) or, starting
   * with "@", an over-the-air update on any build ("@a1b2c3d4" matches
   * "1.4.0(23)@a1b2c3d4" and "1.4.1(24)@a1b2c3d4"), or ending with "*", a
   * store build with or without updates ("1.4.0(23)*"). For comparing a new
   * release with the one before it.
   */
  releaseHealth(appId: string, releases: string[], since: Date): Promise<ReleaseHealth[]>;
  prune(now: Date): Promise<void>;
}

export type ReleaseHealth = { release: string; devices: number; crashed: number; failing: Record<string, number> };
/** Does a reported release belong to a release key (see releaseHealth)? "@id" = that update on any build; "1.4.0(23)*" = that build with or without updates; else exact. */
export const releaseMatches = (key: string, reported: string | null | undefined) =>
  Boolean(reported) && (key.startsWith("@") ? reported!.endsWith(key) : key.endsWith("*") ? reported!.startsWith(key.slice(0, -1)) : reported === key);
export const CRASH_CONTRACT = "builtin:stability.crash";

export interface IngestKeys {
  /** The app's key, made on first use. */
  forApp(appId: string): Promise<string>;
  /** Which app a key belongs to. */
  resolve(key: string): Promise<{ appId: string; accountId: string } | null>;
}

export const newIngestKey = () => `d2k_${randomBytes(18).toString("base64url")}`;
export const INGEST_KEY_RE = /^d2k_[A-Za-z0-9_-]{20,40}$/;

const dayOf = (iso: string) => iso.slice(0, 10);

/** An event as stored: who (hashed), what, props and money, and the batch's Live assignments. */
function storedEvent(e: Batch["events"][number], deviceId: string, variants: Batch["variants"], platform?: string): EventLike {
  return {
    type: e.type,
    at: e.at,
    deviceId,
    ...(platform ? { platform } : {}),
    ...(e.user ? { userId: e.user } : {}),
    ...(e.acquisition ? { acquisition: e.acquisition } : {}),
    ...(e.props ? { props: e.props } : {}),
    ...(e.value ? { value: e.value } : {}),
    ...(variants ? { variants } : {}),
  };
}

/** The days each identified user was active in a batch. */
function userDays(batch: Batch): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const e of batch.events) {
    // Events the stores sent about a user (Money: renewals, refunds) aren't the user being active.
    if (!e.user || e.props?.by === "store") continue;
    const s = m.get(e.user) ?? new Set();
    s.add(dayOf(e.at));
    m.set(e.user, s);
  }
  return m;
}

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
  failureInfo: Map<string, { devices: number; simulated: number; first: string | null; last: string | null; sample: StoredFailure | null }>,
): ContractHealth[] {
  const by = new Map<string, ContractHealth>();
  const get = (c: string) => {
    let h = by.get(c);
    if (!h) {
      const fi = failureInfo.get(c);
      h = { contract: c, passes: 0, failures: 0, rejected: 0, devices: fi?.devices ?? 0, simulated: fi?.simulated ?? 0, firstFailureAt: fi?.first ?? null, lastFailureAt: fi?.last ?? null, sample: fi?.sample ?? null };
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

type FileUsers = Record<string, { first: string; days: string[] }>;

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
      for (const e of batch.events) appendFileSync(join(d, "events.jsonl"), `${JSON.stringify(storedEvent(e, deviceId, batch.variants, batch.device.platform))}\n`);
      const active = userDays(batch);
      if (active.size) {
        // Visitors' IP and browser (kept only for sending ad conversions) go after 7 days.
        const ipCut = new Date(now.getTime() - 7 * DAY).toISOString();
        const evPath = join(d, "events.jsonl");
        if (existsSync(evPath)) {
          const evs = readLines<EventLike>(evPath);
          if (evs.some((e) => e.at < ipCut && (e.acquisition?.click?.ip || e.acquisition?.click?.ua))) {
            const cleaned = evs.map((e) => (e.at < ipCut && e.acquisition?.click ? { ...e, acquisition: { ...e.acquisition, click: { param: e.acquisition.click.param, value: e.acquisition.click.value } } } : e));
            writeFileSync(evPath, cleaned.map((x) => JSON.stringify(x)).join("\n") + (cleaned.length ? "\n" : ""));
          }
        }
        const users = readJson<FileUsers>(join(d, "users.json"), {});
        for (const [u, days] of active) {
          const cur = (users[u] ??= { first: [...days].sort()[0]!, days: [] });
          cur.days = [...new Set([...cur.days, ...days])].sort();
          if (cur.days[0]! < cur.first) cur.first = cur.days[0]!;
        }
        writeJson(join(d, "users.json"), users);
      }
      if (batch.release) {
        const rels = readJson<Record<string, Record<string, string>>>(join(d, "release-devices.json"), {});
        const r = (rels[batch.release] ??= {});
        if (!r[deviceId]) {
          r[deviceId] = now.toISOString();
          writeJson(join(d, "release-devices.json"), rels);
        }
      }
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
      const info = new Map<string, { devices: number; simulated: number; first: string | null; last: string | null; sample: StoredFailure | null }>();
      const devs = new Map<string, Set<string>>();
      for (const f of readLines<StoredFailure>(join(dir(appId), "failures.jsonl"))) {
        if (f.at < since.toISOString()) continue;
        const cur = info.get(f.contract) ?? { devices: 0, simulated: 0, first: f.at, last: f.at, sample: f };
        if (f.deviceId.startsWith(SIM_DEVICE_PREFIX)) cur.simulated += 1;
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
    async setSimulation(appId, run) {
      writeJson(join(dir(appId), "simulation.json"), run);
    },
    async simulation(appId) {
      return readJson<SimulationRun | null>(join(dir(appId), "simulation.json"), null);
    },
    async activity(appId, sinceDay) {
      const all = readJson<FileUsers>(join(dir(appId), "users.json"), {});
      const users: UserActivity[] = [];
      let older = 0;
      for (const [user, u] of Object.entries(all)) {
        const lastSeen = u.days.at(-1) ?? u.first;
        if (lastSeen < sinceDay) older++;
        else users.push({ user, firstSeen: u.first, lastSeen, days: u.days.filter((x) => x >= sinceDay) });
      }
      return { users, older };
    },
    async setRetention(appId, snapshot) {
      writeJson(join(dir(appId), "retention.json"), snapshot);
    },
    async retention(appId) {
      return readJson<RetentionSnapshot | null>(join(dir(appId), "retention.json"), null);
    },
    async releaseHealth(appId, releases, since) {
      const rels = readJson<Record<string, Record<string, string>>>(join(dir(appId), "release-devices.json"), {});
      const from = since.toISOString();
      const fails = readLines<StoredFailure>(join(dir(appId), "failures.jsonl")).filter((f) => f.at >= from && releases.some((k) => releaseMatches(k, f.release)));
      return releases.map((release) => {
        const devs = new Set(Object.entries(rels).filter(([r]) => releaseMatches(release, r)).flatMap(([, d]) => Object.entries(d).filter(([, at]) => at >= from).map(([id]) => id)));
        const by = new Map<string, Set<string>>();
        for (const f of fails) if (releaseMatches(release, f.release)) (by.get(f.contract) ?? by.set(f.contract, new Set()).get(f.contract)!).add(f.deviceId);
        const crashed = by.get(CRASH_CONTRACT)?.size ?? 0;
        by.delete(CRASH_CONTRACT);
        return { release, devices: Math.max(devs.size, crashed), crashed, failing: Object.fromEntries([...by].map(([c, d]) => [c, d.size])) };
      });
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
        const relPath = join(d, "release-devices.json");
        if (existsSync(relPath)) {
          const rels = readJson<Record<string, Record<string, string>>>(relPath, {});
          const kept = Object.fromEntries(Object.entries(rels).map(([r, devs]) => [r, Object.fromEntries(Object.entries(devs).filter(([, at]) => at >= failCut))] as const).filter(([, devs]) => Object.keys(devs).length));
          writeJson(relPath, kept);
        }
        // Visitors' IP and browser (kept only for sending ad conversions) go after 7 days.
        const ipCut = new Date(now.getTime() - 7 * DAY).toISOString();
        const evPath = join(d, "events.jsonl");
        if (existsSync(evPath)) {
          const evs = readLines<EventLike>(evPath);
          if (evs.some((e) => e.at < ipCut && (e.acquisition?.click?.ip || e.acquisition?.click?.ua))) {
            const cleaned = evs.map((e) => (e.at < ipCut && e.acquisition?.click ? { ...e, acquisition: { ...e.acquisition, click: { param: e.acquisition.click.param, value: e.acquisition.click.value } } } : e));
            writeFileSync(evPath, cleaned.map((x) => JSON.stringify(x)).join("\n") + (cleaned.length ? "\n" : ""));
          }
        }
        const users = readJson<FileUsers>(join(d, "users.json"), {});
        if (Object.keys(users).length) {
          const daysCut = dayOf(new Date(now.getTime() - USER_DAY_DAYS * DAY).toISOString());
          const usersCut = dayOf(new Date(now.getTime() - USER_DAYS * DAY).toISOString());
          for (const [k, u] of Object.entries(users)) {
            const last = u.days.at(-1) ?? u.first;
            // The last day is kept with the user (as last seen) until the user goes.
            if (last < usersCut) delete users[k];
            else u.days = u.days.filter((x, i, a) => x >= daysCut || i === a.length - 1);
          }
          writeJson(join(d, "users.json"), users);
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
          await tx`INSERT INTO field_events (app_id, at, device_id, user_id, type, acquisition, props, value, variants, platform)
                   VALUES (${appId}, ${e.at}, ${batch.device.id}, ${e.user ?? null}, ${e.type}, ${e.acquisition ?? null}::jsonb, ${e.props ?? null}::jsonb, ${e.value ?? null}::jsonb, ${batch.variants ?? null}::jsonb, ${batch.device.platform ?? null})`;
        }
        for (const [user, days] of userDays(batch)) {
          const sorted = [...days].sort();
          await tx`INSERT INTO field_users (app_id, user_id, first_seen, last_seen) VALUES (${appId}, ${user}, ${sorted[0]!}, ${sorted.at(-1)!})
                   ON CONFLICT (app_id, user_id) DO UPDATE SET first_seen = LEAST(field_users.first_seen, EXCLUDED.first_seen), last_seen = GREATEST(field_users.last_seen, EXCLUDED.last_seen)`;
          for (const day of sorted) await tx`INSERT INTO field_user_days (app_id, user_id, day) VALUES (${appId}, ${user}, ${day}) ON CONFLICT DO NOTHING`;
        }
        if (batch.release)
          await tx`INSERT INTO field_release_devices (app_id, release, device_id, platform, first_seen) VALUES (${appId}, ${batch.release.slice(0, 120)}, ${batch.device.id}, ${batch.device.platform}, ${now.toISOString()}) ON CONFLICT DO NOTHING`;
        await tx`INSERT INTO field_meta (app_id, last_seen_at, last_release, platforms) VALUES (${appId}, ${now.toISOString()}, ${batch.release ?? null}, ARRAY[${batch.device.platform}]::text[])
                 ON CONFLICT (app_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at,
                   last_release = COALESCE(EXCLUDED.last_release, field_meta.last_release),
                   platforms = (SELECT array_agg(DISTINCT p) FROM unnest(field_meta.platforms || EXCLUDED.platforms) AS p)`;
      });
    },
    async health(appId, since) {
      const rows = (await sql`SELECT contract, SUM(passes)::int AS passes, SUM(failures)::int AS failures FROM field_counts
                              WHERE app_id = ${appId} AND day >= ${dayOf(since.toISOString())} GROUP BY contract`) as Array<{ contract: string; passes: number; failures: number }>;
      const fails = (await sql`SELECT contract, COUNT(DISTINCT device_id)::int AS devices, (COUNT(*) FILTER (WHERE device_id LIKE ${SIM_DEVICE_PREFIX + "%"}))::int AS simulated, MIN(at) AS first, MAX(at) AS last
                               FROM field_failures WHERE app_id = ${appId} AND at >= ${since.toISOString()} GROUP BY contract`) as Array<{ contract: string; devices: number; simulated: number; first: Date; last: Date }>;
      const latest = (await sql`SELECT DISTINCT ON (contract) contract, at, device_id, release, device, report FROM field_failures
                                WHERE app_id = ${appId} AND at >= ${since.toISOString()} ORDER BY contract, at DESC`) as Array<FailureRow & { contract: string }>;
      const info = new Map<string, { devices: number; simulated: number; first: string | null; last: string | null; sample: StoredFailure | null }>();
      for (const f of fails) info.set(f.contract, { devices: f.devices, simulated: f.simulated, first: new Date(f.first).toISOString(), last: new Date(f.last).toISOString(), sample: null });
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
      const rows = (await sql`SELECT at, device_id, user_id, type, acquisition, props, value, variants, platform FROM field_events WHERE app_id = ${appId} AND at >= ${since.toISOString()} ORDER BY at`) as Array<{
        at: Date;
        platform: string | null;
        device_id: string;
        user_id: string | null;
        type: string;
        acquisition: EventLike["acquisition"] | string | null;
        props: EventLike["props"] | string | null;
        value: EventLike["value"] | string | null;
        variants: EventLike["variants"] | string | null;
      }>;
      return rows.map((r) => ({
        type: r.type,
        at: new Date(r.at).toISOString(),
        deviceId: r.device_id,
        ...(r.platform ? { platform: r.platform } : {}),
        ...(r.user_id ? { userId: r.user_id } : {}),
        ...(r.acquisition ? { acquisition: parse(r.acquisition) } : {}),
        ...(r.props ? { props: parse(r.props) } : {}),
        ...(r.value ? { value: parse(r.value) } : {}),
        ...(r.variants ? { variants: parse(r.variants) } : {}),
      }));
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
    async setSimulation(appId, run) {
      await sql`INSERT INTO field_simulations (app_id, run, at) VALUES (${appId}, ${run}::jsonb, ${run.at})
                ON CONFLICT (app_id) DO UPDATE SET run = EXCLUDED.run, at = EXCLUDED.at`;
    },
    async simulation(appId) {
      const rows = (await sql`SELECT run FROM field_simulations WHERE app_id = ${appId}`) as Array<{ run: SimulationRun | string }>;
      return rows[0] ? parse(rows[0].run) : null;
    },
    async activity(appId, sinceDay) {
      const rows = (await sql`SELECT u.user_id, u.first_seen::text AS first_seen, u.last_seen::text AS last_seen,
                                     COALESCE(array_agg(d.day::text ORDER BY d.day) FILTER (WHERE d.day IS NOT NULL), '{}') AS days
                              FROM field_users u LEFT JOIN field_user_days d ON d.app_id = u.app_id AND d.user_id = u.user_id AND d.day >= ${sinceDay}
                              WHERE u.app_id = ${appId} AND u.last_seen >= ${sinceDay}
                              GROUP BY u.user_id, u.first_seen, u.last_seen`) as Array<{ user_id: string; first_seen: string; last_seen: string; days: string[] }>;
      const older = (await sql`SELECT COUNT(*)::int AS n FROM field_users WHERE app_id = ${appId} AND last_seen < ${sinceDay}`) as Array<{ n: number }>;
      return { users: rows.map((r) => ({ user: r.user_id, firstSeen: r.first_seen, lastSeen: r.last_seen, days: r.days })), older: older[0]?.n ?? 0 };
    },
    async setRetention(appId, snapshot) {
      await sql`INSERT INTO app_retention (app_id, snapshot, at) VALUES (${appId}, ${snapshot}::jsonb, ${snapshot.at})
                ON CONFLICT (app_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, at = EXCLUDED.at`;
    },
    async retention(appId) {
      const rows = (await sql`SELECT snapshot FROM app_retention WHERE app_id = ${appId}`) as Array<{ snapshot: RetentionSnapshot | string }>;
      return rows[0] ? parse(rows[0].snapshot) : null;
    },
    async releaseHealth(appId, releases, since) {
      const out: ReleaseHealth[] = [];
      for (const release of releases) {
        const clean = release.replace(/[%_\\*]/g, "");
        const pattern = release.startsWith("@") ? `%${clean}` : release.endsWith("*") ? `${clean}%` : clean;
        const [d] = (await sql`SELECT COUNT(*)::int AS n FROM field_release_devices WHERE app_id = ${appId} AND release LIKE ${pattern} AND first_seen >= ${since.toISOString()}`) as Array<{ n: number }>;
        const fails = (await sql`SELECT contract, COUNT(DISTINCT device_id)::int AS n FROM field_failures WHERE app_id = ${appId} AND release LIKE ${pattern} AND at >= ${since.toISOString()} GROUP BY contract`) as Array<{ contract: string; n: number }>;
        const crashed = fails.find((f) => f.contract === CRASH_CONTRACT)?.n ?? 0;
        out.push({ release, devices: Math.max(d?.n ?? 0, crashed), crashed, failing: Object.fromEntries(fails.filter((f) => f.contract !== CRASH_CONTRACT).map((f) => [f.contract, f.n])) });
      }
      return out;
    },
    async prune(now) {
      await sql`UPDATE field_events SET acquisition = acquisition #- '{click,ip}' #- '{click,ua}' WHERE at < ${new Date(now.getTime() - 7 * DAY).toISOString()} AND acquisition ? 'click' AND (acquisition->'click' ? 'ip' OR acquisition->'click' ? 'ua')`;
      await sql`DELETE FROM field_user_days WHERE day < ${dayOf(new Date(now.getTime() - USER_DAY_DAYS * DAY).toISOString())}`;
      await sql`DELETE FROM field_users WHERE last_seen < ${dayOf(new Date(now.getTime() - USER_DAYS * DAY).toISOString())}`;
      await sql`DELETE FROM field_failures WHERE at < ${new Date(now.getTime() - FAILURE_DAYS * DAY).toISOString()}`;
      await sql`DELETE FROM field_release_devices WHERE first_seen < ${new Date(now.getTime() - FAILURE_DAYS * DAY).toISOString()}`;
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
