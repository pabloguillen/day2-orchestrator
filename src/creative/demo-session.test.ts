import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DemoClient } from "../hosting/demo";
import type { EphemeralDeps } from "../hosting/ephemeral";
import { ensureSeedPlan } from "../hosting/seed-plan-cache";
import type { TunnelProcess } from "../hosting/tunnel";
import { fakeCastDraft } from "./demo-cast/generate";
import { CAST_VERSION, type DemoCast } from "./demo-cast/schema";
import { openDemoSession } from "./demo-session";

/**
 * One capture's temporary database (demo-session.ts) with a fake docker/CLI,
 * a fake seeding client and a fake cloudflared: the address each device
 * gets, the cast seeded through the cached plan, this run's login, and
 * everything removed on close — or on a failure before the run.
 */

const CLI = "/fake/bin/supabase";
const ANON = ["eyJfake", "anon", "session"].join(".");
const SERVICE = ["eyJfake", "service", "session"].join(".");
let data: string;
let root: string;
const prev = process.env.DAY2_DATA_DIR;
beforeAll(() => {
  data = mkdtempSync(join(tmpdir(), "day2-ds-"));
  root = mkdtempSync(join(tmpdir(), "day2-ds-root-"));
  process.env.DAY2_DATA_DIR = data;
});
afterAll(() => {
  rmSync(data, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  if (prev === undefined) delete process.env.DAY2_DATA_DIR;
  else process.env.DAY2_DATA_DIR = prev;
});

function checkout(): string {
  const r = mkdtempSync(join(tmpdir(), "day2-ds-co-"));
  mkdirSync(join(r, "supabase"), { recursive: true });
  cpSync(join(import.meta.dir, "..", "hosting", "fixtures", "dotty-migrations"), join(r, "supabase", "migrations"), { recursive: true });
  return r;
}

function cast(): DemoCast {
  const d = fakeCastDraft({ language: "de", seed: 5 });
  const pic = join(mkdtempSync(join(tmpdir(), "day2-ds-pic-")), "p.jpg");
  writeFileSync(pic, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]));
  const img = { assetId: "as_p", file: pic, source: "bundled" as const, aiGenerated: false, aiPerson: false, tool: null };
  return { version: CAST_VERSION, appId: "app_ds", language: "de", locale: "de-DE", createdAt: "2026-11-08T10:00:00Z", generator: "fake", seed: 5, status: "approved", approvedAt: "2026-11-08T10:01:00Z", approvedBy: "x", images: { source: "bundled", note: "" }, ...d, people: d.people.map((p) => ({ ...p, avatar: img })), moments: d.moments.map((m) => ({ ...m, photo: img })) } as DemoCast;
}

function world(o: { cloudflared?: boolean; failInsert?: boolean } = {}) {
  const cmds: string[][] = [];
  const keys: string[] = [];
  const calls: string[] = [];
  const ephemeral: EphemeralDeps = {
    env: { DAY2_SUPABASE_CLI: CLI, DAY2_EPHEMERAL_PORT_BASE: "57000" },
    root,
    has: (b) => b === "docker" || (b === "cloudflared" && o.cloudflared !== false),
    portFree: async () => true,
    sleep: async () => undefined,
    fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    run: async (cmd) => {
      cmds.push(cmd);
      if (cmd[1] === "status") return { code: 0, stdout: JSON.stringify({ ANON_KEY: ANON, SERVICE_ROLE_KEY: SERVICE }), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  let n = 0;
  const client: DemoClient = {
    createUser: async (u) => (calls.push(`user ${u.email}`), { id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` }),
    findUser: async () => null,
    deleteUser: async () => undefined,
    insert: async (table, rows) => {
      if (o.failInsert) throw new Error(`insert refused (key ${SERVICE})`);
      calls.push(`insert ${table} ${rows.length}`);
    },
    remove: async () => undefined,
    upload: async (bucket) => void calls.push(`upload ${bucket}`),
  };
  let killed = 0;
  const tunnelProc = (): TunnelProcess => ({
    lines: (async function* () {
      yield "INF https://calm-fox-1.trycloudflare.com";
      await new Promise(() => undefined);
    })(),
    kill: () => void killed++,
    exited: Promise.resolve(0),
  });
  const deps = { ephemeral, tunnel: { has: ephemeral.has, spawn: tunnelProc, fetch: ephemeral.fetch, sleep: ephemeral.sleep }, client: (_u: string, k: string) => (keys.push(k), client) };
  return { deps, cmds, keys, calls, killed: () => killed };
}

describe("a capture's temporary database", () => {
  test("iPhone Simulator: 127.0.0.1; seeded with the service key through the cached plan; a fresh login; removed on close", async () => {
    const dir = checkout();
    await ensureSeedPlan("app_ds", dir, { planner: null });
    const w = world();
    const logs: string[] = [];
    const c = cast();
    const s = await openDemoSession({ appId: "app_ds", dir, cast: c, where: "ios", log: (x) => logs.push(x) }, w.deps);
    expect(s.url).toBe("http://127.0.0.1:57000");
    expect(s.key).toBe(ANON);
    expect(w.keys).toEqual([SERVICE]);
    expect(w.calls.filter((x) => x.startsWith("user"))).toHaveLength(c.people.length);
    expect(w.calls.filter((x) => x.startsWith("insert")).map((x) => x.split(" ")[1])).toEqual(["dotty.profiles", "dotty.friendships", "dotty.places", "dotty.moments", "dotty.reactions", "dotty.comments"]);
    expect(s.uploads).toBe(c.people.length + c.moments.length);
    expect(s.login.email).toBe(`demo-${(5).toString(36)}-${c.self}@example.com`);
    expect(s.login.password.length).toBeGreaterThan(20);
    expect(logs.join("\n")).not.toContain(s.login.password);
    expect(logs.join("\n")).not.toContain(SERVICE);
    expect(w.cmds.some((x) => x[1] === "stop")).toBe(false);
    await s.close();
    expect(w.cmds.filter((x) => x[1] === "stop")).toHaveLength(1);
    expect(logs.at(-1)).toContain("stopped and deleted");
  });

  test("Android emulator: 10.0.2.2; EAS: an https tunnel to the API port, closed with the database", async () => {
    const dir = checkout();
    await ensureSeedPlan("app_ds", dir, { planner: null });
    const a = world();
    const sa = await openDemoSession({ appId: "app_ds", dir, cast: cast(), where: "android", log: () => undefined }, a.deps);
    expect(sa.url).toBe("http://10.0.2.2:57000");
    await sa.close();
    const e = world();
    const se = await openDemoSession({ appId: "app_ds", dir, cast: cast(), where: "eas", log: () => undefined }, e.deps);
    expect(se.url).toBe("https://calm-fox-1.trycloudflare.com");
    await se.close();
    expect(e.killed()).toBe(1);
    expect(e.cmds.filter((x) => x[1] === "stop")).toHaveLength(1);
  });

  test("EAS without cloudflared: the hint before anything starts; seeding fails: the database is removed, the key cut out", async () => {
    const dir = checkout();
    await ensureSeedPlan("app_ds", dir, { planner: null });
    const n = world({ cloudflared: false });
    await expect(openDemoSession({ appId: "app_ds", dir, cast: cast(), where: "eas", log: () => undefined }, n.deps)).rejects.toMatchObject({ code: "no_tunnel" });
    expect(n.cmds).toEqual([]);
    const f = world({ failInsert: true });
    const err = (await openDemoSession({ appId: "app_ds", dir, cast: cast(), where: "ios", log: () => undefined }, f.deps).catch((x) => x)) as Error;
    expect(err.message).toContain("insert refused");
    expect(err.message).not.toContain(SERVICE);
    expect(f.cmds.filter((x) => x[1] === "stop")).toHaveLength(1);
  });

  test("no seed plan, or one that doesn't fit the checkout: refused before Docker is touched", async () => {
    const w = world();
    await expect(openDemoSession({ appId: "app_none", dir: checkout(), cast: cast(), where: "ios", log: () => undefined }, w.deps)).rejects.toThrow(/no seed plan/);
    const dir = checkout();
    await ensureSeedPlan("app_drift", dir, { planner: null });
    writeFileSync(join(dir, "supabase/migrations/29990102000000_shoe.sql"), "alter table dotty.profiles add column shoe_size int not null;\n");
    await expect(openDemoSession({ appId: "app_drift", dir, cast: cast(), where: "ios", log: () => undefined }, w.deps)).rejects.toThrow(/shoe_size/);
    expect(w.cmds).toEqual([]);
  });
});
