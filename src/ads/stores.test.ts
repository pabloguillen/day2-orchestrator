import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "../db/test-db";
import { ASSET_ID_RE, dbAssetStore, fileAssetStore, type AssetStore } from "./assets";
import { dbPlatformIdentities, filePlatformIdentities, REF_RE, type PlatformIdentityStore } from "./identities";

/** Ad assets and platform identities: the same behaviour on files (local) and Postgres (production). */

const root = mkdtempSync(join(tmpdir(), "day2-ads-stores-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function suite(name: string, make: () => Promise<{ assets: AssetStore; ids: PlatformIdentityStore; appId: string; cleanup: () => Promise<void> }>) {
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
  return { assets: fileAssetStore(join(root, "assets"), "https://day2.example"), ids, appId: "app_f", cleanup: async () => {} };
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
    return { assets: dbAssetStore(t.sql, dbRoot, "https://day2.example"), ids: dbPlatformIdentities(t.sql), appId: "app_d", cleanup: async () => t.drop() };
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
