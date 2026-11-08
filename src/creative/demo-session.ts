import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { demoClient, type DemoClient } from "../hosting/demo";
import { appMajorVersion, openStack, TIMEOUTS, type EphemeralDeps, type Stack } from "../hosting/ephemeral";
import { readMigrations } from "../hosting/migrations";
import { introspectMigrations, type AppSchema } from "../hosting/schema-introspect";
import { expandSeedPlan, validateSeedPlan, type SeedPlan } from "../hosting/seed-plan";
import { appSchemas, loadSeedPlan, SeedPlanError } from "../hosting/seed-plan-cache";
import { cloudflaredMissing, openTunnel, type Tunnel, type TunnelDeps } from "../hosting/tunnel";
import type { CaptureSet } from "./capture";
import type { DemoCast } from "./demo-cast/schema";
import { castAiFlags } from "./demo-cast/store";

/**
 * One capture run's demo backend (docs/creative-quality.md §2b): a
 * temporary database (hosting/ephemeral.ts) with the app's migrations from
 * the clean checkout, filled with the approved cast through the cached seed
 * plan, reachable by the device that runs the flow —
 *
 *   ios      the iPhone Simulator shares this Mac's network: http://127.0.0.1:<api>
 *   android  the Android emulator reaches the host as 10.0.2.2: http://10.0.2.2:<api>
 *   eas      EAS's cloud simulator: a short-lived quick tunnel (hosting/tunnel.ts), https
 *
 * The demo login is made for this run only (a fresh password, never
 * stored). `close()` closes the tunnel and removes the database.
 */

export type DemoWhere = "ios" | "android" | "eas";
export type DemoSession = { url: string; key: string; login: { email: string; password: string }; ai: CaptureSet["aiContent"]; users: number; rows: number; uploads: number; skipped: string[]; close: () => Promise<void> };
export type DemoSessionDeps = { ephemeral: EphemeralDeps; tunnel: TunnelDeps; client?: (url: string, key: string) => DemoClient; now?: () => Date };

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 60_000)} minutes`)), ms)))]).finally(() => clearTimeout(timer));
};

/** Fills a fresh stack with the cast: one auth user per person (Auth admin API), rows through PostgREST, pictures into the buckets — all with the stack's local service key. */
export async function seedStack(client: DemoClient, o: { cast: DemoCast; plan: SeedPlan; schema: AppSchema; now: Date }): Promise<{ login: { email: string; password: string }; users: number; rows: number; uploads: number; skipped: string[] }> {
  const ids: Record<string, string> = {};
  let login: { email: string; password: string } | null = null;
  for (const p of o.cast.people) {
    const email = `demo-${o.cast.seed.toString(36)}-${p.key}@example.com`;
    const password = randomBytes(18).toString("base64url");
    ids[p.key] = (await client.createUser({ email, password, metadata: { display_name: p.displayName, day2_demo: "1" } })).id;
    if (p.key === o.cast.self) login = { email, password };
  }
  if (!login) throw new Error("The cast has no demo account (self).");
  const rows = expandSeedPlan(o.plan, o.cast, ids, o.schema, o.now);
  let n = 0;
  for (const ins of rows.inserts) {
    await client.insert(ins.table, ins.rows);
    n += ins.rows.length;
  }
  let up = 0;
  for (const u of rows.uploads) {
    if (!u.file || !existsSync(u.file)) continue;
    await client.upload(u.bucket, u.path, new Uint8Array(readFileSync(u.file)), /\.png$/i.test(u.file) ? "image/png" : "image/jpeg");
    up++;
  }
  return { login, users: Object.keys(ids).length, rows: n, uploads: up, skipped: rows.skipped };
}

/** Starts, seeds and exposes the temporary database for one capture. Throws (after removing everything) when any of it fails. */
export async function openDemoSession(o: { appId: string; dir: string; cast: DemoCast; where: DemoWhere; log: (text: string) => void }, d: DemoSessionDeps): Promise<DemoSession> {
  const files = readMigrations(o.dir);
  const schema = introspectMigrations(files);
  const cached = loadSeedPlan(o.appId);
  if (!cached) throw new SeedPlanError("There's no seed plan yet — the Seed plan step makes one.", []);
  const v = validateSeedPlan(cached.plan, schema);
  if (!v.plan) throw new SeedPlanError(`The seed plan doesn't fit the checkout's migrations any more: ${v.problems.slice(0, 3).join("; ")}`, v.problems);
  const plan = v.plan;
  // The install hint before anything starts.
  const noTunnel = o.where === "eas" ? cloudflaredMissing(d.tunnel.has) : null;
  if (noTunnel) throw noTunnel;
  const stack: Stack = await openStack({ files, schemas: appSchemas(schema), majorVersion: appMajorVersion(o.dir) }, { ...d.ephemeral, log: o.log });
  let tunnel: Tunnel | null = null;
  try {
    const client = (d.client ?? ((u, k) => demoClient(u, k, d.ephemeral.fetch)))(stack.apiUrl, stack.serviceKey);
    const seeded = await within(seedStack(client, { cast: o.cast, plan, schema, now: d.now ? d.now() : new Date() }), TIMEOUTS.seed, "Seeding the temporary database");
    o.log(`Seeded the temporary database: ${seeded.users} demo users, ${seeded.rows} rows, ${seeded.uploads} pictures${seeded.skipped.length ? ` (${seeded.skipped.length} rows skipped)` : ""}.`);
    if (o.where === "eas") {
      tunnel = await openTunnel(stack.ports.api, d.tunnel);
      o.log("Opened a short-lived tunnel to the temporary database for EAS (closed after the run).");
    }
    const url = tunnel?.url ?? `http://${o.where === "android" ? "10.0.2.2" : "127.0.0.1"}:${stack.ports.api}`;
    const t = tunnel;
    let closed: Promise<void> | null = null;
    return {
      url,
      key: stack.anonKey,
      login: seeded.login,
      ai: castAiFlags(o.cast),
      users: seeded.users,
      rows: seeded.rows,
      uploads: seeded.uploads,
      skipped: seeded.skipped,
      close: () =>
        (closed ??= (async () => {
          await t?.close().catch(() => undefined);
          await stack.close();
        })()),
    };
  } catch (err) {
    await tunnel?.close().catch(() => undefined);
    await stack.close().catch(() => undefined);
    const e = err as Error;
    e.message = stack.redact(e.message);
    throw e;
  }
}
