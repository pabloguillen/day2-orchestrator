import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileAssetStore, type AssetStore } from "../ads/assets";
import { noSleep, scriptedFetch, type Expect } from "../ads/test-helpers";
import { loadGrowthConfig } from "../growth-config";
import { publishDue } from "./publish";
import { fileMediaLinks, fileSocialAccounts, fileSocialPosts, type MediaLinkStore, type SocialAccountStore, type SocialPostStore } from "./store";
import { contentHash, type Post, type Target } from "./types";
import { draftPosts, studioFormats, type DraftDeps } from "./make";
import { emptyLearnings } from "./state";
import type { StudioOut } from "../creative/studio";
import type { ResolvedKit } from "../creative/brand-kit";

/**
 * Carousels end to end against scripted fakes: Instagram carousel
 * containers (items → CAROUSEL → publish), Facebook multi-photo posts
 * (unpublished photos → one feed post), TikTok photo mode (PULL_FROM_URL
 * from day2's public media links) — and drafting designed posts with
 * variants from the studio.
 */

let dir: string;
let posts: SocialPostStore;
let accounts: SocialAccountStore;
let links: MediaLinkStore;
let assets: AssetStore;
const slides: string[] = [];
const NOW = new Date("2026-11-07T18:00:00Z");
const savedKey = process.env.DAY2_SECRETS_KEY;

beforeAll(async () => {
  process.env.DAY2_SECRETS_KEY = Buffer.alloc(32, 5).toString("base64");
  dir = mkdtempSync(join(tmpdir(), "day2-carousel-"));
  posts = fileSocialPosts(join(dir, "posts.json"));
  accounts = fileSocialAccounts(join(dir, "accounts.json"));
  links = fileMediaLinks(join(dir, "links.json"));
  assets = fileAssetStore(join(dir, "assets"), "https://day2.test");
  for (let k = 0; k < 4; k++) {
    writeFileSync(join(dir, `s${k}.jpg`), new Uint8Array(200).fill(k));
    slides.push((await assets.put(join(dir, `s${k}.jpg`), { appId: "dotty", purpose: "social:sg_c", label: `slide ${k + 1}`, kind: "image", ratio: "4:5", width: 1080, height: 1350, mime: "image/jpeg", source: "motion_template", aiGenerated: false, aiPerson: false })).id);
  }
  await accounts.save({ appId: "dotty", network: "meta", meta: { pageId: "100200300", pageName: "Dotty", igUserId: "1784", igUsername: "dotty.app", igAccountType: null, scopes: ["instagram_content_publish", "pages_manage_posts"] }, tokens: { pageToken: "PAGE-TOKEN-SECRET" }, connectedBy: "Pablo" });
  await accounts.save({ appId: "dotty", network: "tiktok", meta: { openId: "o1", nickname: "Dotty", username: "dotty", scopes: ["video.publish", "video.upload", "video.list"] }, tokens: { accessToken: "TT-ACCESS", refreshToken: "TT-REFRESH", expiresAt: NOW.getTime() + 86_400_000, refreshExpiresAt: null }, connectedBy: "Pablo" });
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedKey === undefined) delete process.env.DAY2_SECRETS_KEY;
  else process.env.DAY2_SECRETS_KEY = savedKey;
});

let n = 0;
const target = (over: Partial<Target>): Target => ({ platform: "instagram", format: "ig_carousel", assetId: slides[0]!, assetIds: [...slides], caption: "So geht Dotty", hashtags: ["freunde"], status: "pending", attempts: 0, metrics: [], ...over });
async function post(targets: Target[], over: Partial<Post> = {}): Promise<Post> {
  const iso = NOW.toISOString();
  const p = { id: `sp_car${++n}`, appId: "dotty", group: "sg_c", status: "approved", kind: "carousel", language: "de", idea: { topic: "feature", hook: "how_to", title: "So geht Dotty", brandAngle: null, trend: null }, source: { arm: "motion-graphics-short-video", armKey: "x", experimentId: null, made: "motion_template" }, targets, scheduledAt: new Date(NOW.getTime() - 60_000).toISOString(), timeSlot: "evening", timeWhy: null, safety: { ok: true, issues: [], checkedAt: iso }, tiktok: null, costCredits: 0, createdAt: iso, updatedAt: iso, ...over } as Post;
  return posts.insert({ ...p, approvedHash: contentHash(p) });
}
async function only(id: string) {
  for (const p of await posts.due("dotty")) if (p.id !== id) await posts.update("dotty", p.id, (x) => ({ ...x, status: "failed", targets: x.targets.map((t) => ({ ...t, status: t.status === "published" ? t.status : ("failed" as const), publishedAt: t.publishedAt ? new Date(NOW.getTime() - 3 * 86_400_000).toISOString() : null })) }));
}
function deps(script: Expect[]) {
  const f = scriptedFetch(script);
  return { f, d: { posts, accounts, links, assets, publicUrl: "https://day2.test", meta: { appSecret: "s", apiVersion: "v26.0" }, tiktok: { clientKey: "ck", clientSecret: "cs" }, platformDeps: { fetch: f.fetch, sleep: noSleep, now: () => NOW }, now: () => NOW, stopped: false, budget: loadGrowthConfig("/nonexistent/.day2-budget.json").budget, ledger: [] } satisfies Parameters<typeof publishDue>[1] };
}
const SLIDE_URL = /^https:\/\/day2\.test\/api\/assets\/sm_[A-Za-z0-9_-]{43}\.jpg$/;

describe("Instagram carousel", () => {
  test("one item container per slide → CAROUSEL container with the children and caption → publish", async () => {
    const p = await post([target({})]);
    await only(p.id);
    const items = slides.map((_, k) => ({ method: "POST", url: "/1784/media", check: (r: { json: unknown }) => {
      const j = r.json as Record<string, string>;
      expect(j.is_carousel_item).toBe("true");
      expect(j.image_url).toMatch(SLIDE_URL);
      expect(j.caption).toBeUndefined();
    }, json: { id: `it${k}` } }));
    const { f, d } = deps([
      ...items,
      { method: "POST", url: "/1784/media", check: (r) => {
        const j = r.json as Record<string, string>;
        expect(j.media_type).toBe("CAROUSEL");
        expect(j.children).toBe("it0,it1,it2,it3");
        expect(j.caption).toBe("So geht Dotty\n\n#freunde");
      }, json: { id: "car1" } },
      { method: "GET", url: "/car1?fields=status_code", json: { status_code: "FINISHED" } },
      { method: "GET", url: "/1784/content_publishing_limit", json: { data: [{ quota_usage: 1, config: { quota_total: 100 } }] } },
      { method: "POST", url: "/1784/media_publish", check: (r) => expect((r.json as Record<string, string>).creation_id).toBe("car1"), json: { id: "m9" } },
      { method: "GET", url: "/m9?fields=permalink", json: { permalink: "https://www.instagram.com/p/xyz/" } },
    ]);
    const r = await publishDue("dotty", d);
    expect(f.done()).toBe(true);
    expect(r.published).toHaveLength(1);
    // Slides are linked in the order the owner set.
    const urls = f.calls.slice(0, 4).map((c) => (c.json as Record<string, string>).image_url);
    expect(new Set(urls).size).toBe(4);
    expect((await posts.get("dotty", p.id))!.targets[0]).toMatchObject({ status: "published", externalId: "m9", stepId: "car1" });
  });

  test("a carousel with one slide is refused with a clear reason (not retried)", async () => {
    const p = await post([target({ assetIds: [slides[0]!] })]);
    await only(p.id);
    const { d } = deps([]);
    const r = await publishDue("dotty", d);
    expect(r.failed).toHaveLength(1);
    expect((await posts.get("dotty", p.id))!.targets[0]!.error).toContain("2–10 slides");
  });

  test("a missing slide stops the post before anything is sent", async () => {
    const p = await post([target({ assetIds: [slides[0]!, "as_missingmissingmissing00"] })]);
    await only(p.id);
    const { f, d } = deps([]);
    await publishDue("dotty", d);
    expect(f.calls).toHaveLength(0);
    expect((await posts.get("dotty", p.id))!.targets[0]!.error).toContain("slides is missing");
  });
});

describe("Facebook photos", () => {
  test("each photo unpublished, then one Page post with every photo attached", async () => {
    const p = await post([target({ platform: "facebook", format: "fb_album" })]);
    await only(p.id);
    const { f, d } = deps([
      ...slides.map((_, k) => ({ method: "POST", url: "/100200300/photos", check: (r: { json: unknown }) => {
        expect((r.json as Record<string, string>).published).toBe("false");
        expect((r.json as Record<string, string>).url).toMatch(SLIDE_URL);
      }, json: { id: `ph${k}` } })),
      { method: "POST", url: "/100200300/feed", check: (r) => {
        const j = r.json as Record<string, string>;
        expect(j.message).toBe("So geht Dotty\n\n#freunde");
        expect(JSON.parse(j["attached_media[0]"]!)).toEqual({ media_fbid: "ph0" });
        expect(JSON.parse(j["attached_media[3]"]!)).toEqual({ media_fbid: "ph3" });
      }, json: { id: "100200300_77" } },
      { method: "GET", url: "/100200300_77?fields=permalink_url", json: { permalink_url: "https://facebook.com/x" } },
    ]);
    const r = await publishDue("dotty", d);
    expect(f.done()).toBe(true);
    expect(r.published).toHaveLength(1);
  });
});

describe("TikTok photo mode", () => {
  test("PULL_FROM_URL with day2's public slide links, cover 0, then status until complete", async () => {
    const p = await post([target({ platform: "tiktok", format: "tiktok_photo" })], { tiktok: { privacyLevel: "SELF_ONLY", allowComment: false, allowDuet: false, allowStitch: false, disclose: false, yourBrand: false, brandedContent: false, isAigc: false } });
    await only(p.id);
    const { f, d } = deps([
      { method: "POST", url: "/v2/post/publish/creator_info/query/", json: { data: { creator_nickname: "Dotty", privacy_level_options: ["SELF_ONLY"], max_video_post_duration_sec: 60 }, error: { code: "ok" } } },
      { method: "POST", url: "/v2/post/publish/content/init/", check: (r) => {
        const j = r.json as { media_type: string; post_mode: string; source_info: { source: string; photo_images: string[]; photo_cover_index: number }; post_info: Record<string, unknown> };
        expect(j.media_type).toBe("PHOTO");
        expect(j.post_mode).toBe("DIRECT_POST");
        expect(j.source_info.source).toBe("PULL_FROM_URL");
        expect(j.source_info.photo_images).toHaveLength(4);
        for (const u of j.source_info.photo_images) expect(u).toMatch(SLIDE_URL);
        expect(j.source_info.photo_cover_index).toBe(0);
        expect(j.post_info.privacy_level).toBe("SELF_ONLY");
        expect(String(j.post_info.title).length).toBeLessThanOrEqual(90);
        expect(r.headers.authorization).toBe("Bearer TT-ACCESS");
      }, json: { data: { publish_id: "pub_1" }, error: { code: "ok" } } },
    ]);
    const r1 = await publishDue("dotty", d);
    expect(f.done()).toBe(true);
    expect(r1.waiting).toBe(1);
    expect((await posts.get("dotty", p.id))!.targets[0]!.stepId).toBe("pub_1");
    const later = new Date(NOW.getTime() + 5 * 60_000);
    const two = deps([{ method: "POST", url: "/v2/post/publish/status/fetch/", json: { data: { status: "PUBLISH_COMPLETE" }, error: { code: "ok" } } }]);
    two.d.now = () => later;
    const r2 = await publishDue("dotty", two.d);
    expect(r2.published).toHaveLength(1);
    expect((await posts.get("dotty", p.id))!.targets[0]!.note).toContain("private");
  });

  test("an unverified domain is a final error with TikTok's reason", async () => {
    const p = await post([target({ platform: "tiktok", format: "tiktok_photo" })], { tiktok: { privacyLevel: "SELF_ONLY", allowComment: false, allowDuet: false, allowStitch: false, disclose: false, yourBrand: false, brandedContent: false, isAigc: false } });
    await only(p.id);
    const { d } = deps([
      { method: "POST", url: "/v2/post/publish/creator_info/query/", json: { data: { privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } } },
      { method: "POST", url: "/v2/post/publish/content/init/", status: 403, json: { error: { code: "url_ownership_unverified", message: "verify the domain" } } },
    ]);
    const r = await publishDue("dotty", d);
    expect(r.failed).toHaveLength(1);
    expect((await posts.get("dotty", p.id))!.targets[0]!.error).toContain("url_ownership_unverified");
  });
});

// ---------------------------------------------------------------- drafting designed posts

describe("designed posts from the studio", () => {
  test("placements: slides where the platform takes them, else the video", () => {
    expect(studioFormats("instagram", { slides: true, video: true })).toBe("ig_carousel");
    expect(studioFormats("facebook", { slides: true, video: true })).toBe("fb_album");
    expect(studioFormats("tiktok", { slides: true, video: true })).toBe("tiktok_video");
    expect(studioFormats("tiktok", { slides: true, video: false })).toBe("tiktok_photo");
    expect(studioFormats("instagram", { slides: false, video: true })).toBe("reel");
  });

  test("two variants → two groups in one variant set; carousel on Meta, video on TikTok; score and why on the post", async () => {
    const vid = slides[0]!;
    const fakeStudio: DraftDeps["studio"] = async (o) => {
      expect(o.variants).toBe(2);
      expect(o.forced).toBe("how-it-works");
      const v = (template: "how-it-works" | "problem-solution", score: number): StudioOut["variants"][number] => ({
        template,
        templateWhy: "you asked for it",
        shots: { template, hook: "So geht Dotty", kicker: null, steps: [{ headline: "Karte", caption: null, screen: 0, focus: null, tap: null, sticker: null }], problem: [], pov: null, cta: "Link in Bio", endLine: "", version: null, broll: null },
        critique: { rubricVersion: 1, scores: { hook: 8 }, score, verdict: "approve", issues: [], fixes: [], why: "Real screens in German, one step per slide.", bySight: true },
        rounds: 1,
        video: { id: vid } as never,
        cover: null,
        slides: { "4:5": slides.map((id) => ({ id }) as never), "1:1": [] },
      });
      return { variants: [v("how-it-works", 8.1), v("problem-solution", 7.4)], dropped: [], warning: null, kit: {} as ResolvedKit };
    };
    const r = await draftPosts({ id: "dotty", name: "Dotty" }, { purpose: "Freunde auf der Karte", targetUsers: "Jugendliche in Deutschland", featureMap: ["Karte"], toneOfVoice: null, styleGuide: null } as never, {
      posts,
      assets,
      platforms: ["instagram", "facebook", "tiktok"],
      write: async () => `SOCIAL_POST_JSON:\n${JSON.stringify({ topic: "feature", hook: "how_to", title: "So geht Dotty", cta: "Link in Bio", lines: ["Karte", "Momente"], captions: { instagram: "So geht Dotty 📍", facebook: "So geht Dotty", tiktok: "So geht Dotty" }, hashtags: { instagram: ["freunde"], facebook: [], tiktok: ["freunde"] }, claims: [] })}`,
      screens: async () => [],
      pageUrl: null,
      creator: null,
      memory: "",
      avoid: [],
      worked: [],
      trends: [],
      competitors: [],
      learnings: emptyLearnings(),
      allocator: { arms: [] } as never,
      language: "de",
      country: null,
      link: null,
      autoPublish: false,
      now: NOW,
      studio: fakeStudio,
      forced: "how-it-works",
      variants: 2,
    });
    expect(r.posts).toHaveLength(4);
    const sets = new Set(r.posts.map((p) => p.creative!.variant!.set));
    expect(sets.size).toBe(1);
    expect(new Set(r.posts.map((p) => p.group)).size).toBe(2);
    const meta = r.posts.find((p) => p.targets.some((t) => t.platform === "instagram"))!;
    expect(meta.kind).toBe("carousel");
    expect(meta.targets.map((t) => t.format)).toEqual(["ig_carousel", "fb_album"]);
    expect(meta.targets[0]!.assetIds).toEqual(slides);
    expect(meta.creative).toMatchObject({ template: "how-it-works", score: 8.1, why: "Real screens in German, one step per slide.", variant: { index: 0, of: 2 } });
    const tt = r.posts.find((p) => p.targets.some((t) => t.platform === "tiktok"))!;
    expect(tt.targets[0]!.format).toBe("tiktok_video");
    // Variants always wait for the owner's pick.
    expect(r.posts.every((p) => p.status === "waiting_approval")).toBe(true);
  });

  test("every variant dropped by the critique → no post, the reason in the result", async () => {
    const r = await draftPosts({ id: "dotty", name: "Dotty" }, { purpose: "x", targetUsers: "y", featureMap: ["Karte"], toneOfVoice: null, styleGuide: null } as never, {
      posts, assets, platforms: ["instagram"], screens: async () => [], pageUrl: null, creator: null, memory: "", avoid: [], worked: [], trends: [], competitors: [], learnings: emptyLearnings(), allocator: { arms: [] } as never, language: "de", country: null, link: null, autoPublish: false, now: NOW,
      write: async () => `SOCIAL_POST_JSON:\n${JSON.stringify({ topic: "feature", hook: "how_to", title: "So geht Dotty", captions: { instagram: "x", facebook: "x", tiktok: "x" }, hashtags: {}, lines: [] })}`,
      studio: async () => ({ variants: [], dropped: ["How it works: the design critique didn't pass after 3 rounds (5.2/10)"], warning: null, kit: {} as ResolvedKit }),
      forced: "how-it-works",
    });
    expect(r.posts).toHaveLength(0);
    expect(r.dropped).toContain("design critique");
  });
});
