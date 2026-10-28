import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "../db/test-db";
import { ASSET_ID_RE, dbAssetStore, fileAssetStore, type AssetStore } from "./assets";
import { dbConnections, fileConnections, type ConnectionStore } from "./connections";
import { dbSentConversions, fileSentConversions, type SentConversions } from "./conversions";
import { dbPlatformIdentities, filePlatformIdentities, REF_RE, type PlatformIdentityStore } from "./identities";

/** Ad assets and platform identities: the same behaviour on files (local) and Postgres (production). */

const root = mkdtempSync(join(tmpdir(), "day2-ads-stores-"));
const prevKey = process.env.DAY2_SECRETS_KEY;
process.env.DAY2_SECRETS_KEY ??= randomBytes(32).toString("base64");
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (prevKey === undefined) delete process.env.DAY2_SECRETS_KEY;
});

function suite(name: string, make: () => Promise<{ assets: AssetStore; ids: PlatformIdentityStore; conns: ConnectionStore; sent: SentConversions; appId: string; cleanup: () => Promise<void> }>) {
  describe(name, () => {
    let ctx: Awaited<ReturnType<typeof make>>;
    test("assets: stored with an unguessable public URL; a video carries its cover", async () => {
      ctx = await make();
      const dir = mkdtempSync(join(root, "in-"));
      writeFileSync(join(dir, "c.jpg"), "jpg");
      writeFileSync(join(dir, "v.mp4"), "mp4-bytes");
      const cover = await ctx.assets.put(join(dir, "c.jpg"), { appId: ctx.appId, purpose: "B-1", label: "Cover 9:16", kind: "image", ratio: "9:16", width: 1080, height: 1920, mime: "image/jpeg", source: "screen_recording", aiGenerated: false, aiPerson: false });
      const v = await ctx.assets.put(join(dir, "v.mp4"), { appId: ctx.appId, purpose: "B-1", label: "App walkthrough video 9:16", kind: "video", ratio: "9:16", width: 1080, height: 1920, durationSec: 14, mime: "video/mp4", source: "screen_recording", aiGenerated: false, aiPerson: false, thumbnailId: cover.id });
      expect(v.id).toMatch(ASSET_ID_RE);
      expect(v.url).toBe(`https://day2.example/api/assets/${v.id}.mp4`);
      expect(v.bytes).toBe(9);
      expect(existsSync(v.path)).toBe(true);
      expect((await ctx.assets.get(v.id))?.thumbnail?.url).toBe(cover.url);
      expect((await ctx.assets.list(ctx.appId, "B-1")).map((a) => a.id).sort()).toEqual([cover.id, v.id].sort());
      expect(await ctx.assets.list("other")).toEqual([]);
      expect(await ctx.assets.get("as_aaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
    });
    test("connections: one per scope and platform, tokens sealed; half-done ones carry their sign-in", async () => {
      const a = await ctx.conns.save({ scope: "day2", platform: "tiktok", adAccountId: "1", accountName: "day2", currency: "USD", tokens: { accessToken: "t1" }, connectedBy: "op" });
      const b = await ctx.conns.save({ scope: { appId: ctx.appId }, platform: "tiktok", adAccountId: "2", accountName: "Buddy", currency: "EUR", tokens: { accessToken: "t2", refreshToken: "r" }, connectedBy: "ana" });
      await ctx.conns.save({ scope: { appId: ctx.appId }, platform: "tiktok", adAccountId: "3", accountName: "Buddy 2", currency: "EUR", tokens: { accessToken: "t3" }, connectedBy: "ana" });
      expect((await ctx.conns.list("day2")).map((c) => c.id)).toEqual([a.id]);
      const mine = await ctx.conns.get({ appId: ctx.appId }, "tiktok");
      expect(mine).toMatchObject({ adAccountId: "3", tokens: { accessToken: "t3" } });
      expect(b.id).not.toBe(mine!.id);
      await ctx.conns.updateTokens(mine!.id, { accessToken: "t4" });
      expect((await ctx.conns.get({ appId: ctx.appId }, "tiktok"))!.tokens.accessToken).toBe("t4");
      await ctx.conns.remove({ appId: ctx.appId }, "tiktok");
      expect(await ctx.conns.get({ appId: ctx.appId }, "tiktok")).toBeNull();
      const p = await ctx.conns.startPending({ state: "st", scope: { appId: ctx.appId }, platform: "x", purpose: "account", appId: ctx.appId, pending: null, createdBy: "ana" });
      await ctx.conns.setPendingData(p.id, { oauth_token: "rt" });
      await ctx.conns.setPendingTokens(p.id, { accessToken: "at", tokenSecret: "ts" });
      expect(await ctx.conns.pendingByState("st")).toMatchObject({ id: p.id, scope: { appId: ctx.appId }, pending: { oauth_token: "rt" }, tokens: { tokenSecret: "ts" } });
      await ctx.conns.endPending(p.id);
      expect(await ctx.conns.pending(p.id)).toBeNull();
    });
    test("conversions sent: remembered per app and platform", async () => {
      const at = new Date("2026-10-20T00:00:00Z");
      await ctx.sent.markSent(ctx.appId, "tiktok", ["d1:signup", "d2:signup"], at);
      await ctx.sent.markSent(ctx.appId, "tiktok", ["d1:signup"], at);
      expect([...(await ctx.sent.sent(ctx.appId, "tiktok"))].sort()).toEqual(["d1:signup", "d2:signup"]);
      expect((await ctx.sent.sent(ctx.appId, "meta")).size).toBe(0);
      expect(await ctx.sent.countSince(ctx.appId, "tiktok", new Date("2026-10-19T00:00:00Z"))).toBe(2);
      expect(await ctx.sent.countSince(ctx.appId, "tiktok", new Date("2026-10-21T00:00:00Z"))).toBe(0);
    });
    test("identities: one per app and platform", async () => {
      await ctx.ids.set({ appId: ctx.appId, platform: "linkedin", ref: "urn:li:organization:42", displayName: "Buddy", setBy: "Pablo" });
      await ctx.ids.set({ appId: ctx.appId, platform: "linkedin", ref: "urn:li:organization:43", displayName: "Buddy", setBy: "Pablo" });
      await ctx.ids.set({ appId: ctx.appId, platform: "tiktok", ref: "ident-1", displayName: "Buddy", setBy: "day2" });
      expect(await ctx.ids.get(ctx.appId, "linkedin")).toMatchObject({ ref: "urn:li:organization:43", setBy: "Pablo" });
      expect((await ctx.ids.forApp(ctx.appId)).map((i) => i.platform)).toEqual(expect.arrayContaining(["linkedin", "tiktok"]));
      await ctx.ids.remove(ctx.appId, "tiktok");
      expect(await ctx.ids.get(ctx.appId, "tiktok")).toBeUndefined();
      await ctx.cleanup();
    });
  });
}

suite("files", async () => {
  const legacy = join(root, "legacy.json");
  writeFileSync(legacy, JSON.stringify({ app_f: { appId: "app_f", metaPageId: "1234567890", setBy: "op", setAt: "2026-10-01T00:00:00Z" } }));
  const ids = filePlatformIdentities(join(root, "ids.json"), legacy);
  // The Meta Page assigned before carries over.
  expect(await ids.get("app_f", "meta")).toMatchObject({ ref: "1234567890" });
  return { assets: fileAssetStore(join(root, "assets"), "https://day2.example"), ids, conns: fileConnections(join(root, "conn.json")), sent: fileSentConversions(join(root, "sent.json")), appId: "app_f", cleanup: async () => {} };
});

if (process.env.DAY2_TEST_DATABASE_URL) {
  suite("Postgres", async () => {
    const t = await createTestDatabase();
    const [acc] = (await t.sql`INSERT INTO accounts (name) VALUES ('A') RETURNING id`) as Array<{ id: string }>;
    await t.sql`INSERT INTO apps (id, account_id, name, repo_path, connection_method) VALUES ('app_d', ${acc!.id}, 'buddy', '/tmp/x', 'github')`;
    // A Meta Page assigned on the Platform page counts here too.
    await t.sql`INSERT INTO app_ad_identities (app_id, meta_page_id, set_by) VALUES ('app_d', '1234567890', 'op')`;
    expect(await dbPlatformIdentities(t.sql).get("app_d", "meta")).toMatchObject({ ref: "1234567890" });
    const dbRoot = join(root, "db-assets");
    mkdirSync(dbRoot, { recursive: true });
    return { assets: dbAssetStore(t.sql, dbRoot, "https://day2.example"), ids: dbPlatformIdentities(t.sql), conns: dbConnections(t.sql), sent: dbSentConversions(t.sql), appId: "app_d", cleanup: async () => t.drop() };
  });
}

describe("references", () => {
  test("obvious mistakes are refused", () => {
    expect(REF_RE.linkedin.test("urn:li:organization:123")).toBe(true);
    expect(REF_RE.linkedin.test("123")).toBe(false);
    expect(REF_RE.meta.test("1234567890")).toBe(true);
    expect(REF_RE.meta.test("my page")).toBe(false);
    expect(REF_RE.x.test("@buddy")).toBe(false);
  });
});
