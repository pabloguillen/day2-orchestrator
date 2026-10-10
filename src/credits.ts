/**
 * One account-wide credit balance (console "Plan & credits").
 *
 * Every paid thing day2 does — agent work on tickets, scans and answers,
 * growth content, paid ads, app builds with Lovable, infrastructure — is
 * paid for from a single balance of credits. A credit's list value is
 * €0.01. What a charge costs in credits is day2's real cost times a hidden
 * per-service markup; the markup and the real cost never leave this module
 * through the API (see `toPublicCharge`), only credit amounts do.
 *
 * Pure core + thin IO, same split as spend-governance.ts: everything that
 * decides anything (grants, allocation, authorization, summaries) is a pure
 * function of (account, events, now); the IO layer at the bottom only
 * reads/appends files under a cross-process lock.
 *
 * Ledger model: append-only JSONL of `grant` and `charge` events. A grant is
 * a "lot" of credits with what was paid for it and when it expires; a charge
 * records exactly which lots it drew from, decided at write time. The
 * balance is a replay of those events — nothing is ever rewritten, and a lot
 * can never go below zero.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Catalog — plans, top-ups, markups
// ---------------------------------------------------------------------------

export type PlanId = "trial" | "starter" | "growth" | "scale";
export type PaidPlanId = Exclude<PlanId, "trial">;
export type BillingCycle = "monthly" | "yearly";

export type PlanFeatures = {
  paidAds: boolean;
  createApps: boolean;
  trackerSync: boolean;
  parallelWork: boolean;
  prioritySupport: boolean;
};

export type Plan = {
  id: PlanId;
  name: string;
  /** Monthly list price in euro cents, excl. VAT. Yearly billing takes
   * `YEARLY_DISCOUNT` off this. */
  priceEurCents: number;
  /** Credits granted per calendar month (trial: once). */
  monthlyCredits: number;
  maxApps: number;
  seats: number;
  features: PlanFeatures;
};

export const TRIAL_DAYS = 14;
export const YEARLY_DISCOUNT = 0.2;
export const TOPUP_VALID_DAYS = 365;
/** Unused monthly credits stay usable through the following month. */
export const ROLLOVER_MONTHS = 1;
export const CREDIT_LIST_VALUE_EUR = 0.01;

export const PLANS: Record<PlanId, Plan> = {
  trial: {
    id: "trial",
    name: "Trial",
    priceEurCents: 0,
    monthlyCredits: 1_000,
    maxApps: 1,
    seats: 1,
    features: { paidAds: false, createApps: false, trackerSync: false, parallelWork: false, prioritySupport: false },
  },
  starter: {
    id: "starter",
    name: "Starter",
    priceEurCents: 2_900,
    monthlyCredits: 3_000,
    maxApps: 1,
    seats: 1,
    features: { paidAds: true, createApps: false, trackerSync: false, parallelWork: false, prioritySupport: false },
  },
  growth: {
    id: "growth",
    name: "Growth",
    priceEurCents: 7_900,
    monthlyCredits: 8_500,
    maxApps: 3,
    seats: 3,
    features: { paidAds: true, createApps: true, trackerSync: true, parallelWork: false, prioritySupport: false },
  },
  scale: {
    id: "scale",
    name: "Scale",
    priceEurCents: 19_900,
    monthlyCredits: 22_000,
    maxApps: 10,
    seats: 10,
    features: { paidAds: true, createApps: true, trackerSync: true, parallelWork: true, prioritySupport: true },
  },
};

export const PLAN_ORDER: PlanId[] = ["trial", "starter", "growth", "scale"];

export type TopUpPack = { id: string; credits: number; priceEurCents: number };
export const TOPUP_PACKS: TopUpPack[] = [
  { id: "1k", credits: 1_000, priceEurCents: 1_000 },
  { id: "10k", credits: 10_000, priceEurCents: 10_000 },
];

export type CreditService = "agent_work" | "scan_answer" | "content_generation" | "paid_ads" | "app_build" | "infra";
export const CREDIT_SERVICES: CreditService[] = [
  "agent_work",
  "scan_answer",
  "content_generation",
  "paid_ads",
  "app_build",
  "infra",
];

/** Hidden markup on day2's real cost, per service. Never sent to a client. */
export const MARKUP: Record<CreditService, number> = {
  agent_work: 3.0,
  scan_answer: 3.0,
  content_generation: 3.0,
  app_build: 2.0,
  infra: 1.5,
  paid_ads: 1.2,
};

/** Services whose margin is thin enough that converting at the €0.01 list
 * value could sell discounted (yearly / higher-tier) credits below cost.
 * These convert using what the customer actually paid for the specific
 * credits being consumed, and can never draw from free lots. */
const VALUE_AWARE: ReadonlySet<CreditService> = new Set<CreditService>(["paid_ads"]);

/** USD -> EUR used to convert provider costs (Anthropic, Lovable, ad
 * platforms bill in USD). Operator-set; the default is deliberately on the
 * high side so a stale rate errs toward charging enough, not too little. */
export function usdToEurRate(): number {
  const raw = Number(process.env.DAY2_USD_TO_EUR);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.95;
}

export function planPriceEurCents(plan: Plan, cycle: BillingCycle): number {
  return cycle === "yearly" ? Math.round(plan.priceEurCents * (1 - YEARLY_DISCOUNT)) : plan.priceEurCents;
}

// ---------------------------------------------------------------------------
// Account + ledger shapes
// ---------------------------------------------------------------------------

export type AppCreditCaps = { monthlyCredits?: number; dailyCredits?: number };

export type CreditAccount = {
  plan: PlanId;
  billingCycle: BillingCycle;
  /** When the account (and so the trial) started. */
  startedAt: string;
  /** When the current plan took effect — grants start from its month. */
  planSince: string;
  /** A downgrade waits for the next month so paid-for credits aren't lost. */
  pendingPlan?: { plan: PaidPlanId; billingCycle: BillingCycle; from: string };
  autoTopUp?: { enabled: boolean; packId: string };
  appCaps: Record<string, AppCreditCaps>;
};

export type GrantSource = "trial" | "plan" | "topup" | "manual";

export type GrantEvent = {
  kind: "grant";
  id: string;
  at: string;
  source: GrantSource;
  credits: number;
  /** What the customer paid for this lot, euro cents. 0 for free lots. */
  eurCents: number;
  expiresAt: string;
  planId?: PlanId;
  note?: string;
};

export type LotDraw = { lotId: string; credits: number };

export type ChargeEvent = {
  kind: "charge";
  id: string;
  at: string;
  appId: string | null;
  service: CreditService;
  description: string;
  /** day2's real cost. Internal only — stripped by `toPublicCharge`. */
  costUsd: number;
  credits: number;
  draws: LotDraw[];
  /** Credits the charge should have cost but the balance couldn't cover
   * (an agent run that overshot its estimate on an emptying balance).
   * Recorded for the operator, never collected — no debt. */
  uncollectedCredits: number;
};

export type CreditEvent = GrantEvent | ChargeEvent;

// ---------------------------------------------------------------------------
// Time helpers (UTC calendar months)
// ---------------------------------------------------------------------------

export function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

const iso = (d: Date) => d.toISOString();
const t = (s: string) => new Date(s).getTime();

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

export function newAccount(now: Date): CreditAccount {
  return { plan: "trial", billingCycle: "monthly", startedAt: iso(now), planSince: iso(now), appCaps: {} };
}

/**
 * The grants that should exist by `now` but don't yet — idempotent by id.
 * Also applies a pending downgrade once its month has started. Only looks
 * back as far as rollover could still matter; older grants would already
 * be expired.
 */
export function dueGrants(
  account: CreditAccount,
  events: CreditEvent[],
  now: Date,
): { account: CreditAccount; grants: GrantEvent[] } {
  let acc = account;
  if (acc.pendingPlan && t(acc.pendingPlan.from) <= now.getTime()) {
    acc = {
      ...acc,
      plan: acc.pendingPlan.plan,
      billingCycle: acc.pendingPlan.billingCycle,
      planSince: acc.pendingPlan.from,
      pendingPlan: undefined,
    };
  }
  const have = new Set(events.filter((e) => e.kind === "grant").map((e) => e.id));
  const grants: GrantEvent[] = [];

  const started = new Date(acc.startedAt);
  if (!have.has("trial")) {
    const trial = PLANS.trial;
    grants.push({
      kind: "grant",
      id: "trial",
      at: iso(started),
      source: "trial",
      credits: trial.monthlyCredits,
      eurCents: 0,
      expiresAt: iso(addDays(started, TRIAL_DAYS)),
      planId: "trial",
    });
  }

  if (acc.plan !== "trial") {
    const plan = PLANS[acc.plan];
    const since = new Date(acc.planSince);
    const first = new Date(Math.max(monthStart(since).getTime(), addMonths(monthStart(now), -ROLLOVER_MONTHS).getTime()));
    for (let m = first; m.getTime() <= now.getTime(); m = addMonths(m, 1)) {
      const id = `plan:${monthKey(m)}`;
      if (have.has(id)) continue;
      const at = new Date(Math.max(m.getTime(), since.getTime()));
      grants.push({
        kind: "grant",
        id,
        at: iso(at),
        source: "plan",
        credits: plan.monthlyCredits,
        eurCents: planPriceEurCents(plan, acc.billingCycle),
        expiresAt: iso(addMonths(m, 1 + ROLLOVER_MONTHS)),
        planId: plan.id,
      });
    }
  }
  return { account: acc, grants };
}

export type Lot = GrantEvent & { remaining: number; eurPerCredit: number };

/** Every grant with what's left of it, regardless of whether it's active. */
export function lotsOf(events: CreditEvent[]): Lot[] {
  const drawn = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== "charge") continue;
    for (const d of e.draws) drawn.set(d.lotId, (drawn.get(d.lotId) ?? 0) + d.credits);
  }
  const seen = new Set<string>();
  const lots: Lot[] = [];
  for (const e of events) {
    if (e.kind !== "grant" || seen.has(e.id)) continue;
    seen.add(e.id);
    lots.push({
      ...e,
      remaining: Math.max(0, e.credits - (drawn.get(e.id) ?? 0)),
      eurPerCredit: e.credits > 0 ? e.eurCents / 100 / e.credits : 0,
    });
  }
  return lots;
}

/** Lots usable at `at`, in the order credits are consumed: monthly/trial/
 * manual credits first, top-ups after; within each, soonest-expiring first. */
export function activeLots(events: CreditEvent[], at: Date): Lot[] {
  const ms = at.getTime();
  return lotsOf(events)
    .filter((l) => l.remaining > 0 && t(l.at) <= ms && ms < t(l.expiresAt))
    .sort((a, b) => {
      const ga = a.source === "topup" ? 1 : 0;
      const gb = b.source === "topup" ? 1 : 0;
      if (ga !== gb) return ga - gb;
      if (a.expiresAt !== b.expiresAt) return t(a.expiresAt) - t(b.expiresAt);
      return t(a.at) - t(b.at);
    });
}

export type Allocation = { credits: number; draws: LotDraw[]; shortfallCredits: number; covered: boolean };

/**
 * How many credits a cost is, and which lots pay for it. Pure.
 *
 * Normal services: credits = ceil(costEur × markup / €0.01), drawn in lot
 * order. Value-aware services (paid ads): the marked-up euro value is
 * matched against what each lot was actually bought for, so a discounted
 * credit is worth exactly what it cost the customer, and free lots can't
 * pay for media at all.
 */
export function allocate(service: CreditService, costUsd: number, lots: Lot[], fx = usdToEurRate()): Allocation {
  const valueEur = Math.max(0, costUsd) * fx * MARKUP[service];
  const draws: LotDraw[] = [];

  if (!VALUE_AWARE.has(service)) {
    const needed = valueEur <= 0 ? 0 : Math.ceil(valueEur / CREDIT_LIST_VALUE_EUR - 1e-9);
    let left = needed;
    for (const lot of lots) {
      if (left <= 0) break;
      const take = Math.min(left, lot.remaining);
      if (take > 0) draws.push({ lotId: lot.id, credits: take });
      left -= take;
    }
    return { credits: needed - left, draws, shortfallCredits: left, covered: left === 0 };
  }

  let valueLeft = valueEur;
  let credits = 0;
  for (const lot of lots) {
    if (valueLeft <= 1e-9) break;
    if (lot.eurPerCredit <= 0) continue;
    const need = Math.ceil(valueLeft / lot.eurPerCredit - 1e-9);
    const take = Math.min(need, lot.remaining);
    if (take <= 0) continue;
    draws.push({ lotId: lot.id, credits: take });
    credits += take;
    valueLeft -= take * lot.eurPerCredit;
  }
  const covered = valueLeft <= 1e-9;
  // Shortfall expressed at list value — what it would take in fresh top-ups.
  const shortfallCredits = covered ? 0 : Math.ceil(valueLeft / CREDIT_LIST_VALUE_EUR - 1e-9);
  return { credits, draws, shortfallCredits, covered };
}

function totalRemaining(lots: Lot[]): number {
  return lots.reduce((s, l) => s + l.remaining, 0);
}

function chargesOf(events: CreditEvent[]): ChargeEvent[] {
  const seen = new Set<string>();
  const out: ChargeEvent[] = [];
  for (const e of events) {
    if (e.kind !== "charge" || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

function appUsage(events: CreditEvent[], appId: string, now: Date): { month: number; day: number } {
  const m0 = monthStart(now).getTime();
  const day = now.toISOString().slice(0, 10);
  let month = 0;
  let today = 0;
  for (const c of chargesOf(events)) {
    if (c.appId !== appId) continue;
    if (t(c.at) >= m0 && t(c.at) < addMonths(monthStart(now), 1).getTime()) month += c.credits;
    if (c.at.slice(0, 10) === day) today += c.credits;
  }
  return { month, day: today };
}

export type CreditCheck =
  | { ok: true; maxCredits: number }
  | { ok: false; code: "plan" | "kill_switch" | "balance" | "app_cap" | "daily_cap"; reason: string; maxCredits: number };

const fmt = (n: number) => n.toLocaleString("en-US");

const SERVICE_NAMES: Record<CreditService, string> = {
  agent_work: "Fixes & features",
  scan_answer: "Scans & answers",
  content_generation: "Growth content",
  paid_ads: "Paid ads",
  app_build: "App building",
  infra: "Hosting",
};

export function serviceName(s: CreditService): string {
  return SERVICE_NAMES[s];
}

/**
 * Pure gate run before anything that costs credits. `maxCostUsd` is the most
 * the action can cost (an agent run's `maxBudgetUsd`, an ad's spend) — the
 * check passes only if the balance and the app's caps can cover that worst
 * case, which is what keeps the balance from ever going into debt.
 */
export function checkCredits(input: {
  account: CreditAccount;
  events: CreditEvent[];
  now: Date;
  appId: string | null;
  appName?: string;
  service: CreditService;
  maxCostUsd: number;
  killSwitch?: boolean;
  fx?: number;
}): CreditCheck {
  const { account, events, now, appId, service } = input;
  const plan = PLANS[account.plan];
  const lots = activeLots(events, now);
  const alloc = allocate(service, input.maxCostUsd, lots, input.fx);
  const maxCredits = alloc.credits + alloc.shortfallCredits;
  const no = (code: Exclude<CreditCheck, { ok: true }>["code"], reason: string): CreditCheck => ({
    ok: false,
    code,
    reason,
    maxCredits,
  });

  if (service === "paid_ads" && !plan.features.paidAds) {
    return no("plan", `Paid ads aren't included in the ${plan.name} plan — switch to Starter or higher.`);
  }
  if (service === "app_build" && !plan.features.createApps) {
    return no("plan", `Creating apps isn't included in the ${plan.name} plan — switch to Growth or Scale.`);
  }
  if (input.killSwitch) {
    return no("kill_switch", `The kill switch is on for ${input.appName ?? "this app"} — nothing that uses credits will run.`);
  }
  if (!alloc.covered) {
    const have = totalRemaining(lots);
    return no(
      "balance",
      `Not enough credits — this can use up to ${fmt(maxCredits)} and ${fmt(have)} are left. Top up or change your plan.`,
    );
  }
  if (appId) {
    const caps = account.appCaps[appId] ?? {};
    const usage = appUsage(events, appId, now);
    if (caps.monthlyCredits !== undefined && usage.month + maxCredits > caps.monthlyCredits) {
      return no(
        "app_cap",
        `${input.appName ?? "This app"} would go over its ${fmt(caps.monthlyCredits)}-credit monthly cap (${fmt(usage.month)} used).`,
      );
    }
    if (caps.dailyCredits !== undefined && usage.day + maxCredits > caps.dailyCredits) {
      return no(
        "daily_cap",
        `${input.appName ?? "This app"} would go over its ${fmt(caps.dailyCredits)}-credit daily cap (${fmt(usage.day)} used today).`,
      );
    }
  }
  return { ok: true, maxCredits };
}

/**
 * The charge event for a finished action. Idempotent by id: returns null
 * if a charge with this id already exists. `maxCredits` (from the check)
 * caps the charge — an action never costs more than it was authorized for.
 */
export function buildCharge(input: {
  events: CreditEvent[];
  now: Date;
  id: string;
  appId: string | null;
  service: CreditService;
  costUsd: number;
  description: string;
  maxCredits?: number;
  fx?: number;
}): ChargeEvent | null {
  if (chargesOf(input.events).some((c) => c.id === input.id)) return null;
  const lots = activeLots(input.events, input.now);
  const alloc = allocate(input.service, input.costUsd, lots, input.fx);
  let draws = alloc.draws;
  let credits = alloc.credits;
  let uncollected = alloc.shortfallCredits;
  if (input.maxCredits !== undefined && credits > input.maxCredits) {
    uncollected += credits - input.maxCredits;
    let left = input.maxCredits;
    draws = draws
      .map((d) => {
        const take = Math.min(d.credits, left);
        left -= take;
        return { lotId: d.lotId, credits: take };
      })
      .filter((d) => d.credits > 0);
    credits = input.maxCredits;
  }
  return {
    kind: "charge",
    id: input.id,
    at: iso(input.now),
    appId: input.appId,
    service: input.service,
    description: input.description,
    costUsd: Math.max(0, input.costUsd),
    credits,
    draws,
    uncollectedCredits: uncollected,
  };
}

export function topUpGrant(pack: TopUpPack, now: Date, id = `topup:${randomUUID()}`): GrantEvent {
  return {
    kind: "grant",
    id,
    at: iso(now),
    source: "topup",
    credits: pack.credits,
    eurCents: pack.priceEurCents,
    expiresAt: iso(addDays(now, TOPUP_VALID_DAYS)),
  };
}

/**
 * Plan change. Upgrades apply now and add the difference to this month's
 * allowance (and are billed the price difference); downgrades and moves to
 * the same plan with another cycle wait for next month. Moving back to the
 * trial isn't a plan change.
 */
export function changePlan(
  account: CreditAccount,
  events: CreditEvent[],
  to: PaidPlanId,
  cycle: BillingCycle,
  now: Date,
): { account: CreditAccount; grants: GrantEvent[]; effective: "now" | "next_month" } {
  const from = PLANS[account.plan];
  const target = PLANS[to];
  if (account.plan === "trial") {
    const acc: CreditAccount = { ...account, plan: to, billingCycle: cycle, planSince: iso(now), pendingPlan: undefined };
    return { account: acc, grants: dueGrants(acc, events, now).grants, effective: "now" };
  }
  const isUpgrade = PLAN_ORDER.indexOf(to) > PLAN_ORDER.indexOf(account.plan);
  if (!isUpgrade) {
    if (to === account.plan && cycle === account.billingCycle) {
      return { account: { ...account, pendingPlan: undefined }, grants: [], effective: "now" };
    }
    const acc: CreditAccount = {
      ...account,
      pendingPlan: { plan: to, billingCycle: cycle, from: iso(addMonths(monthStart(now), 1)) },
    };
    return { account: acc, grants: [], effective: "next_month" };
  }
  const m = monthStart(now);
  const acc: CreditAccount = { ...account, plan: to, billingCycle: cycle, pendingPlan: undefined };
  const grants: GrantEvent[] = [];
  const thisMonthId = `plan:${monthKey(m)}`;
  const haveThisMonth = events.some((e) => e.kind === "grant" && e.id === thisMonthId);
  if (haveThisMonth) {
    grants.push({
      kind: "grant",
      id: `plan-upgrade:${monthKey(m)}:${to}`,
      at: iso(now),
      source: "plan",
      credits: target.monthlyCredits - from.monthlyCredits,
      eurCents: Math.max(0, planPriceEurCents(target, cycle) - planPriceEurCents(from, account.billingCycle)),
      expiresAt: iso(addMonths(m, 1 + ROLLOVER_MONTHS)),
      planId: to,
    });
  } else {
    acc.planSince = iso(now);
    grants.push(...dueGrants(acc, events, now).grants);
  }
  return { account: acc, grants: grants.filter((g) => g.credits > 0), effective: "now" };
}

// ---------------------------------------------------------------------------
// Public summary — credits only, never cost or markup
// ---------------------------------------------------------------------------

export type PublicCharge = {
  id: string;
  at: string;
  kind: "charge" | "grant";
  appId: string | null;
  service: CreditService | null;
  source: GrantSource | null;
  description: string;
  /** Negative for charges, positive for grants. */
  credits: number;
};

export function toPublicCharge(e: CreditEvent): PublicCharge {
  if (e.kind === "charge") {
    return { id: e.id, at: e.at, kind: "charge", appId: e.appId, service: e.service, source: null, description: e.description, credits: -e.credits };
  }
  const label =
    e.source === "topup" ? "Top-up" : e.source === "trial" ? "Trial credits" : e.source === "manual" ? (e.note ?? "Credits added") : `${PLANS[e.planId ?? "starter"].name} plan credits`;
  return { id: e.id, at: e.at, kind: "grant", appId: null, service: null, source: e.source, description: label, credits: e.credits };
}

export type CreditSummary = {
  plan: Plan;
  billingCycle: BillingCycle;
  priceEurCents: number;
  pendingPlan: CreditAccount["pendingPlan"] | null;
  trialEndsAt: string | null;
  period: { start: string; renewsAt: string };
  balance: {
    total: number;
    monthly: number;
    topUp: number;
    /** This month's allowance (the plan grant(s) dated this month). */
    allowance: number;
    usedThisMonth: number;
    nextTopUpExpiry: string | null;
  };
  byService: Array<{ service: CreditService; name: string; credits: number; count: number }>;
  byApp: Array<{ appId: string | null; credits: number; count: number }>;
  recent: PublicCharge[];
  appCaps: Record<string, AppCreditCaps & { usedThisMonth: number; usedToday: number }>;
  autoTopUp: CreditAccount["autoTopUp"] | null;
};

export function summarize(account: CreditAccount, events: CreditEvent[], now: Date, recentLimit = 20): CreditSummary {
  const plan = PLANS[account.plan];
  const m0 = monthStart(now);
  const m1 = addMonths(m0, 1);
  const lots = activeLots(events, now);
  const monthly = lots.filter((l) => l.source !== "topup").reduce((s, l) => s + l.remaining, 0);
  const topUpLots = lots.filter((l) => l.source === "topup");
  const topUp = topUpLots.reduce((s, l) => s + l.remaining, 0);
  const grants = lotsOf(events);
  const allowance =
    account.plan === "trial"
      ? PLANS.trial.monthlyCredits
      : grants
          .filter((g) => g.source === "plan" && t(g.at) >= m0.getTime() && t(g.at) < m1.getTime())
          .reduce((s, g) => s + g.credits, 0);

  const charges = chargesOf(events);
  const thisMonth = charges.filter((c) => t(c.at) >= m0.getTime() && t(c.at) < m1.getTime());
  const usedThisMonth = thisMonth.reduce((s, c) => s + c.credits, 0);

  const bySvc = new Map<CreditService, { credits: number; count: number }>();
  const byApp = new Map<string | null, { credits: number; count: number }>();
  for (const c of thisMonth) {
    const s = bySvc.get(c.service) ?? { credits: 0, count: 0 };
    bySvc.set(c.service, { credits: s.credits + c.credits, count: s.count + 1 });
    const a = byApp.get(c.appId) ?? { credits: 0, count: 0 };
    byApp.set(c.appId, { credits: a.credits + c.credits, count: a.count + 1 });
  }

  const appCaps: CreditSummary["appCaps"] = {};
  for (const [appId, caps] of Object.entries(account.appCaps)) {
    const u = appUsage(events, appId, now);
    appCaps[appId] = { ...caps, usedThisMonth: u.month, usedToday: u.day };
  }

  const recent = events
    .filter((e) => t(e.at) <= now.getTime())
    .sort((a, b) => t(b.at) - t(a.at))
    .slice(0, recentLimit)
    .map(toPublicCharge);

  const trialGrant = grants.find((g) => g.id === "trial");
  return {
    plan,
    billingCycle: account.billingCycle,
    priceEurCents: planPriceEurCents(plan, account.billingCycle),
    pendingPlan: account.pendingPlan ?? null,
    trialEndsAt: account.plan === "trial" && trialGrant ? trialGrant.expiresAt : null,
    period: { start: iso(m0), renewsAt: iso(m1) },
    balance: {
      total: monthly + topUp,
      monthly,
      topUp,
      allowance,
      usedThisMonth,
      nextTopUpExpiry: topUpLots.length ? topUpLots.map((l) => l.expiresAt).sort()[0]! : null,
    },
    byService: CREDIT_SERVICES.filter((s) => bySvc.has(s)).map((s) => ({ service: s, name: serviceName(s), ...bySvc.get(s)! })).sort((a, b) => b.credits - a.credits),
    byApp: [...byApp.entries()].map(([appId, v]) => ({ appId, ...v })).sort((a, b) => b.credits - a.credits),
    recent,
    appCaps,
    autoTopUp: account.autoTopUp ?? null,
  };
}

/** Auto top-up trigger: the balance has fallen under 10% of the monthly
 * allowance (or 100 credits, whichever is larger). */
export function shouldAutoTopUp(account: CreditAccount, events: CreditEvent[], now: Date): TopUpPack | null {
  if (!account.autoTopUp?.enabled || account.plan === "trial") return null;
  const pack = TOPUP_PACKS.find((p) => p.id === account.autoTopUp!.packId) ?? TOPUP_PACKS[0]!;
  const total = totalRemaining(activeLots(events, now));
  const threshold = Math.max(100, Math.round(PLANS[account.plan].monthlyCredits * 0.1));
  return total < threshold ? pack : null;
}

// ---------------------------------------------------------------------------
// IO — files + a cross-process lock
// ---------------------------------------------------------------------------

export const CREDIT_ACCOUNT_FILENAME = ".day2-credits-account.json";
export const CREDIT_LEDGER_FILENAME = ".day2-credits-ledger.jsonl";

export type CreditStore = { dir: string };

function accountPath(store: CreditStore) {
  return join(store.dir, CREDIT_ACCOUNT_FILENAME);
}
function ledgerPath(store: CreditStore) {
  return join(store.dir, CREDIT_LEDGER_FILENAME);
}

export function loadEvents(store: CreditStore): CreditEvent[] {
  const p = ledgerPath(store);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CreditEvent);
}

function loadAccountRaw(store: CreditStore): CreditAccount | null {
  const p = accountPath(store);
  if (!existsSync(p)) return null;
  const acc = JSON.parse(readFileSync(p, "utf-8")) as CreditAccount;
  return { ...acc, appCaps: acc.appCaps ?? {} };
}

function saveAccount(store: CreditStore, account: CreditAccount): void {
  mkdirSync(store.dir, { recursive: true });
  const p = accountPath(store);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(account, null, 2)}\n`);
  renameSync(tmp, p);
}

function appendEvents(store: CreditStore, events: CreditEvent[]): void {
  if (!events.length) return;
  mkdirSync(store.dir, { recursive: true });
  appendFileSync(ledgerPath(store), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** mkdir is atomic across processes — the API server and CLIs share one
 * ledger. A lock older than 30s is treated as left behind by a crash. */
export async function withCreditLock<T>(store: CreditStore, fn: () => T | Promise<T>): Promise<T> {
  mkdirSync(store.dir, { recursive: true });
  const lock = join(store.dir, ".day2-credits.lock");
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* raced with another remover */
      }
      if (Date.now() > deadline) throw new Error("Timed out waiting for the credits ledger lock.");
      await sleep(20);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Account + events with any due grants written first. Creates a trial
 * account on first use. Call inside `withCreditLock`. */
function syncState(store: CreditStore, now: Date): { account: CreditAccount; events: CreditEvent[] } {
  const raw = loadAccountRaw(store);
  let account = raw ?? newAccount(now);
  let events = loadEvents(store);
  const due = dueGrants(account, events, now);
  if (!raw || due.account !== account) saveAccount(store, due.account);
  account = due.account;
  if (due.grants.length) {
    appendEvents(store, due.grants);
    events = [...events, ...due.grants];
  }
  return { account, events };
}

export async function readCredits(store: CreditStore, now = new Date()) {
  return withCreditLock(store, () => syncState(store, now));
}

export async function getSummary(store: CreditStore, now = new Date()): Promise<CreditSummary> {
  const { account, events } = await readCredits(store, now);
  return summarize(account, events, now);
}

export async function authorize(
  store: CreditStore,
  req: Omit<Parameters<typeof checkCredits>[0], "account" | "events" | "now">,
  now = new Date(),
): Promise<CreditCheck> {
  const { account, events } = await readCredits(store, now);
  return checkCredits({ ...req, account, events, now });
}

export async function recordCharge(
  store: CreditStore,
  req: Omit<Parameters<typeof buildCharge>[0], "events" | "now">,
  now = new Date(),
): Promise<ChargeEvent | null> {
  return withCreditLock(store, () => {
    const { account, events } = syncState(store, now);
    const charge = buildCharge({ ...req, events, now });
    if (!charge) return null;
    appendEvents(store, [charge]);
    const after = [...events, charge];
    const pack = shouldAutoTopUp(account, after, now);
    if (pack) appendEvents(store, [topUpGrant(pack, now)]);
    return charge;
  });
}

export async function buyTopUp(store: CreditStore, packId: string, now = new Date()): Promise<GrantEvent> {
  const pack = TOPUP_PACKS.find((p) => p.id === packId);
  if (!pack) throw new Error(`Unknown top-up pack "${packId}".`);
  return withCreditLock(store, () => {
    const { account } = syncState(store, now);
    if (account.plan === "trial") throw new Error("Top-ups need a paid plan — choose a plan first.");
    const grant = topUpGrant(pack, now);
    appendEvents(store, [grant]);
    return grant;
  });
}

export async function setPlan(store: CreditStore, to: PaidPlanId, cycle: BillingCycle, now = new Date()) {
  if (!(to in PLANS) || to === ("trial" as PlanId)) throw new Error(`Unknown plan "${to}".`);
  return withCreditLock(store, () => {
    const { account, events } = syncState(store, now);
    const result = changePlan(account, events, to, cycle, now);
    saveAccount(store, result.account);
    appendEvents(store, result.grants);
    return { effective: result.effective, summary: summarize(result.account, [...events, ...result.grants], now) };
  });
}

export async function updateAccount(store: CreditStore, fn: (a: CreditAccount) => CreditAccount, now = new Date()) {
  return withCreditLock(store, () => {
    const { account, events } = syncState(store, now);
    const next = fn(account);
    saveAccount(store, next);
    return summarize(next, events, now);
  });
}

export async function grantManual(store: CreditStore, credits: number, note: string, now = new Date()): Promise<GrantEvent> {
  if (!(Number.isInteger(credits) && credits > 0)) throw new Error("credits must be a positive whole number.");
  return withCreditLock(store, () => {
    syncState(store, now);
    const grant: GrantEvent = {
      kind: "grant",
      id: `manual:${randomUUID()}`,
      at: iso(now),
      source: "manual",
      credits,
      eurCents: 0,
      expiresAt: iso(addDays(now, TOPUP_VALID_DAYS)),
      note,
    };
    appendEvents(store, [grant]);
    return grant;
  });
}

export function creditStoreFor(appsRegistryPath: string): CreditStore {
  return { dir: process.env.DAY2_CREDITS_DIR ?? dirname(appsRegistryPath) };
}

export class CreditsError extends Error {
  constructor(public check: Exclude<CreditCheck, { ok: true }>) {
    super(check.reason);
  }
}

// ---------------------------------------------------------------------------
// Conversions for display — credits only ever leave the server
// ---------------------------------------------------------------------------

/** What a real cost will roughly show up as, for estimates and for showing
 * historical cost-level records (growth spend) in credits. */
export function creditsForCost(costUsd: number, service: CreditService, fx = usdToEurRate()): number {
  const v = Math.max(0, costUsd) * fx * MARKUP[service];
  return v <= 0 ? 0 : Math.ceil(v / CREDIT_LIST_VALUE_EUR - 1e-9);
}

/** Per-app growth budgets are stored in USD at credit list value (see the
 * per-app cap sync in api-server.ts) — these convert both ways. */
export function creditsForListUsd(usd: number, fx = usdToEurRate()): number {
  return Math.round((usd * fx) / CREDIT_LIST_VALUE_EUR);
}
export function listUsdForCredits(credits: number, fx = usdToEurRate()): number {
  return Math.round(((credits * CREDIT_LIST_VALUE_EUR) / fx) * 100) / 100;
}

export type AppCreditUsage = {
  caps: AppCreditCaps;
  usedThisMonth: number;
  usedToday: number;
  byService: Array<{ service: CreditService; name: string; credits: number; count: number }>;
  byDay: Array<{ date: string; credits: number }>;
};

export function appCreditUsage(account: CreditAccount, events: CreditEvent[], appId: string, now: Date, days = 8): AppCreditUsage {
  const m0 = monthStart(now).getTime();
  const m1 = addMonths(monthStart(now), 1).getTime();
  const mine = chargesOf(events).filter((c) => c.appId === appId);
  const bySvc = new Map<CreditService, { credits: number; count: number }>();
  for (const c of mine) {
    if (t(c.at) < m0 || t(c.at) >= m1) continue;
    const s = bySvc.get(c.service) ?? { credits: 0, count: 0 };
    bySvc.set(c.service, { credits: s.credits + c.credits, count: s.count + 1 });
  }
  const perDay = new Map<string, number>();
  for (const c of mine) perDay.set(c.at.slice(0, 10), (perDay.get(c.at.slice(0, 10)) ?? 0) + c.credits);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const byDay = Array.from({ length: days }, (_, i) => {
    const date = new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return { date, credits: perDay.get(date) ?? 0 };
  });
  const u = appUsage(events, appId, now);
  return {
    caps: account.appCaps[appId] ?? {},
    usedThisMonth: u.month,
    usedToday: u.day,
    byService: [...bySvc.entries()].map(([service, v]) => ({ service, name: serviceName(service), ...v })).sort((a, b) => b.credits - a.credits),
    byDay,
  };
}
