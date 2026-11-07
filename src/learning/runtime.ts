import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppEntry } from "../apps-registry";
import { storeIdsFromRepo } from "../ads/app-links";
import { db } from "../db";
import { dataDir } from "../day2-paths";
import { appKind } from "../field-work";
import { APP_PROFILE_FILENAME, loadAppProfile } from "../onboarding";
import { loadRetention, RETENTION_FILENAME } from "../retention";
import { currentTenant, LOCAL_ACCOUNT_ID, serverMode } from "../tenant";
import { hashWith, makeOutcome, type AppContext, type OutcomeInput, type Verdict } from "./library";
import { errorSignature, generalizeFix, noteFailure, noteFix, playbookNotes, stackOf } from "./playbook";
import { describePrior, experimentPrior, isStrong, MIN_APPS, priorFor, type Prior } from "./priors";
import { dbLearningStore, fileLearningStore, type LearningStore } from "./store";
import { CHANGE_KINDS, categorize, kindForKeys, type ChangeKind, type Metric } from "./taxonomy";

/**
 * Learning across apps, wired to how day2 runs: the platform store, the
 * salt, each app's anonymous context, recording decided results from every
 * module (when the account shares), what worked elsewhere for the prompts
 * and the console, informative priors for Live, and the build playbook.
 * Everything here is best-effort: learning never breaks the work it rides on.
 */

export const LEARNING_FILENAME = "day2-learning.json";

export function learningStore(): LearningStore {
  return serverMode() === "accounts" ? dbLearningStore(db()) : fileLearningStore(join(dataDir(), LEARNING_FILENAME));
}

let cachedSalt: string | null = null;
/** The salt for app hashes: DAY2_LEARNING_SALT, else derived from DAY2_SECRETS_KEY, else a random one kept in day2's data folder. */
export function learningSalt(): string {
  if (cachedSalt) return cachedSalt;
  if (process.env.DAY2_LEARNING_SALT) return (cachedSalt = process.env.DAY2_LEARNING_SALT);
  if (process.env.DAY2_SECRETS_KEY) return (cachedSalt = createHmac("sha256", process.env.DAY2_SECRETS_KEY).update("day2-learning-salt").digest("hex"));
  const file = join(dataDir(), ".day2-learning-salt");
  if (!existsSync(file)) {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return (cachedSalt = readFileSync(file, "utf-8").trim());
}
/** Tests switch data folders. */
export const resetLearningSalt = () => (cachedSalt = null);

export const appHashOf = (appId: string) => hashWith(learningSalt(), `app:${appId}`);
export const accountHashOf = (accountId: string) => hashWith(learningSalt(), `account:${accountId}`);

/** The app in the library's words only: category, product type, platform. */
export function appContextFor(app: Pick<AppEntry, "repoPath">): AppContext {
  let research: { category?: string; productType?: string } | undefined;
  try {
    research = loadRetention(resolve(app.repoPath, RETENTION_FILENAME)).research[0];
  } catch {
    research = undefined;
  }
  const profile = (() => {
    try {
      return loadAppProfile(resolve(app.repoPath, APP_PROFILE_FILENAME));
    } catch {
      return null;
    }
  })();
  const category = categorize(research?.category, profile?.purpose, profile?.targetUsers);
  const productType = (["habit", "routine", "episodic", "work", "transactional"] as const).find((p) => p === research?.productType) ?? "unknown";
  let platform: AppContext["platform"] = "web";
  try {
    if (appKind(app.repoPath) === "react-native") {
      const ids = storeIdsFromRepo(app.repoPath);
      platform = ids.bundleId && !ids.packageName ? "ios" : ids.packageName && !ids.bundleId ? "android" : "both";
    }
  } catch {
    platform = "both";
  }
  return { category, productType, platform };
}

const accountOf = (accountId?: string) => accountId ?? currentTenant()?.accountId ?? LOCAL_ACCOUNT_ID;

/** Whether this account shares anonymous outcomes (default yes). */
export async function sharesLearning(accountId?: string): Promise<boolean> {
  try {
    return await learningStore().sharing(accountOf(accountId));
  } catch {
    return false;
  }
}

export type DecidedResult = Omit<OutcomeInput, "appId" | "accountId" | "appName" | "context" | "at"> & { at?: Date };

/** Records one decided result in the library — only when the app's account shares, and only what passes the privacy checks. */
export async function recordOutcome(app: Pick<AppEntry, "id" | "name" | "repoPath">, r: DecidedResult, opts: { accountId?: string; store?: LearningStore; context?: AppContext } = {}): Promise<boolean> {
  try {
    const store = opts.store ?? learningStore();
    const accountId = accountOf(opts.accountId);
    if (!(await store.sharing(accountId))) return false;
    const made = makeOutcome({ ...r, appId: app.id, accountId, appName: app.name, context: opts.context ?? appContextFor(app), at: r.at ?? new Date() }, learningSalt());
    return made.ok ? await store.record(made.outcome) : false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// From each module's decided results
// ---------------------------------------------------------------------------

const NUMERIC_KINDS: ReadonlySet<ChangeKind> = new Set<ChangeKind>(["paywall.trial_length", "ads.interstitial_frequency", "onboarding.length", "push.permission_timing", "store.review_prompt_timing"]);
const verdictOf = (v: string): Verdict | null => (v === "better" ? "better" : v === "worse" ? "worse" : v === "no_clear_change" || v === "no_difference" ? "no_clear_change" : null);

/** A Live experiment (Money's tests run there too) that was decided. */
export async function recordLiveVerdict(
  app: Pick<AppEntry, "id" | "name" | "repoPath">,
  e: { id: string; title: string; keys: string[]; metric: { kind: string }; variants: Array<{ name: string; values: Record<string, unknown> }> },
  result: { verdict: string; winner: string | null; arms: Array<{ name: string; n: number; value: number | null; probBetter: number | null }> },
  opts: { accountId?: string; source?: "live" | "money" } = {},
): Promise<boolean> {
  const verdict = verdictOf(result.verdict);
  if (!verdict) return false;
  const control = result.arms.find((a) => a.name === "control");
  const others = result.arms.filter((a) => a.name !== "control");
  const arm = others.find((a) => a.name === result.winner) ?? others.sort((a, b) => (b.probBetter ?? 0) - (a.probBetter ?? 0))[0];
  if (!control || !arm) return false;
  const kind = kindForKeys(e.keys, e.title);
  const metric: Metric = e.metric.kind === "retention_d7" ? "d7_retention" : e.metric.kind === "revenue_per_user" ? "revenue_per_user" : "conversion";
  const v = e.variants.find((x) => x.name === arm.name)?.values ?? {};
  const nums = Object.values(v).filter((x): x is number => typeof x === "number");
  const pattern = NUMERIC_KINDS.has(kind) && nums.length === 1 ? `${CHANGE_KINDS[kind].label.toLowerCase()}: ${nums[0]}` : undefined;
  return recordOutcome(
    app,
    { kind, pattern, metric, control: { n: control.n, value: control.value }, treatment: { n: arm.n, value: arm.value }, probBetter: arm.probBetter, n: control.n + arm.n, verdict, source: opts.source ?? (e.keys.some((k) => /^(paywall|ads?|price)/.test(k)) ? "money" : "live"), sourceId: e.id },
    opts,
  );
}

const AUDIENCE_KIND: Record<string, ChangeKind> = { onboarding_d1: "push.onboarding_d1", onboarding_d3: "push.onboarding_d1", at_risk: "push.at_risk", lapsing: "push.winback", winback: "push.winback" };

/** A Messages campaign measured against its holdout. */
export async function recordCampaign(
  app: Pick<AppEntry, "id" | "name" | "repoPath">,
  c: { id: string; kind: string; audience?: string; channel: string },
  r: { state: string; treated: number; held: number; treatedRate: number; heldRate: number; probabilityBetter: number },
  opts: { accountId?: string } = {},
): Promise<boolean> {
  const verdict = verdictOf(r.state);
  if (!verdict) return false;
  const kind: ChangeKind = c.channel !== "push" ? "inapp.message" : c.kind === "trigger" ? "push.trigger" : (AUDIENCE_KIND[c.audience ?? ""] ?? "push.trigger");
  return recordOutcome(app, { kind, metric: "return_rate", control: { n: r.held, value: r.heldRate }, treatment: { n: r.treated, value: r.treatedRate }, probBetter: r.probabilityBetter, n: r.held + r.treated, verdict, source: "messages", sourceId: c.id }, opts);
}

/** A retention treatment measured against its holdout. */
export async function recordTreatment(
  app: Pick<AppEntry, "id" | "name" | "repoPath">,
  t: { id: string; target: string; channel: string },
  r: { state: string; treated?: number; held?: number; treatedRate?: number; heldRate?: number; probabilityBetter?: number },
  opts: { accountId?: string } = {},
): Promise<boolean> {
  const verdict = verdictOf(r.state);
  const kind = `retention.${t.target}`;
  if (!verdict || !(kind in CHANGE_KINDS) || r.treated === undefined || r.held === undefined) return false;
  return recordOutcome(app, { kind: kind as ChangeKind, pattern: `${t.channel.replace(/_/g, "-")} treatment`, metric: "return_rate", control: { n: r.held, value: r.heldRate ?? null }, treatment: { n: r.treated, value: r.treatedRate ?? null }, probBetter: r.probabilityBetter ?? null, n: r.held + r.treated, verdict, source: "retention", sourceId: t.id }, opts);
}

/** A Store product page test with its result (the winner; the effect when the store reported one). */
export async function recordStoreTest(app: Pick<AppEntry, "id" | "name" | "repoPath">, t: { id: string; kind: string; treatments: Array<{ name: string }>; result: { winner: string } | null }, opts: { accountId?: string; effect?: { lift: number; low: number; high: number } | null } = {}): Promise<boolean> {
  if (!t.result) return false;
  const winner = t.result.winner.trim().toLowerCase();
  const verdict: Verdict = !winner || /control|original|current|none|no clear/.test(winner) ? "no_clear_change" : "better";
  return recordOutcome(app, { kind: "store.screenshots", metric: "store_conversion", effect: opts.effect ?? null, n: 1000, verdict, source: "store", sourceId: t.id }, opts);
}

/** An acquisition bet (its people against everyone else). */
export async function recordBet(
  app: Pick<AppEntry, "id" | "name" | "repoPath">,
  b: { id: string; channel: string },
  v: { state: string; betPeople?: number; othersPeople?: number; betRate?: number | null; othersRate?: number | null; probabilityBetter?: number | null },
  opts: { accountId?: string } = {},
): Promise<boolean> {
  const verdict = verdictOf(v.state);
  if (!verdict || v.betPeople === undefined || v.othersPeople === undefined) return false;
  const channel = b.channel.toLowerCase().replace(/[^a-z_ -]/g, "").slice(0, 30);
  return recordOutcome(app, { kind: "acquisition.channel", pattern: channel ? `${channel} channel` : undefined, metric: "conversion", control: { n: v.othersPeople, value: v.othersRate ?? null }, treatment: { n: v.betPeople, value: v.betRate ?? null }, probBetter: v.probabilityBetter ?? null, n: v.betPeople + v.othersPeople, verdict, source: "ads", sourceId: b.id }, opts);
}

// ---------------------------------------------------------------------------
// Using it
// ---------------------------------------------------------------------------

export type Module = "live" | "money" | "messages" | "store" | "retention" | "create" | "growth" | "social";

const MODULE_KINDS: Record<Module, (k: ChangeKind) => boolean> = {
  live: (k) => /^(onboarding|paywall|ui|push\.permission|store\.review)/.test(k),
  money: (k) => /^(paywall|price|ads\.)/.test(k),
  messages: (k) => /^(push|inapp)/.test(k),
  store: (k) => /^store\./.test(k),
  retention: (k) => /^retention\./.test(k),
  create: (k) => k !== "other",
  growth: (k) => /^acquisition\./.test(k),
  social: (k) => /^social\./.test(k),
};

export type Worked = { kind: ChangeKind; text: string; pHelps: number; apps: number };

/** What worked for similar apps, for one module's ideas: strongest first, never from this app's or this account's own results. */
export async function whatWorked(app: Pick<AppEntry, "id" | "repoPath">, module: Module, opts: { max?: number; store?: LearningStore; context?: AppContext; accountId?: string } = {}): Promise<Worked[]> {
  try {
    const all = await (opts.store ?? learningStore()).outcomes();
    const { category } = opts.context ?? appContextFor(app);
    const exclude = { excludeApp: appHashOf(app.id), excludeAccount: accountHashOf(accountOf(opts.accountId)) };
    const kinds = [...new Set(all.map((o) => o.kind))].filter(MODULE_KINDS[module]);
    const out: Worked[] = [];
    for (const kind of kinds) {
      const p = priorFor(all, { category, kind, ...exclude });
      if (p) out.push({ kind, text: describePrior(p), pHelps: p.pHelps, apps: p.apps });
    }
    return out.sort((a, b) => b.pHelps - a.pHelps).slice(0, opts.max ?? 5);
  } catch {
    return [];
  }
}

/** For prompts: one line each. */
export const workedLines = async (app: Pick<AppEntry, "id" | "repoPath">, module: Module) => (await whatWorked(app, module)).map((w) => w.text);

/** The prior for one kind of change for this app (own results excluded). */
export async function priorForApp(app: Pick<AppEntry, "id" | "repoPath">, kind: ChangeKind, metric?: Metric, store?: LearningStore, accountId?: string): Promise<Prior | null> {
  try {
    const all = await (store ?? learningStore()).outcomes({ kind });
    // Every app of the asking account is left out, not only this one: an account can't subtract its own results to see someone else's.
    return priorFor(all, { category: appContextFor(app).category, kind, metric, excludeApp: appHashOf(app.id), excludeAccount: accountHashOf(accountOf(accountId)) });
  } catch {
    return null;
  }
}

/** The informative prior for a Live experiment's Bayesian test, and whether it's strong enough to need fewer users. */
export async function liveExperimentPrior(app: Pick<AppEntry, "id" | "repoPath">, e: { keys: string[]; title: string; metric: { kind: string }; minPerArm: number }, baseRate: number | null, store?: LearningStore): Promise<{ prior: { mean: number; sd: number }; strong: boolean; text: string } | null> {
  if (e.metric.kind === "revenue_per_user") return null;
  const metric: Metric = e.metric.kind === "retention_d7" ? "d7_retention" : "conversion";
  const p = await priorForApp(app, kindForKeys(e.keys, e.title), metric, store);
  if (!p) return null;
  return { prior: experimentPrior(p, { minPerArm: e.minPerArm, baseRate }), strong: isStrong(p), text: describePrior(p) };
}

/** Best-known starting points for a new app of this category (each still an experiment with a holdout). */
export async function startingPoints(category: ReturnType<typeof categorize>, store?: LearningStore, accountId?: string): Promise<string[]> {
  try {
    const mine = accountHashOf(accountOf(accountId));
    const all = (await (store ?? learningStore()).outcomes()).filter((o) => o.accountHash !== mine);
    const out: string[] = [];
    for (const kind of NUMERIC_KINDS) {
      const wins = all.filter((o) => o.kind === kind && o.verdict === "better" && o.pattern.includes(":"));
      const byValue = new Map<string, { apps: Set<string>; accounts: Set<string> }>();
      for (const o of wins) {
        const value = o.pattern.split(":").pop()!.trim();
        const v = byValue.get(value) ?? byValue.set(value, { apps: new Set(), accounts: new Set() }).get(value)!;
        v.apps.add(o.appHash);
        v.accounts.add(o.accountHash);
      }
      const best = [...byValue.entries()].filter(([, v]) => v.accounts.size >= MIN_APPS).sort((a, b) => b[1].apps.size - a[1].apps.size)[0];
      if (best) out.push(`${CHANGE_KINDS[kind].label}: ${best[0]} won in ${best[1].apps.size} apps`);
      const p = priorFor(all, { category, kind });
      if (p && p.pHelps >= 0.7) out.push(describePrior(p));
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The build playbook
// ---------------------------------------------------------------------------

/** A build or check failed on a ticket: its signature waits for the fix. */
export async function noteBuildFailure(app: Pick<AppEntry, "id" | "repoPath">, ticketId: string, reason: string, store?: LearningStore): Promise<void> {
  try {
    if (!(await sharesLearning())) return;
    const sig = errorSignature(reason, stackOf(app.repoPath));
    const ref = hashWith(learningSalt(), `ticket:${app.id}:${ticketId}`);
    await (store ?? learningStore()).updatePlaybook((s) => ({ state: { ...s, open: noteFailure(s.open, { ref, app: appHashOf(app.id), account: accountHashOf(accountOf()), key: sig.key, framework: sig.framework, pkg: sig.pkg, errorType: sig.errorType, at: new Date().toISOString() }) }, result: null }));
  } catch {
    /* best-effort */
  }
}

/** The same ticket got through after failing: the generalized fix becomes a playbook candidate for the operator. */
export async function noteBuildFixed(app: Pick<AppEntry, "id" | "name">, ticketId: string, summary: string, store?: LearningStore): Promise<void> {
  try {
    if (!(await sharesLearning())) return;
    const ref = hashWith(learningSalt(), `ticket:${app.id}:${ticketId}`);
    const fix = generalizeFix(summary, app.name);
    await (store ?? learningStore()).updatePlaybook((s) => {
      if (!s.open.some((f) => f.ref === ref)) return { state: s, result: null };
      const r = noteFix(s.entries, s.open, ref, fix, new Date());
      return { state: { entries: r.entries, open: r.open }, result: null };
    });
  } catch {
    /* best-effort */
  }
}

/** Approved playbook entries for this app's stack, for the build agent's notes. */
export async function playbookFor(app: Pick<AppEntry, "repoPath">, store?: LearningStore): Promise<string> {
  try {
    return playbookNotes((await (store ?? learningStore()).playbook()).entries, stackOf(app.repoPath));
  } catch {
    return "";
  }
}

/** A possible new false-positive pattern from the calibration loop, for review. */
export async function noteFalsePositiveCandidate(persona: string, text: string, store?: LearningStore): Promise<void> {
  try {
    const { scrub, tidy } = await import("../memory/privacy");
    await (store ?? learningStore()).addCandidate(persona, tidy(scrub(text), 600), new Date());
  } catch {
    /* best-effort */
  }
}

/** An account stopped sharing: everything it shared goes (outcomes, open failures, its hashes on playbook entries). */
export async function forgetAccount(accountId: string, appIds: string[] = [], store?: LearningStore): Promise<number> {
  return (store ?? learningStore()).forget({ accounts: [accountHashOf(accountId)], apps: appIds.map(appHashOf) });
}

/** An app was removed: its results leave the library. Never throws. */
export async function forgetApp(appId: string, store?: LearningStore): Promise<void> {
  try {
    await (store ?? learningStore()).forget({ apps: [appHashOf(appId)] });
  } catch {
    /* best-effort */
  }
}
