import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashWith, makeOutcome, type Outcome } from "./library";
import { forgetInPlaybook, memberOf, noteFailure, noteFix, type PlaybookEntry } from "./playbook";
import { describePrior, priorFor } from "./priors";
import { accountHashOf, appHashOf, forgetAccount, forgetApp, learningSalt, noteBuildFixed, priorForApp, recordOutcome, resetLearningSalt, whatWorked } from "./runtime";
import { fileLearningStore } from "./store";

/** Nobody can read one app's result back out of the library: not with verdict-only apps, not with an account of several apps, not after opting out. */

const Z = 1.6449;
let n = 0;
function o(app: string, account: string, y: number | null, se = 0.02, verdict: Outcome["verdict"] = "better"): Outcome {
  n++;
  const eff = y === null ? null : Math.exp(y) - 1;
  return { id: `o${n}`, at: "2026-10-01", appHash: app, accountHash: account, refHash: `r${n}`, category: "health_fitness", productType: "habit", platform: "both", kind: "paywall.trial_length", pattern: "x", metric: "conversion", effect: eff, low: y === null ? null : Math.exp(y - Z * se) - 1, high: y === null ? null : Math.exp(y + Z * se) - 1, n: "1k-10k", verdict, source: "live" };
}
const q = { category: "health_fitness" as const, kind: "paywall.trial_length" as const };

describe("#1 effect numbers need 3 apps with a measured effect", () => {
  test("one effect app plus two verdict-only apps: no prior (it would be that one app's exact effect)", () => {
    const victim = Math.log(1.137);
    expect(priorFor([o("v", "A", victim), o("b", "B", null), o("c", "C", null)], q)).toBeNull();
    expect(priorFor([o("v", "A", victim), o("b", "B", 0.05), o("c", "C", null)], q)).toBeNull();
    const p = priorFor([o("v", "A", victim), o("b", "B", 0.05), o("c", "C", 0.02), o("d", "D", null)], q)!;
    expect(p).not.toBeNull();
    expect(p.overall.of).toBe(4);
  });
});

describe("#2 three accounts, and the asking account is left out entirely", () => {
  test("3 apps in one or two accounts don't make a prior", () => {
    expect(priorFor([o("a1", "A", 0.1), o("a2", "A", 0.1), o("a3", "A", 0.1)], q)).toBeNull();
    expect(priorFor([o("a1", "A", 0.1), o("a2", "A", 0.1), o("b1", "B", 0.1)], q)).toBeNull();
  });
  test("an attacker with 3 apps can't subtract its own results to see a victim's", () => {
    const victim = o("v", "V", Math.log(1.211));
    const mine = [o("m1", "M", 0), o("m2", "M", 0), o("m3", "M", 0)];
    // Excluding only the asking app would leave 2 attacker apps + the victim: 3 apps, 2 accounts → nothing.
    expect(priorFor([victim, ...mine], { ...q, excludeApp: "m1" })).toBeNull();
    // Excluding the whole asking account leaves only the victim → nothing.
    expect(priorFor([victim, ...mine], { ...q, excludeApp: "m1", excludeAccount: "M" })).toBeNull();
    // With two more real accounts it shows, and the attacker's own apps aren't in it.
    const p = priorFor([victim, o("x", "X", 0.05), o("y", "Y", 0.04), ...mine], { ...q, excludeApp: "m1", excludeAccount: "M" })!;
    expect(p.apps).toBe(3);
  });
  test("verdict counts for 'similar apps' only from 3 accounts", () => {
    const p = priorFor([o("a", "A", 0.1), o("b", "B", 0.1), o("c", "C", 0.1)], q)!;
    expect(p.similar).toEqual({ better: 3, of: 3 });
    expect(describePrior(p)).toContain("3 of 3 similar apps");
  });
});

describe("#2/#4 through the runtime and the file store", () => {
  const ROOT = mkdtempSync(join(tmpdir(), "day2-leaks-"));
  const saved = { salt: process.env.DAY2_LEARNING_SALT, dir: process.env.DAY2_DATA_DIR };
  const store = fileLearningStore(join(ROOT, "day2-learning.json"));
  const app = (id: string) => ({ id, name: `App ${id}`, repoPath: join(ROOT, id) });
  const result = (i: number, lift = 0.1) => ({ kind: "paywall.trial_length" as const, metric: "conversion" as const, control: { n: 1000, value: 0.2 }, treatment: { n: 1000, value: 0.2 * (1 + lift) }, n: 2000, verdict: "better" as const, source: "live" as const, sourceId: `X-${i}` });
  beforeAll(() => {
    process.env.DAY2_LEARNING_SALT = "leak-salt";
    process.env.DAY2_DATA_DIR = ROOT;
    resetLearningSalt();
  });
  afterAll(() => {
    if (saved.salt === undefined) delete process.env.DAY2_LEARNING_SALT;
    else process.env.DAY2_LEARNING_SALT = saved.salt;
    if (saved.dir === undefined) delete process.env.DAY2_DATA_DIR;
    else process.env.DAY2_DATA_DIR = saved.dir;
    resetLearningSalt();
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("outcomes carry an account hash that is never returned", async () => {
    await recordOutcome(app("v1"), result(1, 0.3), { accountId: "victim", store });
    const all = await store.outcomes();
    expect(all[0]!.accountHash).toBe(accountHashOf("victim"));
    const lines = await whatWorked(app("m1"), "money", { store, accountId: "attacker" });
    expect(JSON.stringify(lines)).not.toContain(accountHashOf("victim"));
  });

  test("an account with 3 apps sees nothing from the victim alone, and never its own results", async () => {
    for (const id of ["m1", "m2", "m3"]) await recordOutcome(app(id), result(Number(id.slice(1)) + 10, 0), { accountId: "attacker", store });
    expect(await priorForApp(app("m1"), "paywall.trial_length", "conversion", store, "attacker")).toBeNull();
    await recordOutcome(app("x1"), result(20, 0.05), { accountId: "x", store });
    await recordOutcome(app("y1"), result(21, 0.04), { accountId: "y", store });
    const p = (await priorForApp(app("m1"), "paywall.trial_length", "conversion", store, "attacker"))!;
    expect(p.apps).toBe(3); // victim, x, y — none of the attacker's
  });

  test("opting out removes the account's outcomes, open failures and playbook hashes; deleting an app removes its outcomes", async () => {
    // A playbook entry the victim helped make, one an operator approved, and an open failure.
    await store.updatePlaybook((s) => {
      let open = noteFailure(s.open, { ref: "f1", app: appHashOf("v1"), account: accountHashOf("victim"), key: "expo54|-|lint", framework: "expo54", pkg: null, errorType: "lint", at: "2026-10-01T00:00:00Z" });
      const r = noteFix(s.entries, open, "f1", "Run the lint autofix.", new Date());
      open = noteFailure(r.open, { ref: "f2", app: appHashOf("v1"), account: accountHashOf("victim"), key: "expo54|-|tsc", framework: "expo54", pkg: null, errorType: "type_error_ts", at: "2026-10-01T00:00:00Z" });
      const approved: PlaybookEntry = { ...r.entry!, id: "pb-approved", key: "k2", status: "approved", apps: [memberOf({ account: accountHashOf("victim"), app: appHashOf("v1") })], fixedIn: [] };
      return { state: { entries: [...r.entries, approved], open }, result: null };
    });
    const removed = await forgetAccount("victim", [], store);
    expect(removed).toBe(1);
    expect((await store.outcomes()).some((x) => x.accountHash === accountHashOf("victim"))).toBe(false);
    const pb = await store.playbook();
    expect(pb.open).toEqual([]);
    expect(pb.entries.map((e) => e.id)).toEqual(["pb-approved"]);
    expect(pb.entries[0]!.apps).toEqual([]);
    await forgetApp("x1", store);
    expect((await store.outcomes()).some((x) => x.appHash === appHashOf("x1"))).toBe(false);
  });

  test("a fix is not learned when the account doesn't share", async () => {
    await store.setSharing("local", false);
    await store.updatePlaybook((s) => ({ state: { ...s, open: noteFailure(s.open, { ref: hashWith(learningSalt(), "ticket:z1:D2-1"), app: "a", account: "c", key: "k", framework: "expo54", pkg: null, errorType: "lint", at: "2026-10-01T00:00:00Z" }) }, result: null }));
    await noteBuildFixed(app("z1"), "D2-1", "## What changed\nRan the linter's autofix before committing.", store);
    expect((await store.playbook()).entries.some((e) => e.fix.includes("autofix before"))).toBe(false);
    await store.setSharing("local", true);
    await noteBuildFixed(app("z1"), "D2-1", "## What changed\nRan the linter's autofix before committing.", store);
    expect((await store.playbook()).entries.some((e) => e.fix.includes("autofix before"))).toBe(true);
  });

  test("forgetInPlaybook strips by app too", () => {
    const e: PlaybookEntry = { id: "p", key: "k", framework: "f", pkg: null, errorType: "lint", fix: "x", status: "candidate", apps: ["c1.a1", "c2.a2"], fixedIn: ["c1.a1"], seen: 2, createdAt: "", updatedAt: "" };
    const r = forgetInPlaybook({ entries: [e], open: [] }, { apps: ["a1"] });
    expect(r.entries[0]!.apps).toEqual(["c2.a2"]);
    expect(r.entries[0]!.fixedIn).toEqual([]);
  });
});

void makeOutcome;
