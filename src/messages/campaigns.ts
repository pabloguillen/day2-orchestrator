import { createHash } from "node:crypto";
import { evaluateProportionExperiment } from "../experiments";
import { seeded } from "../growth-bets";
import type { UserActivity } from "../field-store";
import type { RetentionSnapshot, Target } from "../retention";
import { arm, mayNudge, stateOf, WINDOWS, type Rhythm } from "../../packages/sensors/src/lifecycle";
import { localeFromZone, nextSendAt, type QuietHours, type Zone } from "./timing";
import {
  AUDIENCE_LABEL,
  type Audience,
  type Campaign,
  type CampaignResult,
  type Guardrail,
  type Locale,
  type MessagesSettings,
  type OptOut,
  type PushToken,
  type SendRecord,
} from "./types";

/**
 * Campaigns: who gets which message, when — and whether it works.
 *
 *  - Lifecycle campaigns follow retention.ts's states: new users who didn't
 *    come back (day 1 and day 3), at risk, lapsing, long gone (win-back).
 *    Each user gets a campaign at most once per time away.
 *  - Trigger campaigns follow an event the app reports for someone else
 *    (e.g. "a friend joined": props.to = day2's hash of the person to tell).
 *  - Announcements go once to everyone with push on.
 *
 * Every campaign has a holdout (10% by default, decided by the hashed id
 * with lifecycle.ts `arm`, the same everywhere). It is measured like a
 * retention treatment: users counted once when they enter the audience,
 * outcome = active in the next period, Bayesian proportion test, ≥ 30 per
 * arm. Its guardrail: recipients switching push off clearly more than the
 * held-out users who also have push — then day2 stops it.
 */

const DAY = 86_400_000;
export const MIN_PER_ARM = 30;
/** A push waits at most this long for a good local time, then it's skipped. */
export const QUEUE_HOURS = 30;
/** Opt-outs this soon after a send count against the campaign. */
export const OPTOUT_WINDOW_DAYS = 7;

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const dayTime = (d: string) => Date.parse(`${d}T12:00:00Z`);

/** Which lifecycle audience a user is in now (onboarding wins over at risk; see types.ts Audience). */
export function audienceOf(u: UserActivity, now: Date, rhythm: Rhythm): Audience | null {
  const today = dayOf(now.getTime());
  const days = [...u.days].sort();
  const last = days.at(-1) ?? u.lastSeen;
  if (u.firstSeen === dayOf(now.getTime() - DAY) && last === u.firstSeen) return "onboarding_d1";
  if (u.firstSeen === dayOf(now.getTime() - 3 * DAY) && last < dayOf(now.getTime() - DAY)) return "onboarding_d3";
  if (last >= today) return null;
  const s = stateOf(days.map(dayTime), now, rhythm, dayTime(u.firstSeen));
  if (s === "at_risk") return "at_risk";
  if (s === "lapsing") return "lapsing";
  if (s === "dormant" && now.getTime() - dayTime(last) < 400 * DAY) return "winback";
  return null;
}

export const deviceOf = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 12);
const sendId = (campaignId: string, user: string, at: string) => `ms_${createHash("sha256").update(`${campaignId}:${user}:${at}`).digest("hex").slice(0, 20)}`;

export type Reach = Map<string, PushToken[]>;
export function reachOf(tokens: PushToken[]): Reach {
  const m: Reach = new Map();
  for (const t of tokens) m.set(t.user, [...(m.get(t.user) ?? []), t]);
  return m;
}

/** The zone to plan in: the user's newest token, else the app's most common zone. */
export function zoneOf(tokens: PushToken[] | undefined, fallback: Zone): Zone {
  const t = [...(tokens ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return t && (t.tz || t.tzOffset !== null) ? { tz: t.tz, tzOffset: t.tzOffset } : fallback;
}

export function commonZone(tokens: PushToken[]): Zone {
  const n = new Map<string, number>();
  for (const t of tokens) if (t.tz) n.set(t.tz, (n.get(t.tz) ?? 0) + 1);
  const best = [...n.entries()].sort((a, b) => b[1] - a[1])[0];
  return { tz: best?.[0] ?? null, tzOffset: null };
}

export function localeOf(tokens: PushToken[] | undefined, c: Campaign): Locale {
  const t = [...(tokens ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const want = t?.locale ?? localeFromZone(t?.tz ?? null) ?? "en";
  if (c.texts[want]) return want;
  return c.texts.en ? "en" : ((Object.keys(c.texts)[0] as Locale | undefined) ?? "en");
}

/** Pushes actually handed to Expo for a user (for limits). */
const pushedAt = (records: SendRecord[]) => records.filter((r) => r.channel === "push" && (r.status === "sent" || r.status === "delivered") && r.sentAt).map((r) => r.sentAt!);

export type QueueInput = {
  campaign: Campaign;
  /** Users entering the campaign now, with when they were last active (null = unknown). */
  candidates: Array<{ user: string; lastActive: string | null }>;
  reach: Reach;
  /** All of this app's send records since a while (for limits and dedupe). */
  history: SendRecord[];
  settings: MessagesSettings;
  rhythm: Rhythm;
  now: Date;
  fallbackZone: Zone;
  usualHours?: Map<string, number>;
  /** Lifecycle and announcements: Duolingo's "stop when ignored" (mayNudge). Triggers skip it. */
  nudgeRule: boolean;
  /** A user gets this campaign again only after this many days (announcements: never). */
  againAfterDays: number | null;
};

/**
 * Pure. New send records (queued or held) for users entering a campaign.
 * The same filters apply to both arms before the holdout split, so the
 * comparison stays fair: push on, not already in this campaign since they
 * were last active, within the weekly limit, and (lifecycle) mayNudge.
 */
export function queueFor(i: QueueInput): SendRecord[] {
  const out: SendRecord[] = [];
  const at = i.now.toISOString();
  const byUser = new Map<string, SendRecord[]>();
  for (const r of i.history) byUser.set(r.user, [...(byUser.get(r.user) ?? []), r]);
  const weekAgo = new Date(i.now.getTime() - 7 * DAY).toISOString();
  for (const c of i.candidates) {
    const tokens = i.reach.get(c.user);
    if (!tokens?.length) continue;
    const mine = byUser.get(c.user) ?? [];
    const inThis = mine.filter((r) => r.campaignId === i.campaign.id);
    if (i.againAfterDays === null && inThis.length) continue;
    const lastActiveAt = c.lastActive ? Date.parse(`${c.lastActive.slice(0, 10)}T23:59:59Z`) : -Infinity;
    if (i.nudgeRule && inThis.some((r) => Date.parse(r.eligibleAt) > lastActiveAt)) continue;
    if (i.againAfterDays !== null && inThis.some((r) => Date.parse(r.eligibleAt) > i.now.getTime() - i.againAfterDays! * DAY)) continue;
    if (mine.some((r) => r.status === "queued")) continue;
    const pushed = pushedAt(mine);
    if (pushed.filter((t) => t >= weekAgo).length >= i.settings.maxPerWeek) continue;
    if (i.nudgeRule && !mayNudge({ sent: pushed, lastActive: c.lastActive ? `${c.lastActive.slice(0, 10)}T12:00:00Z` : null, now: i.now, rhythm: i.rhythm })) continue;
    const a = arm(c.user, i.campaign.id, i.campaign.holdout);
    const zone = zoneOf(tokens, i.fallbackZone);
    const due = a === "holdout" ? i.now : nextSendAt(i.now, zone, i.settings.quietHours, i.usualHours?.get(c.user) ?? null, `${i.campaign.id}:${c.user}`);
    out.push({
      id: sendId(i.campaign.id, c.user, at),
      campaignId: i.campaign.id,
      user: c.user,
      channel: "push",
      arm: a,
      status: a === "holdout" ? "held" : "queued",
      locale: localeOf(tokens, i.campaign),
      eligibleAt: at,
      dueAt: due.toISOString(),
      expiresAt: new Date(due.getTime() + QUEUE_HOURS * 3_600_000).toISOString(),
      sentAt: null,
      receipts: [],
      error: null,
      checkedAt: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const PERIOD_WORD: Record<Rhythm, string> = { daily: "the next day", weekly: "the next week", monthly: "the next month" };

/**
 * Pure. Intention to treat: every user who entered the campaign counts once
 * (their first entry), in their arm, whether or not the push reached them;
 * the outcome is being active within the next period after entering.
 */
export function measureCampaign(c: Campaign, records: SendRecord[], users: UserActivity[], rhythm: Rhythm, now: Date): CampaignResult {
  const P = WINDOWS[rhythm].period;
  const active = new Map(users.map((u) => [u.user, new Set(u.days)]));
  const first = new Map<string, SendRecord>();
  for (const r of [...records].filter((r) => r.campaignId === c.id).sort((a, b) => a.eligibleAt.localeCompare(b.eligibleAt))) if (!first.has(r.user)) first.set(r.user, r);
  const treated: boolean[] = [];
  const held: boolean[] = [];
  const today = dayOf(now.getTime());
  for (const r of first.values()) {
    const start = Date.parse(r.eligibleAt);
    const endDay = dayOf(start + P * DAY);
    if (endDay >= today) continue; // the period isn't over yet
    const days = active.get(r.user) ?? new Set<string>();
    let back = false;
    for (let d = 1; d <= P && !back; d++) back = days.has(dayOf(start + d * DAY));
    (r.arm === "holdout" ? held : treated).push(back);
  }
  const cmp = evaluateProportionExperiment(held, treated, seeded(c.id), { minNPerArm: MIN_PER_ARM });
  if (!cmp.sufficientPower) {
    const startedAt = Date.parse(c.approvedAt ?? c.createdAt);
    return now.getTime() - startedAt > 90 * DAY
      ? { state: "too_few", note: `Too few people to tell yet (${treated.length} reached, ${held.length} held out).`, treated: treated.length, held: held.length }
      : { state: "collecting", note: `${treated.length} reached and ${held.length} held out so far; a verdict needs ${MIN_PER_ARM} of each.`, treated: treated.length, held: held.length };
  }
  const tr = treated.filter(Boolean).length / treated.length;
  const hr = held.filter(Boolean).length / held.length;
  const p = cmp.posteriorProbabilityTreatmentBetter;
  const base = { treated: treated.length, held: held.length, treatedRate: tr, heldRate: hr, probabilityBetter: p };
  const note = `Back ${PERIOD_WORD[rhythm]}: ${pct(tr)} with the message, ${pct(hr)} without (held out).`;
  return { state: p >= 0.9 ? "better" : p <= 0.1 ? "worse" : "no_difference", ...base, note };
}

/**
 * Pure. Did recipients switch push off clearly more than held-out users who
 * also had push? Tripped when the posterior says so (≥ 95%) and the gap is
 * at least 2 points — or, before the holdout is big enough, when 1 in 10 of
 * at least 50 recipients switched off within a week.
 */
export function guardrailFor(c: Campaign, records: SendRecord[], optOuts: OptOut[], now: Date): Guardrail {
  const outs = new Map<string, number[]>();
  for (const o of optOuts) outs.set(o.user, [...(outs.get(o.user) ?? []), Date.parse(o.at)]);
  const optedOut = (user: string, from: number) => (outs.get(user) ?? []).some((t) => t >= from && t <= from + OPTOUT_WINDOW_DAYS * DAY);
  const mine = records.filter((r) => r.campaignId === c.id && r.channel === "push");
  const treated = mine.filter((r) => r.arm === "on" && r.sentAt && (r.status === "sent" || r.status === "delivered" || r.status === "failed")).map((r) => optedOut(r.user, Date.parse(r.sentAt!)));
  const held = mine.filter((r) => r.arm === "holdout").map((r) => optedOut(r.user, Date.parse(r.eligibleAt)));
  const tOut = treated.filter(Boolean).length;
  const hOut = held.filter(Boolean).length;
  const base = { recipients: treated.length, optedOut: tOut, heldWithPush: held.length, heldOptedOut: hOut };
  const cmp = evaluateProportionExperiment(held, treated, seeded(`${c.id}:optout`), { minNPerArm: MIN_PER_ARM });
  const tr = treated.length ? tOut / treated.length : 0;
  const hr = held.length ? hOut / held.length : 0;
  if (cmp.sufficientPower && cmp.posteriorProbabilityTreatmentBetter >= 0.95 && tr - hr >= 0.02) {
    return { ...base, tripped: true, note: `${pct(tr)} of recipients switched push off within a week, ${pct(hr)} of held-out users.` };
  }
  if (!cmp.sufficientPower && treated.length >= 50 && tr >= 0.1) {
    return { ...base, tripped: true, note: `${tOut} of ${treated.length} recipients (${pct(tr)}) switched push off within a week.` };
  }
  void now;
  return { ...base, tripped: false, note: treated.length ? `${pct(tr)} of recipients switched push off within a week${held.length ? `, ${pct(hr)} of held-out users` : ""}.` : "Nobody reached yet." };
}

// ---------------------------------------------------------------------------
// What to plan
// ---------------------------------------------------------------------------

const AUDIENCE_TARGET: Record<Audience, Target | null> = { onboarding_d1: "new", onboarding_d3: "new", at_risk: "at_risk", lapsing: "lapsing", winback: null };

export const AUDIENCE_GOAL: Record<Audience, string> = {
  onboarding_d1: "A new user tried the app yesterday for the first time and hasn't been back. Remind them of the one thing they can do in a minute that makes the app worth it.",
  onboarding_d3: "A new user started three days ago and hasn't been back since. Show the next small step from where they stopped, no pressure.",
  at_risk: "A regular user hasn't opened the app lately. A friendly nudge toward what they usually do in the app.",
  lapsing: "Someone used the app a while ago and has drifted away. One reason to look again: something useful they haven't tried, or what's new.",
  winback: "Someone hasn't used the app for a long time. A short, honest hello with what's new or what they'd get by opening it again; no guilt.",
};

/**
 * Pure. Which lifecycle campaigns are missing, the biggest retention leak
 * first. Only audiences that exist for this app's rhythm (onboarding
 * day 1/3 make sense for every rhythm; at risk and lapsing once the
 * snapshot has those users).
 */
export function missingAudiences(campaigns: Campaign[], snap: RetentionSnapshot | null): Audience[] {
  const have = new Set(campaigns.filter((c) => c.kind === "lifecycle" && c.status !== "stopped").map((c) => c.audience));
  const leak = snap?.leak ?? null;
  const order: Audience[] = ["onboarding_d1", "onboarding_d3", "at_risk", "lapsing", "winback"];
  const exists = (a: Audience) => {
    if (!snap || snap.status === "no_users") return false;
    if (a === "at_risk") return snap.states.at_risk > 0;
    if (a === "lapsing") return snap.states.lapsing > 0;
    if (a === "winback") return snap.states.dormant > 0;
    return true;
  };
  return order
    .filter((a) => !have.has(a) && exists(a))
    .sort((a, b) => Number(AUDIENCE_TARGET[b] === leak) - Number(AUDIENCE_TARGET[a] === leak));
}

/** Events the app may report that warrant telling someone (props.to = hashed recipient). */
export const TRIGGER_EVENTS: Record<string, string> = {
  friend_joined: "A friend you invited joined",
  invite_accepted: "Someone accepted your invite",
  friend_request: "Someone wants to be your friend",
  comment_received: "Someone commented on your post",
  reply_received: "Someone replied to you",
  reaction_received: "Someone reacted to what you shared",
  message_received: "You got a message",
  shared_with_you: "Something was shared with you",
  challenge_received: "Someone challenged you",
};

/** Pure. Trigger events the app reports (≥ 3 in the window, with a recipient) and has no campaign for. */
export function missingTriggers(campaigns: Campaign[], events: Array<{ type: string; props?: Record<string, unknown> }>): string[] {
  const have = new Set(campaigns.filter((c) => c.kind === "trigger" && c.status !== "stopped").map((c) => c.trigger?.event));
  const n = new Map<string, number>();
  for (const e of events) if (TRIGGER_EVENTS[e.type] && typeof e.props?.to === "string") n.set(e.type, (n.get(e.type) ?? 0) + 1);
  return [...n.entries()].filter(([t, k]) => k >= 3 && !have.has(t)).map(([t]) => t);
}

/** Lapsing and long-gone users with push off are better met in the app, when they come back. */
export function channelFor(audience: Audience, pushShare: number): Campaign["channel"] {
  return (audience === "lapsing" || audience === "winback") && pushShare < 0.4 ? "both" : "push";
}

export function audienceName(c: Campaign): string {
  if (c.kind === "lifecycle" && c.audience) return AUDIENCE_LABEL[c.audience];
  if (c.kind === "trigger" && c.trigger) return TRIGGER_EVENTS[c.trigger.event] ?? c.trigger.event;
  return "Everyone with push on";
}

export type { QuietHours };
