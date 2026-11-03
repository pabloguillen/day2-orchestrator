import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import { emptyBacklog, loadBacklog, saveBacklog } from "../backlog";
import { backlogFile } from "../backlog-work";
import { fileFieldStore } from "../field-store";
import type { AppProfile } from "../onboarding";
import { computeSnapshot } from "../retention";
import { arm } from "../../packages/sensors/src/lifecycle";
import { liveMessages } from "./contributor";
import { messagesPass, newCampaign, type MessagesDeps } from "./pass";
import { SETUP_KEY } from "./setup";
import { fileMessagesStore } from "./store";
import { filePushTokens } from "./tokens";
import type { Draft } from "./texts";

const DAY = 86_400_000;
// 14:00 in Berlin: not quiet.
const NOW = new Date("2026-11-03T13:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString().slice(0, 10);
const user = (i: number) => `u_${i.toString(16).padStart(32, "0")}`;
const tok = (i: number) => `ExponentPushToken[tok${i.toString().padStart(8, "0")}]`;

const draft: Draft = {
  texts: { de: { title: "Dein Punktebild wartet", body: "Heute gibt es ein neues Rätsel für dich.", cta: "Ansehen" }, en: { title: "Your dot picture awaits", body: "There's a new puzzle for you today.", cta: "Open" } },
  route: "/today",
  claims: ["a new puzzle every day"],
};

describe("the messages pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "day2-messages-pass-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), '{"dependencies":{"expo":"54","react-native":"0.81"}}');
  saveBacklog(join(root, "day2-backlog.json"), emptyBacklog());
  const app: AppEntry = { id: "app_dotty", name: "Dotty", repoPath: root, connectionMethod: "local_path", addedAt: "2026-09-01T00:00:00Z" };
  saveBacklog(backlogFile(app), emptyBacklog());
  const field = fileFieldStore(join(root, "field"));
  const store = fileMessagesStore(join(root, "messages"));
  const tokens = filePushTokens(join(root, "messages"));
  const profile = { purpose: "Daily dot puzzles", targetUsers: "German-speaking teens", featureMap: ["Daily dot puzzle", "Gallery"], toneOfVoice: "playful, du", businessModel: null, brand: null } as unknown as AppProfile;

  const expoCalls: Array<{ url: string; body: unknown; auth: string | undefined }> = [];
  let expoMode: "ok" | "unauthorized" = "ok";
  const gone = new Set<string>([tok(2)]);
  const receiptErrors = new Set<string>();
  let receiptN = 0;
  const deps: MessagesDeps = {
    store,
    tokens,
    field,
    expo: {
      accessToken: async () => "expo-owner-token",
      sleep: async () => {},
      fetch: async (url, init) => {
        const body = JSON.parse(init.body as string);
        expoCalls.push({ url, body, auth: (init.headers as Record<string, string>).authorization });
        if (expoMode === "unauthorized") return new Response(JSON.stringify({ errors: [{ code: "UNAUTHORIZED", message: "no" }] }), { status: 401 });
        if (url.endsWith("/send")) return Response.json({ data: (body as Array<{ to: string }>).map((m) => (gone.has(m.to) ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } : { status: "ok", id: `rc-${++receiptN}` })) });
        return Response.json({ data: Object.fromEntries((body as { ids: string[] }).ids.map((id) => [id, receiptErrors.has(id) ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } : { status: "ok" }])) });
      },
    },
    async write() {
      return { draft, review: { ok: true, issues: [] }, credits: 12 };
    },
  };
  const logs: string[] = [];
  const run = (at: Date) => messagesPass(app, profile, deps, (t) => logs.push(t), at);

  test("a web app or a switched-off module does nothing", async () => {
    const st = await store.state(app.id);
    await store.setState(app.id, { ...st, settings: { ...st.settings, enabled: false } }, NOW);
    expect((await run(NOW)).ticketsCreated).toEqual([]);
    await store.setState(app.id, st, NOW);
  });

  test("once the library reports: the setup ticket, once", async () => {
    expect((await run(NOW)).ticketsCreated).toEqual([]);
    // 300 identified users: 100 at risk (last active 3 days ago), 200 current.
    for (let i = 1; i <= 300; i++) {
      const days = Array.from({ length: 18 }, (_, k) => k + 3).concat(i <= 100 ? [] : [0, 1, 2]);
      await field.record(app.id, { v: 1, device: { id: `d${i}`, platform: "ios" }, passes: {}, failures: [], events: days.map((d) => ({ type: "active", at: `${day(d)}T${String(1 + (d % 12)).padStart(2, "0")}:00:00Z`, user: user(i) })) }, NOW);
    }
    await field.setRetention(app.id, { ...computeSnapshot({ ...(await field.activity(app.id, day(400))), productType: "habit", now: NOW }), leak: "at_risk" });
    const r = await run(new Date(NOW.getTime() + 60_000));
    expect(r.ticketsCreated).toHaveLength(1);
    const t = loadBacklog(backlogFile(app)).tickets.find((x) => x.source.key === SETUP_KEY)!;
    expect(t.title).toBe("Push notifications and in-app messages");
    expect(t.description).toContain("allowProvisional");
    expect(t.description).toContain("day2.setPushToken");
    expect((await run(new Date(NOW.getTime() + 120_000))).ticketsCreated).toEqual([]);
    // Nobody has push on yet: no campaigns written, no credits spent.
    expect((await store.state(app.id)).campaigns).toEqual([]);
  });

  test("with push tokens: writes campaigns (biggest leak first), queues and sends at-risk pushes with a holdout", async () => {
    for (let i = 1; i <= 300; i++) await tokens.save(app.id, { user: user(i), token: tok(i), platform: i % 2 ? "ios" : "android", tz: "Europe/Berlin", tzOffset: null, locale: i % 3 ? "de" : "en" }, NOW);
    // Force the 6-hour plan.
    const st = await store.state(app.id);
    await store.setState(app.id, { ...st, ran: { ...st.ran, plan: undefined } }, NOW);
    const at = new Date(NOW.getTime() + 10 * 60_000);
    const r = await run(at);
    const state = await store.state(app.id);
    expect(state.campaigns.map((c) => c.audience)).toEqual(["onboarding_d1", "at_risk"]);
    expect(state.campaigns.every((c) => c.status === "active" && c.checks.ok)).toBe(true);
    const atRisk = state.campaigns.find((c) => c.audience === "at_risk")!;
    const sends = await store.sends(app.id, { campaignId: atRisk.id });
    expect(sends).toHaveLength(100);
    const held = sends.filter((s) => s.status === "held");
    for (const s of sends) expect(s.arm).toBe(arm(s.user, atRisk.id, 0.1));
    expect(held.length).toBe(sends.filter((s) => s.arm === "holdout").length);
    // Sent right away (14:10 in Berlin); user 2's phone is gone.
    expect(r.sent).toBe(100 - held.length - (sends.find((s) => s.user === user(2))!.arm === "on" ? 1 : 0));
    const sent = expoCalls.filter((c) => c.url.endsWith("/send"));
    expect(sent.every((c) => c.auth === "Bearer expo-owner-token")).toBe(true);
    const msgs = sent.flatMap((c) => c.body as Array<{ to: string; title: string; data: { day2: { c: string; r: string } }; channelId?: string }>);
    const en = msgs.find((m) => m.to === tok(3))!; // user 3: English
    if (en) expect(en.title).toBe(draft.texts.en!.title);
    const de = msgs.find((m) => m.to === tok(4));
    if (de) {
      expect(de.title).toBe(draft.texts.de!.title);
      expect(de.data).toEqual({ day2: { c: atRisk.id, r: "/today" } });
      expect(de.channelId).toBe("default");
    }
    if (sends.find((s) => s.user === user(2))!.arm === "on") expect((await tokens.valid(app.id, [user(2)])).length).toBe(0);
    expect(state.log.some((l) => l.text.startsWith("Sent "))).toBe(true);
    expect(state.log.some((l) => l.text.startsWith("Wrote ") && l.credits === 12)).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("ExponentPushToken");
    expect(JSON.stringify(await store.sends(app.id))).not.toContain("ExponentPushToken");
  });

  test("receipts after 15 minutes: delivered, and a dead device loses its token", async () => {
    const before = await store.sends(app.id, { status: ["sent"] });
    const victim = before[0]!;
    receiptErrors.add(victim.receipts[0]!.id);
    expoCalls.length = 0;
    await run(new Date(NOW.getTime() + 20 * 60_000)); // too early for some? all sent at +10min → +20 is 10 min later
    expect(expoCalls.filter((c) => c.url.endsWith("/getReceipts"))).toHaveLength(0);
    await run(new Date(NOW.getTime() + 30 * 60_000));
    expect(expoCalls.filter((c) => c.url.endsWith("/getReceipts"))).toHaveLength(1);
    const after = await store.sends(app.id);
    expect(after.find((s) => s.id === victim.id)!.status).toBe("failed");
    expect(after.filter((s) => s.status === "delivered").length).toBe(before.length - 1);
    expect(await tokens.valid(app.id, [victim.user])).toEqual([]);
    expect((await tokens.optOuts(app.id, NOW)).some((o) => o.user === victim.user && o.reason === "not_registered")).toBe(true);
  });

  test("announcements wait for the owner, then go once, not in quiet hours", async () => {
    let st = await store.state(app.id);
    const a = newCampaign({ kind: "announcement", name: "Neue Galerie", channel: "push", draft, review: null, locales: ["de", "en"], brand: null, grounding: "", settings: st.settings, by: "owner", now: NOW, autonomy: st.settings.autonomy.announcements });
    expect(a.status).toBe("waiting");
    await store.setState(app.id, { ...st, campaigns: [a, ...st.campaigns] }, NOW);
    // 22:30 in Berlin.
    const night = new Date("2026-11-03T21:30:00Z");
    await run(night);
    expect((await store.sends(app.id, { campaignId: a.id })).length).toBe(0);
    st = await store.state(app.id);
    await store.setState(app.id, { ...st, campaigns: st.campaigns.map((c) => (c.id === a.id ? { ...c, status: "active", approvedAt: night.toISOString(), approvedBy: "Pablo" } : c)) }, night);
    expoCalls.length = 0;
    const r = await run(new Date(night.getTime() + 60_000));
    const queued = await store.sends(app.id, { campaignId: a.id });
    expect(queued.length).toBeGreaterThan(100);
    expect(r.sent).toBe(0); // quiet hours
    expect(queued.filter((q) => q.status === "queued").every((q) => q.dueAt >= "2026-11-04T08:00:00.000Z" && q.dueAt < "2026-11-04T08:30:00.000Z")).toBe(true);
    // Next morning, 09:40 Berlin.
    const r2 = await run(new Date("2026-11-04T08:40:00Z"));
    expect(r2.sent).toBeGreaterThan(50);
    // Once only.
    const r3 = await run(new Date("2026-11-04T09:00:00Z"));
    expect((await store.sends(app.id, { campaignId: a.id })).length).toBe(queued.length);
    expect(r3.queued).toBe(0);
  });

  test("Expo refuses the access token: pushes wait, the owner sees what to fix", async () => {
    let st = await store.state(app.id);
    const a = newCampaign({ kind: "announcement", name: "Zweite News", channel: "push", draft, review: null, locales: ["de", "en"], brand: null, grounding: "", settings: { ...st.settings, holdout: 0 }, by: "owner", now: NOW, autonomy: "auto" });
    // Room in the weekly limit.
    await store.setState(app.id, { ...st, settings: { ...st.settings, maxPerWeek: 10 }, campaigns: [a, ...st.campaigns] }, NOW);
    expoMode = "unauthorized";
    const at = new Date("2026-11-05T12:00:00Z");
    await run(at);
    st = await store.state(app.id);
    expect(st.problem?.text).toContain("access token");
    expect((await store.sends(app.id, { campaignId: a.id, status: ["queued"] })).length).toBeGreaterThan(0);
    expoMode = "ok";
    const r = await run(new Date(at.getTime() + 15 * 60_000));
    expect(r.sent).toBeGreaterThan(0);
    expect((await store.state(app.id)).problem).toBeNull();
  });

  test("daily: a campaign whose recipients switch push off clearly more is stopped", async () => {
    let st = await store.state(app.id);
    const atRisk = st.campaigns.find((c) => c.audience === "at_risk")!;
    const recipients = (await store.sends(app.id, { campaignId: atRisk.id })).filter((s) => s.arm === "on");
    for (const s of recipients.slice(0, 60)) await tokens.save(app.id, { user: s.user, token: null, platform: Number.parseInt(s.user.slice(-4), 16) % 2 ? "ios" : "android" }, new Date(NOW.getTime() + DAY));
    st = await store.state(app.id);
    await store.setState(app.id, { ...st, ran: { ...st.ran, daily: undefined } }, NOW);
    const r = await run(new Date("2026-11-05T13:00:00Z"));
    expect(r.stopped).toContain(atRisk.id);
    const c = (await store.state(app.id)).campaigns.find((x) => x.id === atRisk.id)!;
    expect(c.status).toBe("stopped");
    expect(c.stoppedReason).toContain("switched push off");
  });
});

test("in-app messages for Live config: active, checked, with the holdout as percent", () => {
  const settings = { enabled: true, quietHours: { start: 21, end: 9 }, maxPerWeek: 3, autonomy: { lifecycle: "auto" as const, announcements: "ask" as const }, holdout: 0.1 };
  const c = newCampaign({ kind: "lifecycle", name: "Lapsing", audience: "lapsing", channel: "both", draft, review: { ok: true, issues: [] }, locales: ["de", "en"], brand: null, grounding: "", settings, by: "day2", now: NOW, autonomy: "auto" });
  const push = newCampaign({ kind: "lifecycle", name: "At risk", audience: "at_risk", channel: "push", draft, review: { ok: true, issues: [] }, locales: ["de", "en"], brand: null, grounding: "", settings, by: "day2", now: NOW, autonomy: "auto" });
  const failed = newCampaign({ kind: "lifecycle", name: "Bad", audience: "winback", channel: "both", draft, review: { ok: false, issues: ["claims a streak"] }, locales: ["de", "en"], brand: null, grounding: "", settings, by: "day2", now: NOW, autonomy: "auto" });
  expect(failed.status).toBe("draft");
  const m = liveMessages({ settings, campaigns: [c, push, failed], ran: {}, log: [] });
  expect(m).toEqual([
    {
      id: c.id,
      trigger: "comeback",
      title: draft.texts.en!.title,
      body: draft.texts.en!.body,
      cta: { label: "Open", route: "/today" },
      cap: { total: 1, perDay: 1 },
      audience: { percent: 90 },
      locale: { de: draft.texts.de!, en: draft.texts.en! },
    },
  ]);
  expect(liveMessages({ settings: { ...settings, enabled: false }, campaigns: [c], ran: {}, log: [] })).toEqual([]);
});
