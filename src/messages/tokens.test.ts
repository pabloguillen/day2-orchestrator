import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "../db/test-db";
import { cleanPushInput, dbPushTokens, filePushTokens, type PushTokenStore } from "./tokens";
import { dbMessagesStore, fileMessagesStore, type MessagesStore } from "./store";
import type { SendRecord } from "./types";

const U1 = `u_${"a".repeat(32)}`;
const U2 = `u_${"b".repeat(32)}`;
const T1 = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const T2 = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";
const NOW = new Date("2026-11-03T10:00:00Z");
const D1 = "dev-phone-0001";
const D2 = "dev-attacker-02";

describe("cleanPushInput", () => {
  test("keeps a valid registration, with zone, offset and language", () => {
    expect(cleanPushInput({ user: U1, device: D1, token: T1, platform: "ios", tz: "Europe/Berlin", locale: "de-DE", extra: 1 })).toEqual({ user: U1, device: D1, token: T1, platform: "ios", tz: "Europe/Berlin", tzOffset: null, locale: "de" });
    expect(cleanPushInput({ user: U1, device: D1, token: T1, platform: "android", tz: 60 })).toMatchObject({ tz: null, tzOffset: 60, locale: null });
    expect(cleanPushInput({ user: U1, device: D1, token: null, platform: "ios" })).toMatchObject({ token: null });
  });
  test("refuses anything else", () => {
    expect(cleanPushInput({ user: "alice@example.com", device: D1, token: T1, platform: "ios" })).toBeNull();
    expect(cleanPushInput({ user: U1, device: D1, token: "not-a-token", platform: "ios" })).toBeNull();
    expect(cleanPushInput({ user: U1, device: D1, token: T1, platform: "web" })).toBeNull();
    // Without the sending device's id: refused (tokens are bound to devices).
    expect(cleanPushInput({ user: U1, token: T1, platform: "ios" })).toBeNull();
    expect(cleanPushInput({ user: U1, device: "../x", token: T1, platform: "ios" })).toBeNull();
    expect(cleanPushInput({ user: U1, device: D1, token: T1, platform: "ios", tz: "Mars/Olympus" })).toMatchObject({ tz: null });
    expect(cleanPushInput({ user: U1, device: D1, token: T1, platform: "ios", tz: 5000 })).toMatchObject({ tzOffset: null });
    expect(cleanPushInput(null)).toBeNull();
  });
});

const rec = (id: string, over: Partial<SendRecord> = {}): SendRecord => ({
  id,
  campaignId: "c1",
  user: U1,
  channel: "push",
  arm: "on",
  status: "queued",
  locale: "de",
  eligibleAt: NOW.toISOString(),
  dueAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
  sentAt: null,
  receipts: [],
  error: null,
  checkedAt: null,
  ...over,
});

function suite(name: string, setup: () => Promise<{ tokens: PushTokenStore; store: MessagesStore; appId: string; cleanup: () => Promise<void> }>) {
  describe(name, async () => {
    const s = await setup();
    afterAll(() => s.cleanup());

    test("save, move between users, switch off, invalidate, opt-outs", async () => {
      await s.tokens.save(s.appId, { user: U1, token: T1, platform: "ios", tz: "Europe/Berlin", tzOffset: null, locale: "de" }, NOW);
      await s.tokens.save(s.appId, { user: U2, token: T2, platform: "android", tz: null, tzOffset: 60 }, NOW);
      expect((await s.tokens.valid(s.appId)).map((t) => t.user).sort()).toEqual([U1, U2]);
      expect(await s.tokens.counts(s.appId)).toEqual({ users: 2, ios: 1, android: 1 });
      // Someone else signs in on U2's phone: the token moves.
      await s.tokens.save(s.appId, { user: U1, token: T2, platform: "android", tz: null, tzOffset: 60 }, NOW);
      expect((await s.tokens.valid(s.appId, [U1])).map((t) => t.token).sort()).toEqual([T1, T2]);
      expect(await s.tokens.valid(s.appId, [U2])).toEqual([]);
      // Push switched off on the iPhone.
      await s.tokens.save(s.appId, { user: U1, token: null, platform: "ios" }, new Date(NOW.getTime() + 1000));
      expect((await s.tokens.valid(s.appId, [U1])).map((t) => t.token)).toEqual([T2]);
      // Expo says the Android device is gone.
      await s.tokens.invalidate(s.appId, T2, "not_registered", new Date(NOW.getTime() + 2000));
      expect(await s.tokens.valid(s.appId)).toEqual([]);
      const outs = await s.tokens.optOuts(s.appId, NOW);
      expect(outs.map((o) => [o.user, o.reason])).toEqual([
        [U1, "disabled"],
        [U1, "not_registered"],
      ]);
      // Registering again brings it back.
      await s.tokens.save(s.appId, { user: U1, token: T1, platform: "ios", tz: "Europe/Berlin", tzOffset: null }, new Date(NOW.getTime() + 3000));
      expect((await s.tokens.valid(s.appId)).map((t) => t.token)).toEqual([T1]);
    });

    test("cleanup drops invalid tokens and tokens unseen for 400 days", async () => {
      await s.tokens.save(s.appId, { user: U2, token: T2, platform: "android", tz: null, tzOffset: null }, NOW);
      await s.tokens.invalidate(s.appId, T2, "not_registered", NOW);
      const r = await s.tokens.prune(new Date(NOW.getTime() + 401 * 86_400_000));
      expect(r.tokens).toBe(2);
      expect(await s.tokens.valid(s.appId)).toEqual([]);
    });

    test("messages state and send records", async () => {
      const st = await s.store.state(s.appId);
      expect(st.settings.quietHours).toEqual({ start: 21, end: 9 });
      expect(st.settings.autonomy).toEqual({ lifecycle: "auto", announcements: "ask" });
      await s.store.setState(s.appId, { ...st, settings: { ...st.settings, maxPerWeek: 2 } }, NOW);
      expect((await s.store.state(s.appId)).settings.maxPerWeek).toBe(2);
      await s.store.addSends(s.appId, [rec("ms_1"), rec("ms_2", { campaignId: "c2", status: "held", arm: "holdout" })]);
      await s.store.addSends(s.appId, [rec("ms_1")]); // idempotent
      await s.store.updateSends(s.appId, [{ id: "ms_1", status: "sent", sentAt: NOW.toISOString(), receipts: [{ id: "r1", device: "abc" }] }]);
      const all = await s.store.sends(s.appId);
      expect(all).toHaveLength(2);
      expect(all.find((r) => r.id === "ms_1")).toMatchObject({ status: "sent", receipts: [{ id: "r1", device: "abc" }] });
      expect((await s.store.sends(s.appId, { status: ["held"] })).map((r) => r.id)).toEqual(["ms_2"]);
      expect((await s.store.sends(s.appId, { campaignId: "c1" })).map((r) => r.id)).toEqual(["ms_1"]);
      await s.store.prune(new Date(NOW.getTime() + 401 * 86_400_000));
      expect(await s.store.sends(s.appId)).toEqual([]);
    });

    test("tokens are bound to their device: another device can't clear or replace them, only add its own", async () => {
      const U3 = `u_${"c".repeat(32)}`;
      const T3 = "ExponentPushToken[cccccccccccccccccccccc]";
      const T4 = "ExponentPushToken[dddddddddddddddddddddd]";
      const T5 = "ExponentPushToken[eeeeeeeeeeeeeeeeeeeeee]";
      const at = (n: number) => new Date(NOW.getTime() + 10_000 + n * 1000);
      const mine = async () => (await s.tokens.valid(s.appId, [U3])).map((t) => t.token).sort();
      const outs = async () => (await s.tokens.optOuts(s.appId, NOW)).filter((o) => o.user === U3);
      await s.tokens.save(s.appId, { user: U3, device: D1, token: T3, platform: "ios", tz: null, tzOffset: null }, at(0));
      // Someone else who knows the user's hash, from another device: an opt-out changes nothing and isn't counted.
      await s.tokens.save(s.appId, { user: U3, device: D2, token: null, platform: "ios" }, at(1));
      expect(await mine()).toEqual([T3]);
      expect(await outs()).toEqual([]);
      // Registering from that device adds its own entry; the real one stays.
      await s.tokens.save(s.appId, { user: U3, device: D2, token: T4, platform: "ios", tz: null, tzOffset: null }, at(2));
      expect(await mine()).toEqual([T3, T4].sort());
      expect((await s.tokens.valid(s.appId, [U3])).find((t) => t.token === T3)?.device).toBe(D1);
      // The real device gets a new token: it replaces only its own old one (no opt-out).
      await s.tokens.save(s.appId, { user: U3, device: D1, token: T5, platform: "ios", tz: null, tzOffset: null }, at(3));
      expect(await mine()).toEqual([T4, T5].sort());
      expect(await outs()).toEqual([]);
      // The real device switches push off: only its token, counted once.
      await s.tokens.save(s.appId, { user: U3, device: D1, token: null, platform: "ios" }, at(4));
      expect(await mine()).toEqual([T4]);
      expect((await outs()).length).toBe(1);
    });
  });
}

suite("push tokens in files (local mode)", async () => {
  const root = mkdtempSync(join(tmpdir(), "day2-msg-tokens-"));
  return { tokens: filePushTokens(root), store: fileMessagesStore(root), appId: "app_1", cleanup: async () => rmSync(root, { recursive: true, force: true }) };
});

if (process.env.DAY2_TEST_DATABASE_URL) {
  suite("push tokens in Postgres (accounts mode)", async () => {
    const t = await createTestDatabase();
    const [acc] = (await t.sql`INSERT INTO accounts (name) VALUES ('A') RETURNING id`) as Array<{ id: string }>;
    await t.sql`INSERT INTO apps (id, account_id, name, repo_path, connection_method) VALUES ('app_db', ${acc!.id}, 'dotty', '/tmp/x', 'github')`;
    return { tokens: dbPushTokens(t.sql), store: dbMessagesStore(t.sql), appId: "app_db", cleanup: () => t.drop() };
  });
}

test("token files are readable only by day2's user", async () => {
  const root = mkdtempSync(join(tmpdir(), "day2-msg-perm-"));
  await filePushTokens(root).save("a", { user: U1, token: T1, platform: "ios", tz: null, tzOffset: null }, NOW);
  const { statSync } = await import("node:fs");
  expect(statSync(join(root, "a", "push-tokens.json")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(root, "a", "push-tokens.json"), "utf-8")).toContain(T1);
  rmSync(root, { recursive: true, force: true });
});

test("the ingest push route stores the token through Messages (replays keep their time)", async () => {
  const { pushTokenSaver } = await import("./runtime");
  const root = mkdtempSync(join(tmpdir(), "day2-msg-ingest-"));
  const store = filePushTokens(root);
  const saver = pushTokenSaver(() => store);
  await saver.save("a", { user: U1, device: D1, token: T1, platform: "android", tz: "Europe/Vienna", at: "2026-11-01T08:00:00.000Z" });
  await saver.save("a", { user: "not-hashed", device: D1, token: T2, platform: "ios", tz: null, at: NOW.toISOString() });
  expect(await store.valid("a")).toEqual([{ user: U1, token: T1, platform: "android", tz: "Europe/Vienna", tzOffset: null, locale: null, updatedAt: "2026-11-01T08:00:00.000Z", invalidatedAt: null, invalidReason: null, device: D1 }]);
  await saver.save("a", { user: U1, device: D1, token: null, platform: "android", tz: null, at: NOW.toISOString() });
  expect(await store.valid("a")).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});
