import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrations } from "./migrations";
import { ensureSeedPlan, loadSeedPlan, migrationsHash, SeedPlanError, seedPlanState, seedPlanView } from "./seed-plan-cache";

/** The cached seed plan (hosting/seed-plan-cache.ts): keyed by the migrations' hash, re-checked when they change, the model's plan checked, failures naming the table. */

let data: string;
const prev = process.env.DAY2_DATA_DIR;
beforeAll(() => {
  data = mkdtempSync(join(tmpdir(), "day2-spc-"));
  process.env.DAY2_DATA_DIR = data;
});
afterAll(() => {
  rmSync(data, { recursive: true, force: true });
  if (prev === undefined) delete process.env.DAY2_DATA_DIR;
  else process.env.DAY2_DATA_DIR = prev;
});

function repo(): string {
  const r = mkdtempSync(join(tmpdir(), "day2-spc-repo-"));
  mkdirSync(join(r, "supabase"), { recursive: true });
  cpSync(join(import.meta.dir, "fixtures", "dotty-migrations"), join(r, "supabase", "migrations"), { recursive: true });
  return r;
}

describe("the seed plan cache", () => {
  test("made once (built-in planner), then reused; the hash follows names and contents", async () => {
    const r = repo();
    expect(seedPlanState("a1", r).state).toBe("missing");
    const first = await ensureSeedPlan("a1", r, { planner: null });
    expect(first.reused).toBe(false);
    expect(first.plan.steps[0]!.table).toBe("dotty.profiles");
    expect(seedPlanState("a1", r).state).toBe("ready");
    expect((await ensureSeedPlan("a1", r, { planner: async () => ({ steps: [] }) })).reused).toBe(true);
    const h = migrationsHash(readMigrations(r));
    expect(loadSeedPlan("a1")!.migrations).toBe(h);
    expect(seedPlanView("a1", r)).toMatchObject({ state: "ready", source: "heuristic", tables: expect.arrayContaining(["dotty.moments"]), uploads: ["dotty-avatars", "dotty-moments"] });
  });

  test("changed migrations that still fit: checked again and re-stamped; ones that break it: a new plan, else an error naming the table", async () => {
    const r = repo();
    await ensureSeedPlan("a2", r, { planner: null });
    writeFileSync(join(r, "supabase/migrations/29990101000000_badges.sql"), "create table if not exists dotty.badges (id uuid primary key);\n");
    expect(seedPlanState("a2", r).state).toBe("stale");
    const again = await ensureSeedPlan("a2", r, { planner: null });
    expect(again).toMatchObject({ reused: true, note: expect.stringContaining("migrations changed") });
    expect(seedPlanState("a2", r).state).toBe("ready");
    // A required column nobody can fill: the cached plan no longer fits, nothing does.
    writeFileSync(join(r, "supabase/migrations/29990102000000_shoe.sql"), "alter table dotty.profiles add column shoe_size int not null;\n");
    expect(seedPlanState("a2", r)).toMatchObject({ state: "invalid", problems: expect.arrayContaining([expect.stringContaining("dotty.profiles.shoe_size")]) });
    const err = (await ensureSeedPlan("a2", r, { planner: null }).catch((e) => e)) as SeedPlanError;
    expect(err).toBeInstanceOf(SeedPlanError);
    expect(err.message).toContain("dotty.profiles.shoe_size");
    expect(err.message).toContain("29990102000000_shoe.sql");
  });

  test("a model's plan is checked: refused twice → the built-in one; a good one is kept as written by a model", async () => {
    const r = repo();
    const asked: string[][] = [];
    const bad = await ensureSeedPlan("a3", r, { planner: async (_s, problems) => (asked.push(problems), { steps: [{ table: "dotty.nope", for: "people", columns: {} }] }) });
    expect(asked).toHaveLength(2);
    expect(asked[1]!.join()).toContain("no such table");
    expect(bad.plan.source).toBe("heuristic");
    const r2 = repo();
    const good = await ensureSeedPlan("a4", r2, { planner: async () => ({ steps: [{ table: "dotty.profiles", for: "people", columns: { id: { id: true }, username: { field: "username" } } }], uploads: [] }) });
    expect(good.plan.source).toBe("model");
  });
});
