import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "../db/test-db";
import { makeOutcome, type Outcome } from "./library";
import { noteFailure, noteFix } from "./playbook";
import { dbLearningStore, fileLearningStore, type LearningStore } from "./store";

/** The learning store in both forms: one file for the platform (local) and Postgres (migration 023). */

let t: Awaited<ReturnType<typeof createTestDatabase>>;
let accountId = "";

beforeAll(async () => {
  t = await createTestDatabase();
  const [acc] = (await t.sql`INSERT INTO accounts (name) VALUES ('A') RETURNING id`) as Array<{ id: string }>;
  accountId = acc!.id;
});
afterAll(async () => t.drop());

const outcome = (sourceId: string): Outcome =>
  (makeOutcome({ appId: "app1", accountId: "acc1", appName: "Dotty", context: { category: "games", productType: "habit", platform: "ios" }, kind: "paywall.layout", metric: "conversion", control: { n: 500, value: 0.1 }, treatment: { n: 500, value: 0.12 }, n: 1000, verdict: "better", source: "live", sourceId, at: new Date("2026-10-01T00:00:00Z") }, "salt") as { outcome: Outcome }).outcome;

function contract(name: string, make: () => LearningStore, account: () => string) {
  describe(name, () => {
    test("outcomes: recorded once per result, read back without loss", async () => {
      const s = make();
      expect(await s.record(outcome("X-1"))).toBe(true);
      expect(await s.record(outcome("X-1"))).toBe(false);
      expect(await s.record(outcome("X-2"))).toBe(true);
      const all = await s.outcomes({ kind: "paywall.layout" });
      expect(all).toHaveLength(2);
      expect(all[0]).toEqual(expect.objectContaining({ category: "games", kind: "paywall.layout", n: "1k-10k", verdict: "better", at: "2026-10-01" }));
      expect(all[0]!.effect).toBeCloseTo(0.2, 3);
      expect(await s.outcomes({ kind: "price.level" })).toEqual([]);
    });
    test("playbook: failure, fix, status", async () => {
      const s = make();
      await s.updatePlaybook((st) => ({ state: { ...st, open: noteFailure(st.open, { ref: "r1", app: "h1", account: "c1", key: "expo54|-|lint", framework: "expo54", pkg: null, errorType: "lint", at: "2026-10-01T00:00:00.000Z" }) }, result: null }));
      expect((await s.playbook()).open).toHaveLength(1);
      await s.updatePlaybook((st) => {
        const r = noteFix(st.entries, st.open, "r1", "Run the linter's autofix before committing.", new Date("2026-10-02T00:00:00Z"));
        return { state: { entries: r.entries, open: r.open }, result: null };
      });
      const p = await s.playbook();
      expect(p.open).toEqual([]);
      expect(p.entries[0]).toMatchObject({ status: "candidate", fix: "Run the linter's autofix before committing.", apps: ["c1.h1"] });
      await s.updatePlaybook((st) => ({ state: { ...st, entries: st.entries.map((e) => ({ ...e, status: "approved" as const })) }, result: null }));
      expect((await s.playbook()).entries[0]!.status).toBe("approved");
    });
    test("false-positive candidates and the account's opt-out", async () => {
      const s = make();
      await s.addCandidate("visual-tester", "Lazy images look missing in the first screenshot.", new Date());
      await s.addCandidate("visual-tester", "lazy images look missing in the first screenshot", new Date());
      const c = await s.candidates();
      expect(c).toHaveLength(1);
      expect(c[0]!.seen).toBe(2);
      expect((await s.setCandidate(c[0]!.id, "approved", new Date()))!.status).toBe("approved");
      expect(await s.sharing(account())).toBe(true);
      await s.setSharing(account(), false);
      expect(await s.sharing(account())).toBe(false);
      await s.setSharing(account(), true);
      expect(await s.sharing(account())).toBe(true);
      await s.record(outcome("X-9"));
      const before = (await s.outcomes()).length;
      expect(await s.forget({ accounts: [(await s.outcomes())[0]!.accountHash] })).toBe(before);
      expect(await s.outcomes()).toEqual([]);
    });
  });
}

const dir = mkdtempSync(join(tmpdir(), "day2-learn-"));
contract("file store", () => fileLearningStore(join(dir, "day2-learning.json")), () => "local");
contract("Postgres store", () => dbLearningStore(t.sql), () => accountId);
