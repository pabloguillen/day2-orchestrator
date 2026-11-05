import { describe, expect, test } from "bun:test";
import { evaluateProportionExperiment } from "../experiments";
import { seeded } from "../growth-bets";
import { probBetterWithPrior } from "./bayes";
import { makeOutcome, normCdf, normInv, publicOutcome, relativeEffect, safePattern, type Outcome } from "./library";
import { errorSignature, generalizeFix, noteFailure, noteFix, playbookNotes, type PlaybookEntry } from "./playbook";
import { describePrior, experimentPrior, MIN_APPS, priorFor, tauSquared } from "./priors";
import { categorize, kindForKeys, nBucket, similarity, type Category } from "./taxonomy";

const Z = 1.6449;
let n = 0;
/** An outcome with a log effect y and standard error se. */
function o(app: string, y: number, se: number, category: Category = "health_fitness", verdict: Outcome["verdict"] = "better", account = `acct-${app}`): Outcome {
  n++;
  return { id: `o${n}`, at: "2026-10-01", appHash: app, accountHash: account, refHash: `r${n}`, category, productType: "habit", platform: "both", kind: "paywall.trial_length", pattern: "x", metric: "conversion", effect: Math.exp(y) - 1, low: Math.exp(y - Z * se) - 1, high: Math.exp(y + Z * se) - 1, n: "1k-10k", verdict, source: "live" };
}

describe("priors maths (small known examples)", () => {
  test("three identical apps: no spread, mean is their effect, variance se²/3", () => {
    const y = Math.log(1.05);
    const p = priorFor([o("a", y, 0.02), o("b", y, 0.02), o("c", y, 0.02)], { category: "health_fitness", kind: "paywall.trial_length" })!;
    expect(p.tau2).toBeCloseTo(0, 6);
    expect(p.mean).toBeCloseTo(y, 4);
    expect(p.variance).toBeCloseTo(0.0004 / 3, 6);
    expect(p.pHelps).toBeGreaterThan(0.999);
    expect(p.similar).toEqual({ better: 3, of: 3 });
    expect(describePrior(p)).toBe("Free trial length: worked in 3 of 3 similar apps, typical +4% to +6% conversion");
  });

  test("apps that differ: DerSimonian–Laird τ² and the predictive chance it helps", () => {
    const list = [o("a", 0, 0.01), o("b", 0.1, 0.01), o("c", 0.2, 0.01)];
    expect(tauSquared([{ y: 0, v: 1e-4, s: 1 }, { y: 0.1, v: 1e-4, s: 1 }, { y: 0.2, v: 1e-4, s: 1 }])).toBeCloseTo(0.0099, 6);
    const p = priorFor(list, { category: "health_fitness", kind: "paywall.trial_length" })!;
    expect(p.mean).toBeCloseTo(0.1, 6);
    expect(p.variance).toBeCloseTo(0.01 / 3, 6);
    expect(p.pHelps).toBeCloseTo(normCdf(0.1 / Math.sqrt(0.01 / 3 + 0.0099)), 6);
    expect(p.pHelps).toBeCloseTo(0.808, 2);
  });

  test("needs at least 3 distinct apps (several results of one app count once)", () => {
    expect(MIN_APPS).toBe(3);
    expect(priorFor([o("a", 0.1, 0.02), o("a", 0.1, 0.02), o("b", 0.1, 0.02)], { category: "health_fitness", kind: "paywall.trial_length" })).toBeNull();
    expect(priorFor([o("a", 0.1, 0.02), o("b", 0.1, 0.02), o("c", 0.1, 0.02)], { category: "health_fitness", kind: "paywall.trial_length", excludeApp: "c" })).toBeNull();
  });

  test("its own category weighs more than distant ones", () => {
    const list = [o("a", 0.2, 0.02, "games"), o("b", 0.0, 0.02, "finance"), o("c", 0.0, 0.02, "finance"), o("d", 0.0, 0.02, "finance")];
    const games = priorFor(list, { category: "games", kind: "paywall.trial_length" })!;
    const finance = priorFor(list, { category: "finance", kind: "paywall.trial_length" })!;
    expect(games.mean).toBeGreaterThan(finance.mean);
    expect(similarity("games", "games", "paywall.trial_length")).toBe(1);
    expect(similarity("games", "finance", "paywall.trial_length")).toBeLessThan(similarity("productivity", "finance", "paywall.trial_length"));
  });

  test("as a prior for one app's test it's capped below the experiment's own weight", () => {
    const p = priorFor([o("a", 0.1, 0.001), o("b", 0.1, 0.001), o("c", 0.1, 0.001)], { category: "health_fitness", kind: "paywall.trial_length" })!;
    const e = experimentPrior(p, { minPerArm: 200, baseRate: 0.2 });
    // data variance at 200 per arm and a 20% base: 2·0.8/(200·0.2) = 0.04 → sd ≥ √0.08
    expect(e.sd).toBeCloseTo(Math.sqrt(0.08), 6);
    expect(e.mean).toBeCloseTo(0.1, 4);
  });

  test("the informative prior moves the test, but clear data still wins", () => {
    const rng = () => seeded("t")();
    const control = Array.from({ length: 300 }, (_, i) => i < 60);
    const same = Array.from({ length: 300 }, (_, i) => i < 63);
    const flat = probBetterWithPrior(control, same, null, seeded("a"));
    const base = evaluateProportionExperiment(control, same, seeded("a"), { minNPerArm: 1, monteCarloDraws: 4000 }).posteriorProbabilityTreatmentBetter;
    expect(Math.abs(flat - base)).toBeLessThan(0.05);
    const helped = probBetterWithPrior(control, same, { mean: 0.15, sd: 0.2 }, seeded("a"));
    expect(helped).toBeGreaterThan(flat);
    const worse = Array.from({ length: 2000 }, (_, i) => i < 300);
    const big = Array.from({ length: 2000 }, (_, i) => i < 400);
    expect(probBetterWithPrior(big, worse, { mean: 0.15, sd: 0.28 }, seeded("b"))).toBeLessThan(0.05);
    void rng;
  });

  test("normal helpers", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.6449)).toBeCloseTo(0.95, 3);
    expect(normInv(0.95)).toBeCloseTo(1.6449, 3);
    expect(normInv(0.025)).toBeCloseTo(-1.96, 2);
  });
});

describe("outcomes: the privacy filter", () => {
  const input = {
    appId: "dotty-habits-7f3a",
    accountId: "acc-9c1e",
    appName: "Dotty Habits",
    context: { category: "health_fitness" as const, productType: "habit" as const, platform: "both" as const },
    kind: "paywall.trial_length" as const,
    metric: "conversion" as const,
    control: { n: 1234, value: 0.2 },
    treatment: { n: 1301, value: 0.23 },
    n: 2535,
    verdict: "better" as const,
    source: "live" as const,
    sourceId: "X-7",
    at: new Date("2026-10-03T14:22:00Z"),
  };

  test("stores no app name, id, text, user numbers or amounts — only relative effects and buckets", () => {
    for (const pattern of ["Dotty's 7-day trial", "Habits trial at 4.99 €", "“Start your free week”", "email me at a@b.co", undefined]) {
      const r = makeOutcome({ ...input, pattern }, "salt");
      expect(r.ok).toBe(true);
      const out = (r as { outcome: Outcome }).outcome;
      // Random ids and hex hashes are left out of the text check (they can contain any 4 hex digits by chance).
      const { id: _id, appHash: _a, accountHash: _c, refHash: _r, ...content } = out;
      const json = JSON.stringify(content);
      for (const bad of ["Dotty", "dotty", "Habits", "7f3a", "9c1e", "X-7", "4.99", "1234", "1301", "2535", "a@b.co", "Start your", "14:22"]) expect(json).not.toContain(bad);
      expect(out.n).toBe("1k-10k");
      expect(out.at).toBe("2026-10-03");
      expect(out.effect).toBeCloseTo(0.15, 3);
      expect(out.low!).toBeLessThan(0.15);
      expect(out.high!).toBeGreaterThan(0.15);
    }
    const pub = publicOutcome((makeOutcome(input, "salt") as { outcome: Outcome }).outcome);
    expect(Object.keys(pub)).not.toContain("appHash");
    expect(Object.keys(pub)).not.toContain("refHash");
    expect(Object.keys(pub)).not.toContain("accountHash");
  });

  test("the same result twice has the same ref hash; another salt can't be matched", () => {
    const a = (makeOutcome(input, "s1") as { outcome: Outcome }).outcome;
    const b = (makeOutcome(input, "s1") as { outcome: Outcome }).outcome;
    const c = (makeOutcome(input, "s2") as { outcome: Outcome }).outcome;
    expect(a.refHash).toBe(b.refHash);
    expect(a.appHash).not.toBe(c.appHash);
  });

  test("abstract patterns pass; the rest falls back to the kind's label", () => {
    expect(safePattern("paywall.trial_length", "free trial length: 7", "Dotty")).toBe("free trial length: 7");
    expect(safePattern("paywall.trial_length", "Dotty trial", "Dotty")).toBe("Free trial length");
    expect(safePattern("paywall.trial_length", "one two three four five six seven eight nine", "x")).toBe("Free trial length");
  });

  test("effects: delta method for shares, from P(better) for means", () => {
    const share = relativeEffect("conversion", { n: 1000, value: 0.2 }, { n: 1000, value: 0.22 })!;
    expect(share.lift).toBeCloseTo(0.1, 6);
    const se = Math.sqrt(0.78 / 220 + 0.8 / 200);
    expect(Math.log(1 + share.high) - Math.log(1.1)).toBeCloseTo(Z * se, 3);
    const mean = relativeEffect("revenue_per_user", { n: 500, value: 1 }, { n: 500, value: 1.2 }, 0.95)!;
    expect(Math.log(1 + mean.low)).toBeCloseTo(0, 2);
    expect(nBucket(99)).toBe("<100");
    expect(nBucket(10_000)).toBe("10k+");
  });
});

describe("taxonomy", () => {
  test("categories and change kinds", () => {
    expect(categorize("Health & Fitness")).toBe("health_fitness");
    expect(categorize(null, "A meditation timer for busy parents")).toBe("health_fitness");
    expect(categorize("")).toBe("other");
    expect(kindForKeys(["paywall.trial_days"])).toBe("paywall.trial_length");
    expect(kindForKeys(["onboarding.skip_signup"])).toBe("onboarding.skip_signup");
    expect(kindForKeys(["ads.interstitial_every"])).toBe("ads.interstitial_frequency");
  });
});

describe("build playbook", () => {
  const stack = { framework: "expo54", packages: ["react-native-reanimated", "expo-router"] };
  test("signature: framework, package, error type", () => {
    expect(errorSignature("Unable to resolve module 'react-native-reanimated' from app/index.tsx", stack)).toMatchObject({ key: "expo54|react-native-reanimated|module_not_found" });
    expect(errorSignature("verifier: ERESOLVE could not resolve", stack).errorType).toBe("peer_dependency");
  });
  test("fixes are generalized: no code, paths, quotes or the app's name", () => {
    const fix = generalizeFix("## What happened\nx\n## What changed\nAdded `react-native-reanimated/plugin` to babel in `babel.config.js` and src/screens/DottyHome.tsx; Dotty now builds. ```js\nplugins: []\n``` \"secret text\"\n## Evidence\nok", "Dotty")!;
    expect(fix).not.toContain("Dotty");
    expect(fix).not.toContain("src/screens");
    expect(fix).not.toContain("plugins: []");
    expect(fix).not.toContain("secret text");
    expect(fix).toContain("react-native-reanimated/plugin");
  });
  test("a failure then a fix makes a candidate; only approved entries reach the agent, for matching stacks", () => {
    const open = noteFailure([], { ref: "t1", app: "a1", account: "c1", key: "expo54|react-native-reanimated|module_not_found", framework: "expo54", pkg: "react-native-reanimated", errorType: "module_not_found", at: "2026-10-01T00:00:00Z" });
    const r = noteFix([], open, "t1", "Add the Reanimated babel plugin and clear the Metro cache.", new Date("2026-10-02T00:00:00Z"));
    expect(r.open).toEqual([]);
    expect(r.entry!.status).toBe("candidate");
    expect(playbookNotes(r.entries, stack)).toBe("");
    const approved: PlaybookEntry[] = r.entries.map((e) => ({ ...e, status: "approved" }));
    expect(playbookNotes(approved, stack)).toContain("Reanimated babel plugin");
    expect(playbookNotes(approved, { framework: "expo53", packages: stack.packages })).toBe("");
    expect(playbookNotes(approved, { framework: "expo54", packages: [] })).toBe("");
  });
});
