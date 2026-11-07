import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileAssetStore, type AssetStore } from "../ads/assets";
import { noSleep, scriptedFetch, type Expect } from "../ads/test-helpers";
import { loadGrowthConfig } from "../growth-config";
import { publishDue, postStatusOf, backoffMs } from "./publish";
import { fileMediaLinks, fileSocialAccounts, fileSocialPosts, type MediaLinkStore, type SocialAccountStore, type SocialPostStore } from "./store";
import { contentHash, type Post, type Target } from "./types";
import { chunkPlan, isTikTokUploadUrl } from "./tiktok";

/**
 * The publisher against scripted fakes of the Graph API and TikTok's
 * Content Posting API: container polling, the publishing limit, never
 * posting twice after a crash, Facebook Reels' phases, TikTok's chunked
 * upload, backoff, daily limits, the kill switch and the claim lease.
 */

let dir: string;
let posts: SocialPostStore;
let accounts: SocialAccountStore;
let links: MediaLinkStore;
let assets: AssetStore;
let videoId: string;
let imageId: string;
const NOW = new Date("2026-11-07T18:00:00Z");
const savedKey = process.env.DAY2_SECRETS_KEY;

beforeAll(async () => {
  process.env.DAY2_SECRETS_KEY = Buffer.alloc(32, 3).toString("base64");
  dir = mkdtempSync(join(tmpdir(), "day2-social-pub-"));
  posts = fileSocialPosts(join(dir, "posts.json"));
  accounts = fileSocialAccounts(join(dir, "accounts.json"));
  links = fileMediaLinks(join(dir, "links.json"));
  assets = fileAssetStore(join(dir, "assets"), "https://day2.test");
  writeFileSync(join(dir, "v.mp4"), new Uint8Array(1000).fill(7));
  writeFileSync(join(dir, "i.jpg"), new Uint8Array(100).fill(1));
  videoId = (await assets.put(join(dir, "v.mp4"), { appId: "dotty", purpose: "social:sg_1", label: "Motion video", kind: "video", ratio: "9:16", width: 1080, height: 1920, durationSec: 12, mime: "video/mp4", source: "motion_template", aiGenerated: false, aiPerson: false })).id;
  imageId = (await assets.put(join(dir, "i.jpg"), { appId: "dotty", purpose: "social:sg_1", label: "Post image", kind: "image", ratio: "4:5", width: 1080, height: 1350, mime: "image/jpeg", source: "screenshot", aiGenerated: false, aiPerson: false })).id;
  await accounts.save({ appId: "dotty", network: "meta", meta: { pageId: "100200300", pageName: "Dotty", igUserId: "1784", igUsername: "dotty.app", igAccountType: null, scopes: ["instagram_content_publish", "pages_manage_posts"] }, tokens: { pageToken: "PAGE-TOKEN-SECRET" }, connectedBy: "Pablo" });
  await accounts.save({ appId: "dotty", network: "tiktok", meta: { openId: "o1", nickname: "Dotty", username: "dotty", scopes: ["video.publish", "video.upload", "video.list"] }, tokens: { accessToken: "TT-ACCESS", refreshToken: "TT-REFRESH", expiresAt: NOW.getTime() + 86_400_000, refreshExpiresAt: null }, connectedBy: "Pablo" });
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedKey === undefined) delete process.env.DAY2_SECRETS_KEY;
  else process.env.DAY2_SECRETS_KEY = savedKey;
});

let n = 0;
function target(over: Partial<Target>): Target {
  return { platform: "instagram", format: "reel", assetId: videoId, caption: "Kennst du das?", hashtags: ["lernen", "schule"], status: "pending", attempts: 0, metrics: [], ...over };
}
async function post(targets: Target[], over: Partial<Post> = {}): Promise<Post> {
  const iso = NOW.toISOString();
  const p = build(targets, over, iso);
  return posts.insert({ ...p, approvedHash: over.approvedHash === undefined ? contentHash(p) : over.approvedHash });
}
function build(targets: Target[], over: Partial<Post>, iso: string): Post {
  return ({
    id: `sp_test${++n}`,
    appId: "dotty",
    group: "sg_1",
    status: "approved",
    kind: "video",
    language: "de",
    idea: { topic: "feature", hook: "question", title: "Kennst du das?", brandAngle: null, trend: null },
    source: { arm: "motion-graphics-short-video", armKey: "x", experimentId: null, made: "motion_template" },
    targets,
    scheduledAt: new Date(NOW.getTime() - 60_000).toISOString(),
    timeSlot: "evening",
    timeWhy: null,
    safety: { ok: true, issues: [], checkedAt: iso },
    tiktok: null,
    costCredits: 0,
    createdAt: iso,
    updatedAt: iso,
    ...over,
  }) as Post;
}

function deps(script: Expect[], over: Partial<Parameters<typeof publishDue>[1]> = {}) {
  const f = scriptedFetch(script);
  return {
    f,
    d: {
      posts,
      accounts,
      links,
      assets,
      publicUrl: "https://day2.test",
      meta: { appSecret: "s", apiVersion: "v26.0" },
      tiktok: { clientKey: "ck", clientSecret: "cs" },
      platformDeps: { fetch: f.fetch, sleep: noSleep, now: () => NOW },
      now: () => NOW,
      stopped: false,
      budget: loadGrowthConfig("/nonexistent/.day2-budget.json").budget,
      ledger: [],
      ...over,
    } satisfies Parameters<typeof publishDue>[1],
  };
}

/** Marks every other test post finished so each test only sees its own. */
async function only(id: string) {
  const old = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
  for (const p of await posts.due("dotty"))
    if (p.id !== id) await posts.update("dotty", p.id, (x) => ({ ...x, status: x.status === "published" ? x.status : "failed", targets: x.targets.map((t) => (t.status === "published" ? { ...t, publishedAt: old } : { ...t, status: "failed" as const })) }));
}

describe("Instagram", () => {
  test("Reel: container → poll until FINISHED → limit check → publish; the media link ends 24 h after", async () => {
    const p = await post([target({})]);
    await only(p.id);
    const { f, d } = deps([
      { method: "POST", url: "/1784/media", check: (r) => {
        const j = r.json as Record<string, string>;
        expect(j.media_type).toBe("REELS");
        expect(j.share_to_feed).toBe("true");
        expect(j.video_url).toMatch(/^https:\/\/day2\.test\/api\/assets\/sm_[A-Za-z0-9_-]{43}\.mp4$/);
        expect(j.caption).toBe("Kennst du das?\n\n#lernen #schule");
        expect(r.headers.authorization).toBe("OAuth PAGE-TOKEN-SECRET");
        expect(r.url).not.toContain("PAGE-TOKEN");
      }, json: { id: "c1" } },
      { method: "GET", url: "/c1?fields=status_code", json: { status_code: "IN_PROGRESS" } },
      { method: "GET", url: "/c1?fields=status_code", json: { status_code: "FINISHED" } },
      { method: "GET", url: "/1784/content_publishing_limit", json: { data: [{ quota_usage: 2, config: { quota_total: 100 } }] } },
      { method: "POST", url: "/1784/media_publish", check: (r) => expect((r.json as Record<string, string>).creation_id).toBe("c1"), json: { id: "m1" } },
      { method: "GET", url: "/m1?fields=permalink", json: { permalink: "https://www.instagram.com/reel/abc/" } },
    ]);
    const r = await publishDue("dotty", d);
    expect(f.done()).toBe(true);
    expect(r.published).toEqual([`${p.id} on Instagram`]);
    const after = (await posts.get("dotty", p.id))!;
    expect(after.status).toBe("published");
    expect(after.targets[0]).toMatchObject({ status: "published", externalId: "m1", permalink: "https://www.instagram.com/reel/abc/", stepId: "c1", leaseUntil: null });
    const token = (f.calls[0]!.json as Record<string, string>).video_url!.split("/").pop()!.replace(".mp4", "");
    expect(await links.resolve(token, new Date(NOW.getTime() + 23 * 3_600_000))).not.toBeNull();
    expect(await links.resolve(token, new Date(NOW.getTime() + 25 * 3_600_000))).toBeNull();
  });

  test("a slow container waits for the next pass with its id kept, then continues from it", async () => {
    const p = await post([target({})]);
    await only(p.id);
    const one = deps([
      { method: "POST", url: "/1784/media", json: { id: "c2" } },
      ...Array.from({ length: 7 }, () => ({ method: "GET", url: "/c2?fields=status_code", json: { status_code: "IN_PROGRESS" } })),
    ]);
    const r1 = await publishDue("dotty", one.d);
    expect(r1.waiting).toBe(1);
    const mid = (await posts.get("dotty", p.id))!;
    expect(mid.status).toBe("publishing");
    expect(mid.targets[0]).toMatchObject({ status: "publishing", stepId: "c2", attempts: 0 });
    expect(Date.parse(mid.targets[0]!.nextAttemptAt!)).toBeGreaterThan(NOW.getTime());
    // Next pass, later: no second container.
    const later = new Date(NOW.getTime() + 10 * 60_000);
    const two = deps(
      [
        { method: "GET", url: "/c2?fields=status_code", json: { status_code: "FINISHED" } },
        { method: "GET", url: "/content_publishing_limit", json: { data: [{ quota_usage: 0, config: { quota_total: 100 } }] } },
        { method: "POST", url: "/media_publish", json: { id: "m2" } },
        { method: "GET", url: "/m2?fields=permalink", json: {} },
      ],
      { now: () => later },
    );
    expect((await publishDue("dotty", two.d)).published).toHaveLength(1);
    expect(two.f.done()).toBe(true);
  });

  test("never twice: a crash after media_publish is found again (container PUBLISHED) instead of re-posting", async () => {
    const p = await post([target({ status: "publishing", stepId: "c3", claimedAt: NOW.toISOString(), attempts: 1 })], { status: "publishing" });
    await only(p.id);
    const { f, d } = deps([
      { method: "GET", url: "/c3?fields=status_code", json: { status_code: "PUBLISHED" } },
      { method: "GET", url: "/1784/media?fields=id", json: { data: [{ id: "m-old", caption: "Something else", timestamp: NOW.toISOString() }, { id: "m3", caption: "Kennst du das?\n\n#lernen", permalink: "https://instagram.com/p/m3", timestamp: NOW.toISOString() }] } },
    ]);
    await publishDue("dotty", d);
    expect(f.done()).toBe(true);
    expect(f.calls.some((c) => c.url.includes("media_publish"))).toBe(false);
    expect((await posts.get("dotty", p.id))!.targets[0]).toMatchObject({ status: "published", externalId: "m3" });
  });

  test("Instagram's own 24 h limit reached: waits an hour, no attempt used", async () => {
    const p = await post([target({ format: "feed", assetId: imageId })], { kind: "image" });
    await only(p.id);
    const { d } = deps([
      { method: "POST", url: "/1784/media", check: (r) => expect((r.json as Record<string, string>).image_url).toMatch(/\.jpg$/), json: { id: "c4" } },
      { method: "GET", url: "/c4?fields=status_code", json: { status_code: "FINISHED" } },
      { method: "GET", url: "/content_publishing_limit", json: { data: [{ quota_usage: 100, config: { quota_total: 100 } }] } },
    ]);
    const r = await publishDue("dotty", d);
    expect(r.deferred).toHaveLength(1);
    const t = (await posts.get("dotty", p.id))!.targets[0]!;
    expect(t).toMatchObject({ attempts: 0, stepId: "c4" });
    expect(Date.parse(t.nextAttemptAt!) - NOW.getTime()).toBe(3_600_000);
    expect(t.note).toContain("100 API posts a day");
  });

  test("a failed container starts over (counts an attempt), with backoff", async () => {
    const p = await post([target({})]);
    await only(p.id);
    const { d } = deps([
      { method: "POST", url: "/1784/media", json: { id: "c5" } },
      { method: "GET", url: "/c5?fields=status_code", json: { status_code: "ERROR", status: "Error: video codec" } },
    ]);
    await publishDue("dotty", d);
    const t = (await posts.get("dotty", p.id))!.targets[0]!;
    expect(t).toMatchObject({ attempts: 1, stepId: null, status: "publishing" });
    expect(Date.parse(t.nextAttemptAt!) - NOW.getTime()).toBe(backoffMs(1));
    expect(t.error).toContain("couldn't process");
  });

  test("outages retry with backoff; the 5th failure is final; a 400 is final at once", async () => {
    const p = await post([target({ attempts: 4 })]);
    await only(p.id);
    // Creating calls run once (no automatic retry inside a pass): one call, then backoff.
    const fails = [{ method: "POST", url: "/1784/media", status: 503, text: "down" }];
    const { d } = deps(fails);
    expect((await publishDue("dotty", d)).failed).toEqual([`${p.id} on Instagram`]);
    expect((await posts.get("dotty", p.id))!.status).toBe("failed");

    const q = await post([target({})]);
    await only(q.id);
    const bad = deps([{ method: "POST", url: "/1784/media", status: 400, json: { error: { message: "Invalid parameter", code: 100 } } }]);
    await publishDue("dotty", bad.d);
    const t = (await posts.get("dotty", q.id))!.targets[0]!;
    expect(t.status).toBe("failed");
    expect(t.attempts).toBe(1);
    expect(t.error).toContain("Invalid parameter");
    expect(t.error).not.toContain("PAGE-TOKEN");
  });
});

describe("Facebook Page", () => {
  test("photo post whose last try ended unknown: found on the Page, not posted again", async () => {
    const p = await post([target({ platform: "facebook", format: "fb_post", assetId: imageId, status: "publishing", claimedAt: NOW.toISOString(), attempts: 1 })], { status: "publishing", kind: "image" });
    await only(p.id);
    const { f, d } = deps([{ method: "GET", url: "/100200300/published_posts", json: { data: [{ id: "100200300_9", message: "Kennst du das?\n\n#lernen #schule", created_time: NOW.toISOString(), permalink_url: "https://facebook.com/x" }] } }]);
    await publishDue("dotty", d);
    expect(f.done()).toBe(true);
    expect((await posts.get("dotty", p.id))!.targets[0]).toMatchObject({ status: "published", externalId: "100200300_9" });
  });

  test("photo post: one call with the public image link", async () => {
    const p = await post([target({ platform: "facebook", format: "fb_post", assetId: imageId })], { kind: "image" });
    await only(p.id);
    const { f, d } = deps([
      { method: "POST", url: "/100200300/photos", check: (r) => expect((r.json as Record<string, string>)).toMatchObject({ published: "true", caption: "Kennst du das?\n\n#lernen #schule" }), json: { id: "ph1", post_id: "100200300_10" } },
      { method: "GET", url: "/100200300_10?fields=permalink_url", json: { permalink_url: "https://facebook.com/y" } },
    ]);
    await publishDue("dotty", d);
    expect(f.done()).toBe(true);
    expect((await posts.get("dotty", p.id))!.targets[0]).toMatchObject({ status: "published", externalId: "100200300_10", permalink: "https://facebook.com/y" });
  });

  test("Reel: start → Facebook fetches the file → finish → ready", async () => {
    const p = await post([target({ platform: "facebook", format: "fb_reel" })]);
    await only(p.id);
    const { f, d } = deps([
      { method: "POST", url: "/100200300/video_reels", check: (r) => expect((r.json as Record<string, string>).upload_phase).toBe("start"), json: { video_id: "v1", upload_url: "https://rupload.facebook.com/video-upload/v26.0/v1" } },
      { method: "POST", url: "rupload.facebook.com/video-upload/v26.0/v1", check: (r) => expect(r.headers.file_url).toMatch(/\/api\/assets\/sm_.+\.mp4$/), json: { success: true } },
      { method: "POST", url: "/100200300/video_reels", check: (r) => expect(r.json as Record<string, string>).toMatchObject({ upload_phase: "finish", video_id: "v1", video_state: "PUBLISHED" }), json: { success: true } },
    ]);
    await publishDue("dotty", d);
    expect(f.done()).toBe(true);
    expect((await posts.get("dotty", p.id))!.targets[0]).toMatchObject({ status: "publishing", stepId: "vid:v1:finished" });
    const later = new Date(NOW.getTime() + 5 * 60_000);
    const two = deps([{ method: "GET", url: "/v1?fields=status", json: { status: { video_status: "ready", publishing_phase: { status: "complete" } }, permalink_url: "/reel/123" } }], { now: () => later });
    await publishDue("dotty", two.d);
    expect((await posts.get("dotty", p.id))!.targets[0]).toMatchObject({ status: "published", externalId: "v1", permalink: "https://www.facebook.com/reel/123" });
  });
});

describe("TikTok", () => {
  const choices = { privacyLevel: "SELF_ONLY", allowComment: true, allowDuet: false, allowStitch: false, disclose: false, yourBrand: false, brandedContent: false, isAigc: false };
  test("creator info → init with the chunk plan and the owner's choices → upload → status until complete", async () => {
    const p = await post([target({ platform: "tiktok", format: "tiktok_video" })], { tiktok: choices });
    await only(p.id);
    const { f, d } = deps([
      { method: "POST", url: "/v2/post/publish/creator_info/query/", check: (r) => expect(r.headers.authorization).toBe("Bearer TT-ACCESS"), json: { data: { creator_nickname: "Dotty", privacy_level_options: ["SELF_ONLY"], comment_disabled: false, duet_disabled: true, stitch_disabled: true, max_video_post_duration_sec: 600 }, error: { code: "ok" } } },
      {
        method: "POST",
        url: "/v2/post/publish/video/init/",
        check: (r) => {
          const j = r.json as { post_info: Record<string, unknown>; source_info: Record<string, unknown> };
          expect(j.source_info).toEqual({ source: "FILE_UPLOAD", video_size: 1000, chunk_size: 1000, total_chunk_count: 1 });
          expect(j.post_info).toMatchObject({ privacy_level: "SELF_ONLY", disable_comment: false, disable_duet: true, disable_stitch: true, title: "Kennst du das? #lernen #schule", is_aigc: false });
        },
        json: { data: { publish_id: "v_pub_1", upload_url: "https://open-upload.tiktokapis.com/upload/?id=1" }, error: { code: "ok" } },
      },
      { method: "PUT", url: "open-upload.tiktokapis.com/upload", check: (r) => expect(r.headers["content-range"]).toBe("bytes 0-999/1000"), status: 201, text: "" },
      { method: "POST", url: "/v2/post/publish/status/fetch/", json: { data: { status: "PROCESSING_UPLOAD" }, error: { code: "ok" } } },
    ]);
    await publishDue("dotty", d);
    expect(f.done()).toBe(true);
    expect((await posts.get("dotty", p.id))!.targets[0]).toMatchObject({ status: "publishing", stepId: "v_pub_1" });
    const later = new Date(NOW.getTime() + 60_000);
    const two = deps([{ method: "POST", url: "/status/fetch/", check: (r) => expect(r.json).toEqual({ publish_id: "v_pub_1" }), json: { data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [] }, error: { code: "ok" } } }], { now: () => later });
    await publishDue("dotty", two.d);
    expect((await posts.get("dotty", p.id))!.targets[0]).toMatchObject({ status: "published", externalId: "v_pub_1", note: "Posted as private (only you can see it)." });
  });

  test("TikTok's daily cap: waits a day", async () => {
    const p = await post([target({ platform: "tiktok", format: "tiktok_video", status: "publishing", stepId: "v_pub_2" })], { status: "publishing", tiktok: choices });
    await only(p.id);
    const { d } = deps([{ method: "POST", url: "/status/fetch/", json: { data: { status: "FAILED", fail_reason: "spam_risk_too_many_posts" }, error: { code: "ok" } } }]);
    expect((await publishDue("dotty", d)).deferred).toHaveLength(1);
    expect(Date.parse((await posts.get("dotty", p.id))!.targets[0]!.nextAttemptAt!) - NOW.getTime()).toBe(86_400_000);
  });
});

describe("never twice", () => {
  test("a timeout on the Facebook photo call is not retried in the same pass; the next pass looks the post up first", async () => {
    const p = await post([target({ platform: "facebook", format: "fb_post", assetId: imageId })], { kind: "image" });
    await only(p.id);
    const one = deps([{ method: "POST", url: "/100200300/photos", status: 504, text: "gateway timeout" }]);
    await publishDue("dotty", one.d);
    expect(one.f.calls).toHaveLength(1);
    const mid = (await posts.get("dotty", p.id))!.targets[0]!;
    expect(mid).toMatchObject({ status: "publishing", attempts: 1 });
    const later = new Date(NOW.getTime() + 60 * 60_000);
    const two = deps([{ method: "GET", url: "/100200300/published_posts", json: { data: [{ id: "100200300_77", message: "Kennst du das?\n\n#lernen #schule", created_time: NOW.toISOString() }] } }, { method: "GET", url: "/100200300_77", json: {} }].slice(0, 1), { now: () => later });
    await publishDue("dotty", two.d);
    expect(two.f.calls.some((c) => c.url.includes("/photos"))).toBe(false);
    expect((await posts.get("dotty", p.id))!.targets[0]).toMatchObject({ status: "published", externalId: "100200300_77" });
  });

  test("Instagram media_publish and TikTok init run once per pass", async () => {
    const p = await post([target({ status: "publishing", stepId: "c7", claimedAt: NOW.toISOString() })], { status: "publishing" });
    await only(p.id);
    const { f, d } = deps([
      { method: "GET", url: "/c7?fields=status_code", json: { status_code: "FINISHED" } },
      { method: "GET", url: "/content_publishing_limit", json: { data: [{ quota_usage: 0, config: { quota_total: 100 } }] } },
      { method: "POST", url: "/media_publish", status: 500, text: "oops" },
    ]);
    await publishDue("dotty", d);
    expect(f.calls.filter((c) => c.url.includes("media_publish"))).toHaveLength(1);
    expect((await posts.get("dotty", p.id))!.targets[0]).toMatchObject({ status: "publishing", stepId: "c7", attempts: 1 });
  });
});

describe("approval", () => {
  test("a post changed after approval doesn't go out: back to the owner", async () => {
    const p = await post([target({})]);
    await only(p.id);
    await posts.update("dotty", p.id, (x) => ({ ...x, targets: x.targets.map((t) => ({ ...t, caption: "Changed behind the owner's back" })) }));
    const { f, d } = deps([]);
    await publishDue("dotty", d);
    expect(f.calls).toHaveLength(0);
    expect((await posts.get("dotty", p.id))!).toMatchObject({ status: "waiting_approval", approvedBy: null, approvedHash: null });
  });

  test("no approval hash, no publishing", async () => {
    const p = await post([target({})], { approvedHash: null });
    await only(p.id);
    const { f, d } = deps([]);
    await publishDue("dotty", d);
    expect(f.calls).toHaveLength(0);
  });
});

describe("TikTok tokens and uploads", () => {
  test("upload URLs: only https on tiktokapis.com", () => {
    expect(isTikTokUploadUrl("https://open-upload.tiktokapis.com/upload/?id=1")).toBe(true);
    expect(isTikTokUploadUrl("http://open-upload.tiktokapis.com/upload")).toBe(false);
    expect(isTikTokUploadUrl("https://tiktokapis.com.evil.example/upload")).toBe(false);
    expect(isTikTokUploadUrl("https://evil.example/tiktokapis.com")).toBe(false);
    expect(isTikTokUploadUrl("https://user:pw@open-upload.tiktokapis.com/")).toBe(false);
    expect(chunkPlan(1).count).toBe(1);
  });

  test("an untrusted upload URL: nothing is uploaded", async () => {
    const choices = { privacyLevel: "SELF_ONLY", allowComment: false, allowDuet: false, allowStitch: false, disclose: false, yourBrand: false, brandedContent: false, isAigc: false };
    const p = await post([target({ platform: "tiktok", format: "tiktok_video" })], { tiktok: choices });
    await only(p.id);
    const { f, d } = deps([
      { method: "POST", url: "/creator_info/query/", json: { data: { privacy_level_options: ["SELF_ONLY"], max_video_post_duration_sec: 600 }, error: { code: "ok" } } },
      { method: "POST", url: "/video/init/", json: { data: { publish_id: "v_pub_9", upload_url: "https://evil.example/upload" }, error: { code: "ok" } } },
    ]);
    await publishDue("dotty", d);
    expect(f.calls.some((c) => c.method === "PUT")).toBe(false);
    expect((await posts.get("dotty", p.id))!.targets[0]!.status).toBe("failed");
  });

  test("refreshes one at a time and every step uses the stored (rotated) token", async () => {
    await accounts.updateTokens("dotty", "tiktok", { accessToken: "OLD", refreshToken: "R1", expiresAt: NOW.getTime() - 1, refreshExpiresAt: null });
    let refreshes = 0;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth/token/")) {
        refreshes++;
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("refresh_token")).toBe(refreshes === 1 ? "R1" : "R2");
        await new Promise((r) => setTimeout(r, 5));
        return new Response(JSON.stringify({ access_token: `NEW${refreshes}`, refresh_token: `R${refreshes + 1}`, expires_in: 86400 }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const { tiktokAccessToken } = await import("./tiktok");
    const app = { clientKey: "ck", clientSecret: "cs" };
    const [a, b] = await Promise.all([tiktokAccessToken("dotty", accounts, app, { fetch: fetchFn, now: () => NOW }), tiktokAccessToken("dotty", accounts, app, { fetch: fetchFn, now: () => NOW })]);
    expect(refreshes).toBe(1);
    expect([a, b]).toEqual(["NEW1", "NEW1"]);
    expect(((await accounts.get("dotty", "tiktok"))!.tokens as { refreshToken: string }).refreshToken).toBe("R2");
    await accounts.updateTokens("dotty", "tiktok", { accessToken: "TT-ACCESS", refreshToken: "TT-REFRESH", expiresAt: NOW.getTime() + 86_400_000, refreshExpiresAt: null });
  });
});

describe("rules", () => {
  test("kill switch / pause: nothing is called", async () => {
    const p = await post([target({})]);
    await only(p.id);
    const { f, d } = deps([], { stopped: true });
    expect(await publishDue("dotty", d)).toEqual({ published: [], failed: [], waiting: 0, deferred: [] });
    expect(f.calls).toHaveLength(0);
  });

  test("not before its time; not while another publisher holds the lease", async () => {
    const p = await post([target({})], { scheduledAt: new Date(NOW.getTime() + 3_600_000).toISOString() });
    await only(p.id);
    const { f, d } = deps([]);
    await publishDue("dotty", d);
    expect(f.calls).toHaveLength(0);
    const q = await post([target({ status: "publishing", stepId: "c9", leaseUntil: new Date(NOW.getTime() + 60_000).toISOString() })], { status: "publishing" });
    await only(q.id);
    await publishDue("dotty", d);
    expect(f.calls).toHaveLength(0);
  });

  test("at most 3 Instagram posts a day", async () => {
    for (let i = 0; i < 3; i++) await post([target({ status: "published", publishedAt: new Date(NOW.getTime() - i * 3_600_000).toISOString(), externalId: `m${i}` })], { status: "published" });
    const p = await post([target({})]);
    const { f, d } = deps([]);
    const r = await publishDue("dotty", d);
    expect(f.calls).toHaveLength(0);
    expect(r.deferred).toEqual([`${p.id} on Instagram`]);
    expect((await posts.get("dotty", p.id))!.targets[0]!.note).toContain("at most 3 times a day");
  });

  test("post status from its targets", () => {
    const base = { status: "approved" } as Post;
    expect(postStatusOf({ ...base, targets: [target({ status: "published" }), target({ status: "failed" })] })).toBe("published");
    expect(postStatusOf({ ...base, targets: [target({ status: "failed" })] })).toBe("failed");
    expect(postStatusOf({ ...base, targets: [target({ status: "publishing" }), target({})] })).toBe("publishing");
    expect(postStatusOf({ ...base, targets: [target({})] })).toBe("approved");
    expect(postStatusOf({ ...base, status: "declined", targets: [target({})] })).toBe("declined");
  });
});
