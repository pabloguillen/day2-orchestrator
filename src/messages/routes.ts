import type { AppEntry } from "../apps-registry";
import { loadBacklog } from "../backlog";
import { backlogFile } from "../backlog-work";
import type { CreditService } from "../credits";
import { USER_DAY_DAYS, type FieldStore } from "../field-store";
import { APP_PROFILE_FILENAME, loadAppProfile, type AppProfile } from "../onboarding";
import { fieldStore, type Tenant } from "../tenant";
import { messagesStore, pushTokens } from "./runtime";
import { resolve } from "node:path";
import { audienceName } from "./campaigns";
import { draftInput, grounding, localesFor, newCampaign } from "./pass";
import { hasNotifications, registerMessagesNativeNeed } from "./setup";
import type { MessagesStore } from "./store";
import { checkTexts, draftTexts, reviewTexts, type Draft } from "./texts";
import type { PushTokenStore } from "./tokens";
import { BODY_MAX, CTA_MAX, LOCALES, TITLE_MAX, type Campaign, type Locale, type MessagesSettings, type MessagesState, type SendRecord, type Text } from "./types";

/**
 * /api/apps/:id/messages/* — the Messages page.
 *
 *   GET    /api/apps/:id/messages                         who's reachable, campaigns, results, settings
 *   PUT    /api/apps/:id/messages/settings                quiet hours, max per week, autonomy, on/off
 *   POST   /api/apps/:id/messages/announcements           { texts } written by the owner (starts at once),
 *                                                         or { about } for day2 to write (waits for OK by default)
 *   PUT    /api/apps/:id/messages/campaigns/:cid/texts    the owner edits texts (checked again)
 *   POST   /api/apps/:id/messages/campaigns/:cid/:action  approve | pause | resume | stop
 *
 * Registered with one line in api-server.ts. Never returns push tokens.
 */

export type RouteHelpers = {
  requireApp(t: Tenant, id: string): Promise<AppEntry>;
  fail(status: number, message: string): Error;
  runWithCredits<T>(t: Tenant, app: AppEntry, service: CreditService, description: string, maxCostUsd: number, fn: () => Promise<T>): Promise<{ result: T; credits: number }>;
  actorName(t: Tenant): Promise<string | undefined>;
  stores?: () => { store: MessagesStore; tokens: PushTokenStore; field: FieldStore };
};

type Handler = (req: Request, params: Record<string, string>, t: Tenant) => Promise<Response>;
export type MessagesRoute = { method: string; path: string; handler: Handler };

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const DRAFT_MAX_USD = 1;
const DAY = 86_400_000;

export type CampaignView = Omit<Campaign, "credits"> & {
  audienceLabel: string;
  counts: Record<"queued" | "held" | "sent" | "delivered" | "failed" | "skipped", number>;
  nextDueAt: string | null;
  lastSentAt: string | null;
  credits: number;
};

export type MessagesView = {
  settings: MessagesSettings;
  reach: { push: number; ios: number; android: number; inAppOnly: number; identified: number };
  setup: { ticketId: string; state: string } | null;
  nativeReady: boolean;
  problem: MessagesState["problem"];
  campaigns: CampaignView[];
  log: MessagesState["log"];
  limits: { title: number; body: number; cta: number };
};

/** Pure. What the page shows. */
export function messagesView(state: MessagesState, sends: SendRecord[], reach: MessagesView["reach"], setup: MessagesView["setup"], nativeReady: boolean): MessagesView {
  return {
    settings: state.settings,
    reach,
    setup,
    nativeReady,
    problem: state.problem ?? null,
    campaigns: state.campaigns.map((c) => {
      const mine = sends.filter((s) => s.campaignId === c.id);
      const n = (st: SendRecord["status"]) => mine.filter((s) => s.status === st).length;
      const due = mine.filter((s) => s.status === "queued").map((s) => s.dueAt).sort()[0] ?? null;
      const last = mine.map((s) => s.sentAt).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
      const { credits, ...rest } = c;
      return { ...rest, audienceLabel: audienceName(c), counts: { queued: n("queued"), held: n("held"), sent: n("sent"), delivered: n("delivered"), failed: n("failed"), skipped: n("skipped") }, nextDueAt: due, lastSentAt: last, credits: credits ?? 0 };
    }),
    log: state.log.slice(0, 30),
    limits: { title: TITLE_MAX, body: BODY_MAX, cta: CTA_MAX },
  };
}

/** Pure. Settings from a request body, within sane bounds; throws a plain message. */
export function patchSettings(cur: MessagesSettings, body: Record<string, unknown>): MessagesSettings {
  const next: MessagesSettings = { ...cur, quietHours: { ...cur.quietHours }, autonomy: { ...cur.autonomy } };
  const hour = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23 ? v : null);
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new Error("enabled must be true or false.");
    next.enabled = body.enabled;
  }
  if (body.quietHours !== undefined) {
    const q = body.quietHours as { start?: unknown; end?: unknown };
    const start = hour(q?.start);
    const end = hour(q?.end);
    if (start === null || end === null) throw new Error("Quiet hours are whole hours from 0 to 23.");
    const quiet = start > end ? 24 - start + end : end - start;
    if (quiet < 8) throw new Error("Quiet hours must cover at least 8 hours of the night.");
    next.quietHours = { start, end };
  }
  if (body.maxPerWeek !== undefined) {
    const m = body.maxPerWeek;
    if (typeof m !== "number" || !Number.isInteger(m) || m < 1 || m > 7) throw new Error("At most 1 to 7 messages per person per week.");
    next.maxPerWeek = m;
  }
  if (body.autonomy !== undefined) {
    const a = body.autonomy as { lifecycle?: unknown; announcements?: unknown };
    for (const k of ["lifecycle", "announcements"] as const) {
      if (a?.[k] === undefined) continue;
      if (a[k] !== "auto" && a[k] !== "ask") throw new Error(`autonomy.${k} is "auto" or "ask".`);
      next.autonomy[k] = a[k];
    }
  }
  return next;
}

/** Pure. Texts the owner typed (trimmed; length is checked by checkTexts). */
export function textsFrom(raw: unknown): Partial<Record<Locale, Text>> {
  const out: Partial<Record<Locale, Text>> = {};
  const o = (raw ?? {}) as Record<string, { title?: unknown; body?: unknown; cta?: unknown }>;
  for (const l of LOCALES) {
    const t = o[l];
    if (!t) continue;
    const title = typeof t.title === "string" ? t.title.trim() : "";
    const body = typeof t.body === "string" ? t.body.trim() : "";
    const cta = typeof t.cta === "string" ? t.cta.trim() : "";
    if (title && body) out[l] = { title, body, ...(cta ? { cta } : {}) };
  }
  return out;
}

const ROUTE_RE = /^\/[A-Za-z0-9_\-/()[\].]{0,120}$/;

export function messagesRoutes(h: RouteHelpers): MessagesRoute[] {
  registerMessagesNativeNeed(async (app) => (await stores().store.state(app.id)).settings.enabled);
  function stores() {
    return h.stores ? h.stores() : { store: messagesStore(), tokens: pushTokens(), field: fieldStore() };
  }
  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const profileOf = (app: AppEntry): AppProfile | null => loadAppProfile(resolve(app.repoPath, APP_PROFILE_FILENAME));

  async function view(app: AppEntry, now = new Date()): Promise<MessagesView> {
    const { store, tokens, field } = stores();
    const state = await store.state(app.id);
    const sends = await store.sends(app.id, { since: new Date(now.getTime() - 120 * DAY) });
    const counts = await tokens.counts(app.id);
    const act = await field.activity(app.id, new Date(now.getTime() - Math.min(90, USER_DAY_DAYS) * DAY).toISOString().slice(0, 10));
    const withPush = new Set((await tokens.valid(app.id)).map((t) => t.user));
    const identified = act.users.length;
    const inAppOnly = act.users.filter((u) => !withPush.has(u.user)).length;
    const ticket = state.setupTicketId ? loadBacklog(backlogFile(app)).tickets.find((t) => t.id === state.setupTicketId) : null;
    return messagesView(state, sends, { push: counts.users, ios: counts.ios, android: counts.android, inAppOnly, identified }, ticket ? { ticketId: ticket.id, state: ticket.state } : null, hasNotifications(app.repoPath));
  }

  async function update(app: AppEntry, fn: (s: MessagesState) => MessagesState) {
    const { store } = stores();
    const now = new Date();
    await store.setState(app.id, fn(await store.state(app.id)), now);
  }

  const campaignAction = (action: string, c: Campaign, by: string | null, now: Date): Partial<Campaign> => {
    const at = now.toISOString();
    if (action === "approve") {
      if (c.status !== "waiting" && c.status !== "draft") throw h.fail(409, "Only a campaign waiting for your OK can be approved.");
      if (!c.checks.ok && c.by === "day2") throw h.fail(409, `Its texts didn't pass the checks: ${c.checks.issues.join(" ")} Edit them first.`);
      return { status: "active", approvedAt: at, approvedBy: by };
    }
    if (action === "pause") {
      if (c.status !== "active") throw h.fail(409, "Only a running campaign can be paused.");
      return { status: "paused" };
    }
    if (action === "resume") {
      if (c.status !== "paused") throw h.fail(409, "Only a paused campaign can be resumed.");
      return { status: "active" };
    }
    if (action === "stop") {
      if (c.status === "stopped" || c.status === "done") throw h.fail(409, "It isn't running.");
      return { status: "stopped", stoppedReason: by ? `Stopped by ${by}.` : "Stopped by the owner." };
    }
    throw h.fail(404, `Unknown action "${action}".`);
  };

  return [
    {
      method: "GET",
      path: "/api/apps/:id/messages",
      handler: async (_req, p, t) => json(await view(await h.requireApp(t, p.id!))),
    },
    {
      method: "PUT",
      path: "/api/apps/:id/messages/settings",
      handler: async (req, p, t) => {
        const app = await h.requireApp(t, p.id!);
        const b = await body(req);
        const { store } = stores();
        const cur = await store.state(app.id);
        let settings: MessagesSettings;
        try {
          settings = patchSettings(cur.settings, b);
        } catch (err) {
          throw h.fail(400, (err as Error).message);
        }
        const by = (await h.actorName(t)) ?? "you";
        await update(app, (s) => ({ ...s, settings, log: [{ at: new Date().toISOString(), text: `${by} changed the message settings.` }, ...s.log] }));
        return json(await view(app));
      },
    },
    {
      method: "POST",
      path: "/api/apps/:id/messages/announcements",
      handler: async (req, p, t) => {
        const app = await h.requireApp(t, p.id!);
        const b = await body(req);
        const { store, tokens } = stores();
        const state = await store.state(app.id);
        const profile = profileOf(app);
        const route = typeof b.route === "string" && ROUTE_RE.test(b.route) ? b.route : null;
        const sendAfter = typeof b.sendAfter === "string" && !Number.isNaN(Date.parse(b.sendAfter)) ? new Date(b.sendAfter).toISOString() : null;
        const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 80) : "Announcement";
        const locales = localesFor(new Map((await tokens.valid(app.id)).map((x) => [x.user, [x]])));
        const now = new Date();
        const by = (await h.actorName(t)) ?? null;
        let campaign: Campaign;
        if (b.texts) {
          // Written by the owner: sending it is their OK.
          const texts = textsFrom(b.texts);
          if (!Object.keys(texts).length) throw h.fail(400, "Write a title and a text in at least one language.");
          const draft: Draft = { texts, route, claims: [] };
          campaign = newCampaign({ kind: "announcement", name, channel: "push", draft, review: null, locales: Object.keys(texts) as Locale[], brand: profile?.brand ?? null, grounding: profile ? grounding(profile) : "", settings: state.settings, by: "owner", now, autonomy: "auto", sendAfter });
          if (!campaign.checks.ok) throw h.fail(400, campaign.checks.issues.join(" "));
          campaign = { ...campaign, approvedBy: by };
        } else {
          const about = typeof b.about === "string" ? b.about.trim().slice(0, 600) : "";
          if (about.length < 10) throw h.fail(400, "Say in a sentence what the announcement is about.");
          if (!profile) throw h.fail(409, "day2 needs the app scan first to write in the app's voice.");
          const goal = "A one-off announcement to everyone with push on: what's new and why it's worth opening the app for.";
          const { result, credits } = await h.runWithCredits(t, app, "content_generation", "Announcement texts", DRAFT_MAX_USD, async () => {
            const input = draftInput(app, profile, locales, goal, about);
            const d = await draftTexts(input);
            const review = d ? await reviewTexts(d.texts, d.claims, input) : null;
            return { d, review };
          });
          if (!result.d) throw h.fail(502, "day2 couldn't write it this time — nothing was saved. Try again or write it yourself.");
          campaign = newCampaign({ kind: "announcement", name, channel: "push", draft: { ...result.d, route: route ?? result.d.route }, review: result.review, locales, brand: profile.brand ?? null, grounding: grounding(profile), settings: state.settings, by: "day2", credits, now, autonomy: state.settings.autonomy.announcements, sendAfter });
          if (campaign.status === "draft") campaign = { ...campaign, status: "waiting" };
        }
        const text =
          campaign.by === "owner"
            ? `${by ?? "You"} wrote "${campaign.name}"; it goes out at each person's next good local time${sendAfter ? ` after ${sendAfter.slice(0, 16).replace("T", " ")} UTC` : ""}.`
            : `Wrote "${campaign.name}" — ${campaign.status === "active" ? "it starts now" : "it waits for your OK"}.`;
        await update(app, (s) => ({ ...s, campaigns: [campaign, ...s.campaigns], log: [{ at: now.toISOString(), text, ...(campaign.credits ? { credits: campaign.credits } : {}) }, ...s.log] }));
        return json({ campaign: messagesView({ ...state, campaigns: [campaign] }, [], { push: 0, ios: 0, android: 0, inAppOnly: 0, identified: 0 }, null, false).campaigns[0], view: await view(app) }, 201);
      },
    },
    {
      method: "PUT",
      path: "/api/apps/:id/messages/campaigns/:cid/texts",
      handler: async (req, p, t) => {
        const app = await h.requireApp(t, p.id!);
        const b = await body(req);
        const texts = textsFrom(b.texts);
        if (!Object.keys(texts).length) throw h.fail(400, "Write a title and a text in at least one language.");
        const { store } = stores();
        const state = await store.state(app.id);
        const c = state.campaigns.find((x) => x.id === p.cid);
        if (!c) throw h.fail(404, "No such campaign.");
        const profile = profileOf(app);
        const check = checkTexts(texts, { locales: Object.keys(c.texts) as Locale[], brand: profile?.brand ?? null, grounding: profile ? grounding(profile) : "" });
        if (!check.ok) throw h.fail(400, check.issues.join(" "));
        const route = b.route === null ? undefined : typeof b.route === "string" && ROUTE_RE.test(b.route) ? b.route : c.route;
        const by = (await h.actorName(t)) ?? "you";
        await update(app, (s) => ({
          ...s,
          campaigns: s.campaigns.map((x) => (x.id === c.id ? { ...x, texts, route, by: "owner", checks: { ok: true, issues: [] }, status: x.status === "draft" ? "waiting" : x.status, updatedAt: new Date().toISOString() } : x)),
          log: [{ at: new Date().toISOString(), text: `${by} edited the texts of "${c.name}".` }, ...s.log],
        }));
        return json(await view(app));
      },
    },
    {
      method: "POST",
      path: "/api/apps/:id/messages/campaigns/:cid/:action",
      handler: async (_req, p, t) => {
        const app = await h.requireApp(t, p.id!);
        const { store } = stores();
        const state = await store.state(app.id);
        const c = state.campaigns.find((x) => x.id === p.cid);
        if (!c) throw h.fail(404, "No such campaign.");
        const by = (await h.actorName(t)) ?? null;
        const now = new Date();
        const patch = campaignAction(p.action!, c, by, now);
        const verb: Record<string, string> = { approve: "approved", pause: "paused", resume: "resumed", stop: "stopped" };
        await update(app, (s) => ({
          ...s,
          campaigns: s.campaigns.map((x) => (x.id === c.id ? { ...x, ...patch, updatedAt: now.toISOString() } : x)),
          log: [{ at: now.toISOString(), text: `${by ?? "You"} ${verb[p.action!]} "${c.name}".` }, ...s.log],
        }));
        return json(await view(app));
      },
    },
  ];
}
