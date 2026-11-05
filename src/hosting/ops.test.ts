import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCredits } from "../credits";
import { closePreviews, previewForPr, releaseMigrations } from "./environments";
import { ensureHosting } from "./index";
import { alertsFrom, billUsage, computePerDay, dailyCost, hostingPass, pauseDecisions } from "./operations";
import { confirmTakeover, previewTakeover } from "./takeover";
import { makeKit, PLAN } from "./test-kit";
import { emptyState, type HealthSnapshot } from "./types";

const prevKey = process.env.DAY2_SECRETS_KEY;
beforeAll(() => {
  process.env.DAY2_SECRETS_KEY = randomBytes(32).toString("base64");
});
afterAll(() => {
  if (prevKey === undefined) delete process.env.DAY2_SECRETS_KEY;
  else process.env.DAY2_SECRETS_KEY = prevKey;
});

const GB = 1024 ** 3;
const health = (o: Partial<HealthSnapshot> = {}): HealthSnapshot => ({ at: "2026-11-03T00:00:00Z", status: "ACTIVE_HEALTHY", services: [], dbBytes: GB, diskBytes: 8 * GB, diskUsedBytes: 2 * GB, connections: 5, maxConnections: 60, requests: null, egressBytes: 0, functionInvocations: 0, functionErrors: 0, storageBytes: 0, authUsers: 10, ...o });

describe("usage → credits (pure)", () => {
  test("compute from the add-on price (hourly or monthly), else Micro; overages at list prices", () => {
    expect(computePerDay([{ type: "compute_instance", variant: { id: "ci_small", name: "Small", price: { description: "", type: "usage", interval: "hourly", amount: 0.0206 } } }])).toBeCloseTo(0.4944, 4);
    expect(computePerDay(null)).toBeCloseTo((10 * 12) / 365, 6);
    const c = dailyCost({ addons: null, health: health({ dbBytes: 10 * GB, egressBytes: 10 * GB, functionInvocations: 2_000_000 }), previews: 1 });
    expect(c.parts.database).toBeCloseTo(2 * (0.125 / 30), 6);
    expect(c.parts.egress).toBeCloseTo(0.9, 6);
    expect(c.parts.functions).toBeCloseTo(4, 6);
    expect(c.parts.previews).toBeCloseTo(24 * 0.01344, 6);
  });

  test("alerts near the limits", () => {
    expect(alertsFrom(health())).toEqual([]);
    expect(alertsFrom(health({ dbBytes: 7 * GB, diskUsedBytes: 7.5 * GB, connections: 55, functionInvocations: 100, functionErrors: 30 })).map((a) => a.kind)).toEqual(["database", "disk", "connections", "functions"]);
  });

  test("pause rules: staging after a week unused; production never by itself", () => {
    const s = emptyState();
    const base = { ref: "r", name: "n", region: "eu-central-1" as const, orgSlug: "o", status: "ACTIVE_HEALTHY" as const, url: "u", publishableKey: "k", instanceSize: "micro" as const, createdAt: "2026-10-01T00:00:00Z", managedBy: "day2" as const };
    s.projects.production = { ...base, env: "production", lastUsedAt: "2026-10-01T00:00:00Z" };
    s.projects.staging = { ...base, env: "staging", lastUsedAt: "2026-10-30T00:00:00Z" };
    expect(pauseDecisions(s, new Date("2026-11-03T00:00:00Z"))).toEqual([]);
    expect(pauseDecisions(s, new Date("2026-11-07T00:00:00Z"))).toEqual([{ env: "staging", why: "unused for a week" }]);
  });
});

describe("the hosting pass", () => {
  test("hourly health with alert tickets, daily usage billed once per day as infra credits, backups", async () => {
    const k = makeKit();
    await ensureHosting(k.app, PLAN, { deps: k.deps });
    k.setNow(new Date("2026-11-05T10:00:00Z"));
    const r = await hostingPass(k.app, k.deps);
    expect(r.did).toEqual(["health", "usage", "backups", "advisors"]);
    const s = await k.deps.store.state(k.app.id);
    expect(s.health).toMatchObject({ dbBytes: 3 * GB, connections: 12, maxConnections: 60, authUsers: 420, functionInvocations: 1000, functionErrors: 3, egressBytes: 2 * GB, requests: { rest: 900, auth: 40, storage: 30, realtime: 0 } });
    expect(s.usage.map((u) => u.date)).toEqual(["2026-11-03", "2026-11-04"]);
    expect(s.backups).toMatchObject({ daily: 1, pitr: false, latest: "2026-11-02T03:00:00Z" });
    const { events } = await readCredits(k.deps.credits!);
    const charges = events.filter((e) => e.kind === "charge");
    expect(charges.map((c) => (c as { id: string }).id)).toEqual(["hosting:app_h:production:2026-11-03", "hosting:app_h:production:2026-11-04"]);
    expect(charges.every((c) => (c as { service: string }).service === "infra" && (c as { credits: number }).credits > 0)).toBe(true);

    // Same hour, same day: nothing again.
    k.setNow(new Date("2026-11-05T10:20:00Z"));
    expect((await hostingPass(k.app, k.deps)).did).toEqual([]);
    expect(await billUsage(k.app, k.deps)).toEqual([]);
    k.setNow(new Date("2026-11-05T11:00:00Z"));
    expect((await hostingPass(k.app, k.deps)).did).toEqual(["health"]);
  });

  test("a staging project unused for a week is paused and woken for the next pull request", async () => {
    const k = makeKit({ fake: { branching: false } });
    await ensureHosting(k.app, PLAN, { deps: k.deps });
    await previewForPr(k.app, 7, k.repo, k.deps);
    k.setNow(new Date("2026-11-12T10:00:00Z"));
    await hostingPass(k.app, k.deps);
    const ref = (await k.deps.store.state(k.app.id)).projects.staging!.ref;
    expect(k.fake.calls.some((c) => c.op === "pause" && c.args[0] === ref)).toBe(true);
    expect(k.fake.calls.some((c) => c.op === "pause" && c.args[0] !== ref)).toBe(false);
    await hostingPass(k.app, { ...k.deps, pullRequests: async () => [{ number: 8, dir: k.repo, touchesBackend: true, done: async () => undefined }] });
    expect(k.fake.calls.some((c) => c.op === "restore" && c.args[0] === ref)).toBe(true);
    const s = await k.deps.store.state(k.app.id);
    expect(s.projects.staging!.pausedAt).toBeNull();
    expect(s.previews.find((p) => p.pr === 8)).toMatchObject({ migrations: "passed", branchId: "staging" });
  });
});

describe("environments", () => {
  test("a preview branch per pull request with its migrations; closed PRs lose theirs", async () => {
    const k = makeKit();
    await ensureHosting(k.app, PLAN, { deps: k.deps });
    writeFileSync(join(k.repo, "supabase/migrations/20261103080000_streaks.sql"), "alter table public.habits add column streak int default 0;\n");
    const p = await previewForPr(k.app, 12, k.repo, k.deps);
    expect(p).toMatchObject({ pr: 12, migrations: "passed" });
    expect(k.fake.calls.find((c) => c.op === "createBranch")!.args).toEqual([(await k.deps.store.state(k.app.id)).projects.production!.ref, "pr-12"]);
    expect([...k.fake.migrations.get(p!.ref)!]).toEqual(["20261101120000", "20261103080000"]);
    expect(await closePreviews(k.app, [12], k.deps)).toEqual([]);
    expect(await closePreviews(k.app, [], k.deps)).toEqual([12]);
    expect((await k.deps.store.state(k.app.id)).previews).toEqual([]);
  });

  test("a release applies production migrations only after they passed elsewhere", async () => {
    const k = makeKit();
    await ensureHosting(k.app, PLAN, { deps: k.deps });
    const prodRef = (await k.deps.store.state(k.app.id)).projects.production!.ref;
    writeFileSync(join(k.repo, "supabase/migrations/20261103080000_streaks.sql"), "alter table public.habits add column streak int default 0;\n");
    const r = await releaseMigrations(k.app, k.repo, k.deps);
    expect(r).toEqual({ ok: true, applied: ["20261103080000"] });
    expect(k.fake.calls.find((c) => c.op === "createBranch")!.args[1]).toBe("day2-release-check");
    expect([...k.fake.migrations.get(prodRef)!]).toContain("20261103080000");

    // A destructive change without the mark holds the release.
    writeFileSync(join(k.repo, "supabase/migrations/20261104080000_drop.sql"), "alter table public.habits drop column streak;\n");
    const held = await releaseMigrations(k.app, k.repo, k.deps);
    expect(held.ok).toBe(false);
    if (!held.ok) expect(held.why).toContain("breaks app versions people still have");
    expect([...k.fake.migrations.get(prodRef)!]).not.toContain("20261104080000");
  });

  test("a failing migration on the check database stops the release before production", async () => {
    const k = makeKit({ fake: { failSql: /boom/ } });
    await ensureHosting(k.app, PLAN, { deps: k.deps });
    writeFileSync(join(k.repo, "supabase/migrations/20261103080000_bad.sql"), "select boom;\n");
    const r = await releaseMigrations(k.app, k.repo, k.deps);
    expect(r).toMatchObject({ ok: false, why: expect.stringContaining("failed on the preview database") });
  });
});

describe("takeover", () => {
  test("claim tokens move the project to the owner's organization; day2 then manages it with their token and stops billing", async () => {
    const k = makeKit();
    await ensureHosting(k.app, PLAN, { deps: k.deps });
    await expect(previewTakeover(k.app, { token: "nope", orgSlug: "acme" }, k.deps)).rejects.toThrow("starts with sbp_");
    const ownerToken = `sbp_${"o".repeat(40)}`;
    const pv = await previewTakeover(k.app, { token: ownerToken, orgSlug: "acme" }, k.deps);
    expect(pv).toMatchObject({ ok: true, projects: [{ env: "production", warnings: [expect.stringContaining("Free plan")], targetPlan: "free" }] });
    expect(k.fake.calls.find((c) => c.op === "createClaimToken")!.token).toBe(k.deps.operator!.token);
    expect(k.fake.calls.find((c) => c.op === "claimPreview")!.token).toBe(ownerToken);
    const { moved } = await confirmTakeover(k.app, "Pablo", k.deps);
    expect(moved).toEqual(["production"]);
    const s = await k.deps.store.state(k.app.id);
    expect(s.projects.production).toMatchObject({ managedBy: "owner", orgSlug: "acme" });
    expect(s.takeover).toMatchObject({ state: "moved", orgSlug: "acme", by: "Pablo" });
    const saved = await k.deps.secrets.get<Record<string, unknown>>(k.app.id, "owner_token");
    expect(saved).toEqual({ token: ownerToken, orgSlug: "acme" });

    k.setNow(new Date("2026-11-05T10:00:00Z"));
    const before = k.fake.calls.length;
    await hostingPass(k.app, k.deps);
    expect(k.fake.calls.slice(before).every((c) => c.token === ownerToken)).toBe(true);
    expect((await k.deps.store.state(k.app.id)).usage).toEqual([]);
  });

  test("when Supabase won't make a claim token, the guided way is offered", async () => {
    const k = makeKit({ fake: { claimFails: true } });
    await ensureHosting(k.app, PLAN, { deps: k.deps });
    const pv = await previewTakeover(k.app, { token: `sbp_${"o".repeat(40)}`, orgSlug: "acme" }, k.deps);
    expect(pv).toMatchObject({ ok: false, guided: true });
  });
});
