import { recordCampaign, workedLines } from "../learning/runtime";
import { normalizeTarget } from "../memory/core";
import { proposalContext } from "../memory/runtime";
import { randomUUID } from "node:crypto";
import type { AppEntry } from "../apps-registry";
import { createTicket, rankBacklog, withBacklog, type Backlog } from "../backlog";
import { backlogFile } from "../backlog-work";
import { CreditsError } from "../credits";
import { USER_DAY_DAYS, type FieldStore, type UserActivity } from "../field-store";
import { appKind } from "../field-work";
import type { AppProfile } from "../onboarding";
import type { Rhythm } from "../../packages/sensors/src/lifecycle";
import {
  AUDIENCE_GOAL,
  audienceOf,
  channelFor,
  commonZone,
  deviceOf,
  guardrailFor,
  measureCampaign,
  missingAudiences,
  missingTriggers,
  queueFor,
  reachOf,
  TRIGGER_EVENTS,
  zoneOf,
} from "./campaigns";
import { ExpoRequestError, getReceipts, ownerFix, sendPush, type ExpoMessage } from "./expo";
import { SETUP_KEY, setupTicket } from "./setup";
import type { MessagesStore } from "./store";
import { checkTexts, type Draft, type DraftInput, type TextCheck } from "./texts";
import { isQuiet, localTime, nextSendAt, usualHour } from "./timing";
import type { PushTokenStore } from "./tokens";
import { AUDIENCE_LABEL, USER_RE, type Audience, type Campaign, type Locale, type MessagesState, type PushToken, type SendRecord } from "./types";

/**
 * The Messages pass, called by the growth autopilot on the backlog timer
 * (every 15 minutes by default):
 *
 *  - every run: queue trigger messages from new events, queue approved
 *    announcements, send what's due (quiet hours, weekly limit, holdout),
 *    read Expo's receipts for pushes sent ≥ 15 minutes ago (they're gone
 *    after 24 hours);
 *  - every 6 hours: from the retention snapshot, queue lifecycle messages
 *    for users who entered an audience, and write the texts for missing
 *    campaigns (in the brand voice, de/en, checked);
 *  - daily: measure each campaign against its holdout, stop what hurts
 *    (fewer users back, or more people switching push off), count in-app
 *    views and push opens, and delete old tokens and records.
 *
 * In local mode nothing runs while the Mac sleeps: due pushes wait and go
 * out at the next good local time (or are skipped once they're 30 hours
 * late).
 */

export const PLAN_EVERY_MS = 6 * 3_600_000;
export const DAILY_EVERY_MS = 24 * 3_600_000;
export const RECEIPT_AFTER_MS = 15 * 60_000;
const RECEIPTS_GONE_MS = 23 * 3_600_000;
const NEW_DRAFTS_PER_PLAN = 2;
const DAY = 86_400_000;

export type WriteResult = { draft: Draft | null; review: TextCheck | null; credits: number };

export type MessagesDeps = {
  store: MessagesStore;
  tokens: PushTokenStore;
  field: FieldStore;
  expo: { fetch: (url: string, init: RequestInit) => Promise<Response>; accessToken: () => Promise<string | null>; sleep?: (ms: number) => Promise<void> };
  /** Writes and independently checks texts (agents, metered). */
  write: (input: DraftInput) => Promise<WriteResult>;
};

export type MessagesReport = { sent: number; held: number; queued: number; skipped: number; failed: number; created: string[]; stopped: string[]; ticketsCreated: string[]; notes: string[] };

type Log = (text: string, credits?: number) => void;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export async function messagesPass(app: AppEntry, profile: AppProfile | null, deps: MessagesDeps, log: Log, now: Date): Promise<MessagesReport> {
  const report: MessagesReport = { sent: 0, held: 0, queued: 0, skipped: 0, failed: 0, created: [], stopped: [], ticketsCreated: [], notes: [] };
  if (appKind(app.repoPath) !== "react-native") return report;
  let state = await deps.store.state(app.id);
  if (!state.settings.enabled) return report;
  // The page's activity list (newest first); kept apart so sub-steps can return their own state.
  const entries: MessagesState["log"] = [];
  const note = (text: string, credits?: number) => {
    entries.unshift({ at: now.toISOString(), text, ...(credits ? { credits } : {}) });
    log(text, credits);
  };

  // 0. The app's part (once the field library reports).
  state = await ensureSetupTicket(app, state, deps, report, note, now);

  const ran = { ...state.ran };
  const planDue = !ran.plan || now.getTime() - Date.parse(ran.plan) >= PLAN_EVERY_MS;
  const dailyDue = !ran.daily || now.getTime() - Date.parse(ran.daily) >= DAILY_EVERY_MS;
  const tokens = await deps.tokens.valid(app.id);
  const reach = reachOf(tokens);
  const fallbackZone = commonZone(tokens);
  const snapshot = await deps.field.retention(app.id);
  const rhythm: Rhythm = snapshot?.rhythm ?? "weekly";
  const history = await deps.store.sends(app.id, { since: new Date(now.getTime() - 120 * DAY) });
  const newRecords: SendRecord[] = [];
  const queue = (c: Campaign, candidates: Array<{ user: string; lastActive: string | null }>, opts: { nudgeRule: boolean; againAfterDays: number | null }, usual?: Map<string, number>) => {
    const recs = queueFor({ campaign: c, candidates, reach, history: [...history, ...newRecords], settings: state.settings, rhythm, now, fallbackZone, usualHours: usual, ...opts });
    newRecords.push(...recs);
    return recs;
  };

  let activity: { users: UserActivity[]; older: number } | null = null;
  const loadActivity = async () => (activity ??= await deps.field.activity(app.id, isoDay(now.getTime() - USER_DAY_DAYS * DAY)));

  // 1. Trigger messages: events since the last run that name someone to tell.
  const triggers = state.campaigns.filter((c) => c.kind === "trigger" && c.status === "active" && c.trigger);
  const since = new Date(Math.max(Date.parse(ran.triggersUntil ?? new Date(now.getTime() - 2 * 3_600_000).toISOString()), now.getTime() - 2 * 3_600_000));
  if (triggers.length) {
    const events = (await deps.field.events(app.id, since)) as Array<{ type: string; at: string; props?: Record<string, unknown> }>;
    for (const c of triggers) {
      const to = events.filter((e) => e.type === c.trigger!.event && e.at < now.toISOString()).map((e) => e.props?.to).filter((u): u is string => typeof u === "string" && USER_RE.test(u));
      queue(c, [...new Set(to)].map((user) => ({ user, lastActive: null })), { nudgeRule: false, againAfterDays: 1 });
    }
  }
  ran.triggersUntil = now.toISOString();

  // 2. Approved announcements: everyone with push on, once.
  for (const c of state.campaigns.filter((x) => x.kind === "announcement" && x.status === "active" && !x.queuedAt && (!x.sendAfter || x.sendAfter <= now.toISOString()))) {
    const act = await loadActivity();
    const last = new Map(act.users.map((u) => [u.user, u.lastSeen]));
    const recs = queue(c, [...reach.keys()].map((user) => ({ user, lastActive: last.get(user) ?? null })), { nudgeRule: true, againAfterDays: null });
    state = withCampaign(state, c.id, { queuedAt: now.toISOString() }, now);
    note(`"${c.name}" goes to ${recs.filter((r) => r.status === "queued").length} people at their next good local time (${recs.filter((r) => r.status === "held").length} held out to measure it).`);
  }

  // 3. Every 6 hours: texts for missing campaigns (a few at a time), then
  // lifecycle messages for users who entered an audience.
  if (planDue) {
    state = await planCampaigns(app, profile, state, deps, snapshot, reach, report, note, now, loadActivity);
    ran.plan = now.toISOString();
    const act = await loadActivity();
    const lifecycle = state.campaigns.filter((c) => c.kind === "lifecycle" && c.status === "active" && c.audience);
    if (lifecycle.length && reach.size) {
      const events = (await deps.field.events(app.id, new Date(now.getTime() - 30 * DAY))) as Array<{ at: string; userId?: string }>;
      const times = new Map<string, string[]>();
      for (const e of events) if (e.userId && reach.has(e.userId)) times.set(e.userId, [...(times.get(e.userId) ?? []), e.at]);
      const usual = new Map<string, number>();
      for (const [u, t] of times) {
        const h = usualHour(t, zoneOf(reach.get(u), fallbackZone), state.settings.quietHours);
        if (h !== null) usual.set(u, h);
      }
      const byAudience = new Map<Audience, Array<{ user: string; lastActive: string | null }>>();
      for (const u of act.users) {
        if (!reach.has(u.user)) continue;
        const a = audienceOf(u, now, rhythm);
        if (a) byAudience.set(a, [...(byAudience.get(a) ?? []), { user: u.user, lastActive: u.days.at(-1) ?? u.lastSeen }]);
      }
      for (const c of lifecycle) {
        const recs = queue(c, byAudience.get(c.audience!) ?? [], { nudgeRule: true, againAfterDays: 0 }, usual);
        if (recs.length) note(`${AUDIENCE_LABEL[c.audience!]}: ${recs.filter((r) => r.status === "queued").length} get "${c.name}" at their usual time or after quiet hours, ${recs.filter((r) => r.status === "held").length} held out.`);
      }
    }
  }
  await deps.store.addSends(app.id, newRecords);
  report.queued += newRecords.filter((r) => r.status === "queued").length;
  report.held += newRecords.filter((r) => r.status === "held").length;

  // 4. Send what's due, then read receipts.
  state = await sendDue(app, state, deps, report, note, now);
  state = await readReceipts(app, state, deps, now);

  // 5. Measure, guard, clean up (daily).
  if (dailyDue) {
    state = await measureAll(app, state, deps, rhythm, report, note, now, loadActivity);
    const pruned = await deps.tokens.prune(now);
    await deps.store.prune(now);
    if (pruned.tokens) report.notes.push(`deleted ${pruned.tokens} old or invalid push tokens`);
    ran.daily = now.toISOString();
  }
  ran.due = now.toISOString();
  state = { ...state, ran, log: [...entries, ...state.log] };
  await deps.store.setState(app.id, state, now);
  return report;
}

function withCampaign(state: MessagesState, id: string, patch: Partial<Campaign>, now: Date): MessagesState {
  return { ...state, campaigns: state.campaigns.map((c) => (c.id === id ? { ...c, ...patch, updatedAt: now.toISOString() } : c)) };
}

async function ensureSetupTicket(app: AppEntry, state: MessagesState, deps: MessagesDeps, report: MessagesReport, note: Log, now: Date): Promise<MessagesState> {
  if (state.setupTicketId) return state;
  if (!(await deps.field.meta(app.id))) return state;
  const t = await withBacklog(backlogFile(app), (b: Backlog) => {
    const have = b.tickets.find((x) => x.source.key === SETUP_KEY);
    if (have) return { backlog: b, result: { ticket: have, created: false } };
    const r = createTicket(b, setupTicket(), now);
    return { backlog: rankBacklog(r.backlog, now).backlog, result: { ticket: r.ticket, created: true } };
  });
  if (t.created) {
    report.ticketsCreated.push(t.ticket.id);
    note(`Added ${t.ticket.id} so the app can get push notifications and in-app messages: permission after the first success, the push token, taps that open the right screen, and an in-app message in the app's style.`);
  }
  return { ...state, setupTicketId: t.ticket.id };
}

function textFor(c: Campaign, locale: Locale | null) {
  return (locale && c.texts[locale]) || c.texts.en || Object.values(c.texts)[0] || null;
}

async function sendDue(app: AppEntry, state0: MessagesState, deps: MessagesDeps, report: MessagesReport, note: Log, now: Date): Promise<MessagesState> {
  let state = state0;
  const at = now.toISOString();
  const queued = (await deps.store.sends(app.id, { status: ["queued"], since: new Date(now.getTime() - 3 * DAY) })).filter((r) => r.dueAt <= at);
  if (!queued.length) return state;
  const recent = await deps.store.sends(app.id, { since: new Date(now.getTime() - 8 * DAY), status: ["sent", "delivered"] });
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
  const sentThisWeek = new Map<string, number>();
  for (const r of recent) if (r.sentAt && r.sentAt >= weekAgo) sentThisWeek.set(r.user, (sentThisWeek.get(r.user) ?? 0) + 1);
  const tokens = await deps.tokens.valid(app.id, [...new Set(queued.map((r) => r.user))]);
  const byUser = new Map<string, PushToken[]>();
  for (const t of tokens) byUser.set(t.user, [...(byUser.get(t.user) ?? []), t]);
  const fallback = commonZone(tokens);
  const patches: Array<Pick<SendRecord, "id"> & Partial<SendRecord>> = [];
  const outgoing: Array<{ record: SendRecord; token: PushToken; message: ExpoMessage }> = [];
  for (const r of queued) {
    const c = state.campaigns.find((x) => x.id === r.campaignId);
    const skip = (why: string) => {
      patches.push({ id: r.id, status: "skipped", error: why });
      report.skipped++;
    };
    if (!c || c.status !== "active") {
      skip("campaign not active");
      continue;
    }
    if (r.expiresAt < at) {
      skip("no good time before it was too late");
      continue;
    }
    const mine = byUser.get(r.user) ?? [];
    if (!mine.length) {
      skip("push is off");
      continue;
    }
    const zone = zoneOf(mine, fallback);
    if (isQuiet(localTime(now, zone).hour, state.settings.quietHours)) {
      const next = nextSendAt(now, zone, state.settings.quietHours, null, `${r.campaignId}:${r.user}`);
      if (next.toISOString() <= r.expiresAt) patches.push({ id: r.id, dueAt: next.toISOString() });
      else skip("only quiet hours left before it was too late");
      continue;
    }
    if ((sentThisWeek.get(r.user) ?? 0) >= state.settings.maxPerWeek) {
      skip("weekly limit reached");
      continue;
    }
    const text = textFor(c, r.locale);
    if (!text) {
      skip("no text");
      continue;
    }
    sentThisWeek.set(r.user, (sentThisWeek.get(r.user) ?? 0) + 1);
    const ttl = Math.max(60, Math.round((Date.parse(r.expiresAt) - now.getTime()) / 1000));
    for (const t of mine) {
      outgoing.push({
        record: r,
        token: t,
        message: { to: t.token, title: text.title, body: text.body, data: { day2: { c: c.id, r: c.route ?? null } }, sound: "default", priority: "default", ttl, ...(t.platform === "android" ? { channelId: "default" } : {}) },
      });
    }
  }
  if (outgoing.length) {
    const accessToken = await deps.expo.accessToken();
    try {
      const tickets = await sendPush(
        outgoing.map((o) => o.message),
        { fetch: deps.expo.fetch, accessToken, ...(deps.expo.sleep ? { sleep: deps.expo.sleep } : {}) },
      );
      const per = new Map<string, { record: SendRecord; ok: Array<{ id: string; device: string }>; errors: string[]; rate: boolean }>();
      for (let i = 0; i < outgoing.length; i++) {
        const o = outgoing[i]!;
        const tk = tickets[i]!;
        const p = per.get(o.record.id) ?? { record: o.record, ok: [], errors: [], rate: false };
        if (tk.status === "ok") p.ok.push({ id: tk.id, device: deviceOf(o.token.token) });
        else {
          p.errors.push(tk.error ?? tk.message);
          if (tk.error === "DeviceNotRegistered") await deps.tokens.invalidate(app.id, o.token.token, "not_registered", now);
          if (tk.error === "MessageRateExceeded") p.rate = true;
          const fix = ownerFix(tk.error, o.token.platform);
          if (fix && state.problem?.text !== fix) {
            state = { ...state, problem: { at, text: fix } };
            note(`A push couldn't be delivered: ${fix}`);
          }
        }
        per.set(o.record.id, p);
      }
      for (const p of per.values()) {
        if (p.ok.length) {
          patches.push({ id: p.record.id, status: "sent", sentAt: at, receipts: p.ok, error: null });
          report.sent++;
        } else if (p.rate) {
          patches.push({ id: p.record.id, dueAt: new Date(now.getTime() + 3_600_000).toISOString(), error: "MessageRateExceeded" });
        } else {
          patches.push({ id: p.record.id, status: "failed", sentAt: at, error: p.errors.join(", ").slice(0, 200) });
          report.failed++;
        }
      }
      if (state.problem && tickets.every((t) => t.status === "ok")) state = { ...state, problem: null };
    } catch (err) {
      if (err instanceof ExpoRequestError) {
        const fix = ownerFix(err.code, null);
        if (fix) {
          state = { ...state, problem: { at, text: fix } };
          note(`Pushes are waiting: ${fix}`);
        } else report.notes.push(`Expo: ${err.message}`);
        // Leave them queued: they go at the next run.
        await deps.store.updateSends(app.id, patches);
        return state;
      }
      throw err;
    }
  }
  await deps.store.updateSends(app.id, patches);
  if (report.sent) note(`Sent ${report.sent} push notification${report.sent === 1 ? "" : "s"}${report.skipped ? `; ${report.skipped} skipped (limits, quiet hours ran out, or push off)` : ""}.`);
  return state;
}

async function readReceipts(app: AppEntry, state: MessagesState, deps: MessagesDeps, now: Date): Promise<MessagesState> {
  const sent = (await deps.store.sends(app.id, { status: ["sent"], since: new Date(now.getTime() - 3 * DAY) })).filter((r) => !r.checkedAt && r.sentAt && Date.parse(r.sentAt) <= now.getTime() - RECEIPT_AFTER_MS);
  if (!sent.length) return state;
  const at = now.toISOString();
  const fresh = sent.filter((r) => Date.parse(r.sentAt!) > now.getTime() - RECEIPTS_GONE_MS);
  const ids = fresh.flatMap((r) => r.receipts.map((x) => x.id));
  let receipts: Awaited<ReturnType<typeof getReceipts>> = {};
  if (ids.length) {
    try {
      receipts = await getReceipts(ids, { fetch: deps.expo.fetch, accessToken: await deps.expo.accessToken(), ...(deps.expo.sleep ? { sleep: deps.expo.sleep } : {}) });
    } catch {
      return state; // next run
    }
  }
  const patches: Array<Pick<SendRecord, "id"> & Partial<SendRecord>> = [];
  let next = state;
  for (const r of sent) {
    if (Date.parse(r.sentAt!) <= now.getTime() - RECEIPTS_GONE_MS) {
      patches.push({ id: r.id, checkedAt: at });
      continue;
    }
    const got = r.receipts.map((x) => ({ ...x, receipt: receipts[x.id] }));
    if (got.some((g) => !g.receipt)) continue; // not ready yet
    const errors = got.filter((g) => g.receipt!.status === "error");
    for (const g of errors) {
      const e = g.receipt as { status: "error"; error: string | null; message: string };
      if (e.error === "DeviceNotRegistered") {
        const t = (await deps.tokens.valid(app.id, [r.user])).find((x) => deviceOf(x.token) === g.device);
        if (t) await deps.tokens.invalidate(app.id, t.token, "not_registered", now);
      }
      const fix = ownerFix(e.error, null);
      if (fix) next = { ...next, problem: { at, text: fix } };
    }
    const delivered = errors.length < got.length;
    patches.push({ id: r.id, checkedAt: at, status: delivered ? "delivered" : "failed", error: errors.length ? errors.map((g) => (g.receipt as { error: string | null }).error ?? "error").join(", ") : null });
  }
  await deps.store.updateSends(app.id, patches);
  return next;
}

async function planCampaigns(
  app: AppEntry,
  profile: AppProfile | null,
  state0: MessagesState,
  deps: MessagesDeps,
  snapshot: Awaited<ReturnType<FieldStore["retention"]>>,
  reach: Map<string, PushToken[]>,
  report: MessagesReport,
  note: Log,
  now: Date,
  loadActivity: () => Promise<{ users: UserActivity[]; older: number }>,
): Promise<MessagesState> {
  let state = state0;
  if (!profile) return state;
  const act = await loadActivity();
  const recent = act.users.filter((u) => u.lastSeen >= isoDay(now.getTime() - 90 * DAY));
  const pushShare = recent.length ? recent.filter((u) => reach.has(u.user)).length / recent.length : 0;
  // Before anyone has push on (the setup ticket isn't live yet), there's nobody to write for.
  if (!reach.size) return state;
  const locales = localesFor(reach);
  // What day2 knows (owner's voice, things not to send), and the campaigns the owner turned down.
  const known = await proposalContext(app, "messages", ["messages.campaign"], { now });
  if (known.blocked.blocked) return state;
  const avoid = new Set(known.avoid);
  const worked = await workedLines(app, "messages");
  type Need = { kind: "lifecycle"; audience: Audience } | { kind: "trigger"; event: string };
  const needs: Need[] = [
    ...missingAudiences(state.campaigns, snapshot).map((a) => ({ kind: "lifecycle" as const, audience: a })),
    ...missingTriggers(state.campaigns, (await deps.field.events(app.id, new Date(now.getTime() - 30 * DAY))) as Array<{ type: string; props?: Record<string, unknown> }>).map((e) => ({ kind: "trigger" as const, event: e })),
  ]
    .filter((n) => !avoid.has(`messages.campaign:${normalizeTarget(campaignTarget(n.kind === "lifecycle" ? { kind: "lifecycle", audience: n.audience } : { kind: "trigger", trigger: { event: n.event } }))}`))
    .slice(0, NEW_DRAFTS_PER_PLAN);
  for (const need of needs) {
    const goal = need.kind === "lifecycle" ? AUDIENCE_GOAL[need.audience] : `Tell the user right away: ${TRIGGER_EVENTS[need.event]!.toLowerCase()}. Plain and specific; the tap opens where they can see it.`;
    let w: WriteResult;
    try {
      w = await deps.write({ ...draftInput(app, profile, locales, goal), ...(known.memory ? { memory: known.memory } : {}), ...(worked.length ? { worked } : {}) });
    } catch (err) {
      const why = err instanceof CreditsError ? err.message : (err as Error).message;
      report.notes.push(`message texts: ${why}`);
      note(`Couldn't write message texts: ${why}`);
      break;
    }
    if (!w.draft) {
      note("Couldn't write message texts this time — nothing is sent rather than something generic.", w.credits);
      continue;
    }
    const campaign = newCampaign({
      kind: need.kind,
      name: need.kind === "lifecycle" ? AUDIENCE_LABEL[need.audience] : TRIGGER_EVENTS[need.event]!,
      ...(need.kind === "lifecycle" ? { audience: need.audience } : { trigger: { event: need.event } }),
      channel: need.kind === "lifecycle" ? channelFor(need.audience, pushShare) : "push",
      draft: w.draft,
      review: w.review,
      locales,
      brand: profile.brand ?? null,
      grounding: grounding(profile),
      settings: state.settings,
      by: "day2",
      credits: w.credits,
      now,
      autonomy: state.settings.autonomy.lifecycle,
    });
    state = { ...state, campaigns: [campaign, ...state.campaigns] };
    report.created.push(campaign.id);
    const what = campaign.status === "active" ? "starts now" : campaign.status === "waiting" ? "waits for your OK" : `wasn't started: ${campaign.checks.issues.slice(0, 2).join(" ")}`;
    note(`Wrote "${campaign.name}" (${Object.keys(campaign.texts).join(", ")}) — ${what}. ${Math.round(campaign.holdout * 100)}% are held out to measure it.`, w.credits);
  }
  return state;
}

export function localesFor(reach: Map<string, PushToken[]>): Locale[] {
  const seen = new Set<Locale>();
  for (const ts of reach.values()) for (const t of ts) if (t.locale) seen.add(t.locale);
  // Dotty-style default: German and English unless the app says otherwise.
  return seen.size ? (["de", "en"] as Locale[]).filter((l) => seen.has(l) || l === "en") : ["de", "en"];
}

export function grounding(profile: AppProfile): string {
  return [profile.purpose, profile.targetUsers, ...profile.featureMap, profile.businessModel ?? ""].join(" ");
}

/** A campaign's hard-filter target: what it's for ("lifecycle:at_risk", "trigger:friend_joined"). */
export function campaignTarget(c: { kind: string; audience?: string; trigger?: { event: string }; id?: string }): string {
  if (c.kind === "lifecycle" && c.audience) return `lifecycle:${c.audience}`;
  if (c.kind === "trigger" && c.trigger) return `trigger:${c.trigger.event}`;
  return `${c.kind}:${c.id ?? ""}`;
}

export function draftInput(app: AppEntry, profile: AppProfile, locales: Locale[], goal: string, ownerNote?: string | null): DraftInput {
  return {
    appName: app.name,
    purpose: profile.purpose,
    targetUsers: profile.targetUsers,
    features: profile.featureMap,
    toneOfVoice: profile.toneOfVoice,
    brand: profile.brand ?? null,
    locales,
    goal,
    ownerNote: ownerNote ?? null,
  };
}

/** Pure. A campaign from checked texts; its status follows the autonomy setting. */
export function newCampaign(i: {
  kind: Campaign["kind"];
  name: string;
  audience?: Audience;
  trigger?: { event: string };
  channel: Campaign["channel"];
  draft: Draft;
  review: TextCheck | null;
  locales: Locale[];
  brand: AppProfile["brand"] | null;
  grounding: string;
  settings: MessagesState["settings"];
  by: Campaign["by"];
  credits?: number;
  now: Date;
  autonomy: "auto" | "ask";
  sendAfter?: string | null;
}): Campaign {
  const rules = checkTexts(i.draft.texts, { locales: i.locales, brand: i.brand ?? null, grounding: i.grounding });
  const issues = [...rules.issues, ...(i.review && !i.review.ok ? i.review.issues.length ? i.review.issues : ["The independent check didn't pass them."] : [])];
  const ok = issues.length === 0;
  const at = i.now.toISOString();
  const slug = (i.audience ?? i.trigger?.event ?? "news").replace(/_/g, "-");
  return {
    id: `msg-${slug}-${randomUUID().slice(0, 6)}`,
    kind: i.kind,
    name: i.name.slice(0, 80),
    ...(i.audience ? { audience: i.audience } : {}),
    ...(i.trigger ? { trigger: i.trigger } : {}),
    channel: i.channel,
    ...(i.channel !== "push" ? { inApp: { trigger: i.kind === "announcement" ? "app_open" : "comeback", cap: { total: 1, perDay: 1 } } } : {}),
    texts: i.draft.texts,
    ...(i.draft.route ? { route: i.draft.route } : {}),
    status: !ok ? "draft" : i.autonomy === "auto" ? "active" : "waiting",
    holdout: i.settings.holdout,
    by: i.by,
    createdAt: at,
    updatedAt: at,
    approvedAt: ok && i.autonomy === "auto" ? at : null,
    approvedBy: ok && i.autonomy === "auto" ? "day2" : null,
    sendAfter: i.sendAfter ?? null,
    checks: { ok, issues },
    result: { state: "collecting", note: "Not started yet.", treated: 0, held: 0 },
    guardrail: null,
    ...(i.credits ? { credits: i.credits } : {}),
  };
}

async function measureAll(
  app: AppEntry,
  state0: MessagesState,
  deps: MessagesDeps,
  rhythm: Rhythm,
  report: MessagesReport,
  note: Log,
  now: Date,
  loadActivity: () => Promise<{ users: UserActivity[]; older: number }>,
): Promise<MessagesState> {
  let state = state0;
  const live = state.campaigns.filter((c) => c.status === "active" || c.status === "done" || c.status === "paused");
  if (!live.length) return state;
  const act = await loadActivity();
  const records = await deps.store.sends(app.id, { since: new Date(now.getTime() - 200 * DAY) });
  const optOuts = await deps.tokens.optOuts(app.id, new Date(now.getTime() - 200 * DAY));
  const events = (await deps.field.events(app.id, new Date(now.getTime() - 90 * DAY))) as Array<{ type: string; props?: Record<string, unknown> }>;
  const propId = (e: { props?: Record<string, unknown> }) => (typeof e.props?.id === "string" ? e.props.id : typeof e.props?.campaign === "string" ? e.props.campaign : typeof e.props?.message === "string" ? e.props.message : null);
  for (const c of live) {
    const result = measureCampaign(c, records, act.users, rhythm, now);
    const guardrail = guardrailFor(c, records, optOuts, now);
    const mine = events.filter((e) => propId(e) === c.id);
    const inAppStats = c.channel === "push" ? null : { shown: mine.filter((e) => e.type === "message_shown").length, tapped: mine.filter((e) => e.type === "message_tapped").length, dismissed: mine.filter((e) => e.type === "message_dismissed").length };
    // Push taps are reported as message_tapped with the campaign id (setup ticket); push_opened carries no id.
    const opened = mine.filter((e) => e.type === "push_opened" || (c.channel === "push" && e.type === "message_tapped")).length;
    const decided = c.result.state !== result.state && (result.state === "better" || result.state === "worse" || result.state === "no_difference");
    // Measured against its holdout: into the shared library of anonymous outcomes.
    if (decided && "treatedRate" in result) await recordCampaign(app, c, result);
    let patch: Partial<Campaign> = { result, guardrail, inAppStats, opened };
    if (c.status === "active" && guardrail.tripped) {
      patch = { ...patch, status: "stopped", stoppedReason: `More people switched push off: ${guardrail.note}` };
      report.stopped.push(c.id);
      note(`Stopped "${c.name}": ${guardrail.note} Turning notifications off is hard to undo, so day2 stops a message that causes it.`);
    } else if (c.status === "active" && result.state === "worse") {
      patch = { ...patch, status: "stopped", stoppedReason: `Fewer people came back with it. ${result.note}` };
      report.stopped.push(c.id);
      note(`Stopped "${c.name}": ${result.note}`);
    } else if (decided) note(`Measured "${c.name}" against its holdout: ${result.note}`);
    if (c.kind === "announcement" && c.status === "active" && c.queuedAt && !records.some((r) => r.campaignId === c.id && r.status === "queued")) patch = { ...patch, status: "done" };
    state = withCampaign(state, c.id, patch, now);
  }
  return state;
}
