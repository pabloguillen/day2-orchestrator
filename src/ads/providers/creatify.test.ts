import { describe, expect, test } from "bun:test";
import { noSleep, scriptedFetch } from "../test-helpers";
import { CREATIFY_DEFAULT_USD_PER_CREDIT, createCreatify, creatifyFromEnv } from "./creatify";
import { ProviderError, type VideoJob } from "./video";

const creds = { apiId: "id_123", apiKey: "key_secret456", usdPerCredit: 0.15 };
const linkJob: VideoJob = { kind: "link_to_video", ratio: "9:16", durationSec: 20, link: "https://buddy.example", prompt: "friends who split bills", language: "de", appName: "Buddy" };
const avatarJob: VideoJob = { kind: "avatar_ad", ratio: "1:1", durationSec: 15, script: "Split any bill in ten seconds. Add it, pick who was there, done. Try Buddy free.", appName: "Buddy" };

const authed = (h: Record<string, string>) => {
  expect(h["x-api-id"]).toBe("id_123");
  expect(h["x-api-key"]).toBe("key_secret456");
};

describe("creatifyFromEnv", () => {
  test("missing env → null", () => {
    expect(creatifyFromEnv({})).toBeNull();
    expect(creatifyFromEnv({ CREATIFY_API_ID: "a" })).toBeNull();
    expect(creatifyFromEnv({ CREATIFY_API_KEY: "b" })).toBeNull();
  });
  test("reads creds with default and custom price", () => {
    expect(creatifyFromEnv({ CREATIFY_API_ID: "a", CREATIFY_API_KEY: "b" })?.usdPerCredit).toBe(CREATIFY_DEFAULT_USD_PER_CREDIT);
    const c = creatifyFromEnv({ CREATIFY_API_ID: "a", CREATIFY_API_KEY: "b", CREATIFY_USD_PER_CREDIT: "0.1495", CREATIFY_AVATAR_ID: "av1", CREATIFY_VOICE_ID: "v1" });
    expect(c).toMatchObject({ apiId: "a", apiKey: "b", usdPerCredit: 0.1495, avatarId: "av1", voiceId: "v1" });
    expect(creatifyFromEnv({ CREATIFY_API_ID: "a", CREATIFY_API_KEY: "b", CREATIFY_USD_PER_CREDIT: "abc" })?.usdPerCredit).toBe(CREATIFY_DEFAULT_USD_PER_CREDIT);
  });
});

describe("creatify link_to_video", () => {
  test("link → video → polls through pending states → result", async () => {
    const f = scriptedFetch([
      {
        method: "POST",
        url: "https://api.creatify.ai/api/links/",
        check: (r) => {
          authed(r.headers);
          expect(r.json).toEqual({ url: "https://buddy.example" });
        },
        json: { id: "link_1", url: "https://buddy.example", credits_used: 1, link: { id: "inner", title: "Buddy" } },
      },
      {
        method: "POST",
        url: "https://api.creatify.ai/api/link_to_videos/",
        check: (r) => {
          authed(r.headers);
          expect(r.json).toEqual({
            name: "day2 Buddy",
            link: "link_1",
            aspect_ratio: "9x16",
            video_length: 30,
            language: "de",
            target_audience: "friends who split bills",
            script_style: "DiscoveryWriter",
            visual_style: "AvatarBubbleTemplate",
          });
        },
        status: 201,
        json: { id: "ltv_1", status: "pending" },
      },
      { method: "GET", url: "/api/link_to_videos/ltv_1/", json: { id: "ltv_1", status: "in_queue" } },
      { method: "GET", url: "/api/link_to_videos/ltv_1/", json: { id: "ltv_1", status: "running", progress: "0.4" } },
      {
        method: "GET",
        url: "/api/link_to_videos/ltv_1/",
        json: { id: "ltv_1", status: "done", video_output: "https://cdn.creatify.ai/out.mp4", video_thumbnail: "https://cdn.creatify.ai/thumb.jpg", duration: 29, credits_used: 5 },
      },
    ]);
    const cr = createCreatify(creds, { fetch: f.fetch, sleep: noSleep });
    expect(cr.estimateUsd(linkJob)).toBe(0.9); // (1 + 5) × 0.15
    const res = await cr.generate(linkJob);
    expect(res).toEqual({ url: "https://cdn.creatify.ai/out.mp4", thumbnailUrl: "https://cdn.creatify.ai/thumb.jpg", durationSec: 29, aiPerson: true, costUsd: 0.9, providerJobId: "ltv_1" });
    expect(f.done()).toBe(true);
  });

  test("passes avatar, voice and script overrides", async () => {
    const f = scriptedFetch([
      { url: "/api/links/", json: { id: "l2", url: "https://buddy.example" } },
      {
        url: "/api/link_to_videos/",
        check: (r) => expect(r.json).toMatchObject({ override_avatar: "av1", override_voice: "v1", override_script: "Hello there", video_length: 60, aspect_ratio: "16x9", language: "en" }),
        json: { id: "ltv_2", status: "done", video_output: "https://cdn/x.mp4", credits_used: 10 },
      },
    ]);
    const res = await createCreatify({ ...creds, avatarId: "av1", voiceId: "v1" }, { fetch: f.fetch, sleep: noSleep }).generate({ ...linkJob, ratio: "16:9", durationSec: 90, script: "Hello there", language: undefined });
    expect(res.costUsd).toBe(1.65); // (1 + 10) × 0.15
  });

  test("failed status → ProviderError with the reason", async () => {
    const f = scriptedFetch([
      { url: "/api/links/", json: { id: "l3", url: "https://buddy.example" } },
      { url: "/api/link_to_videos/", json: { id: "ltv_3", status: "pending" } },
      { url: "/api/link_to_videos/ltv_3/", json: { id: "ltv_3", status: "failed", failed_reason: "Could not render" } },
    ]);
    const err = await createCreatify(creds, { fetch: f.fetch, sleep: noSleep }).generate(linkJob).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("Could not render");
    expect(err.retryable).toBe(true);
  });

  test("rejected status → non-retryable ProviderError", async () => {
    const f = scriptedFetch([
      { url: "/api/links/", json: { id: "l4", url: "https://buddy.example" } },
      { url: "/api/link_to_videos/", json: { id: "ltv_4", status: "rejected", failed_reason: "policy" } },
    ]);
    const err = await createCreatify(creds, { fetch: f.fetch, sleep: noSleep }).generate(linkJob).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
  });

  test("unknown status fails instead of guessing", async () => {
    const f = scriptedFetch([
      { url: "/api/links/", json: { id: "l5", url: "https://buddy.example" } },
      { url: "/api/link_to_videos/", json: { id: "ltv_5", status: "pending" } },
      { url: "/api/link_to_videos/ltv_5/", json: { id: "ltv_5", status: "mystery" } },
    ]);
    await expect(createCreatify(creds, { fetch: f.fetch, sleep: noSleep }).generate(linkJob)).rejects.toThrow(/unknown status/);
  });

  test("retries a 429 on link creation", async () => {
    const f = scriptedFetch([
      { url: "/api/links/", status: 429, text: "Too Many Requests", headers: { "retry-after": "2" } },
      { url: "/api/links/", json: { id: "l6", url: "https://buddy.example" } },
      { url: "/api/link_to_videos/", json: { id: "ltv_6", status: "done", video_output: "https://cdn/y.mp4", credits_used: 5 } },
    ]);
    const res = await createCreatify(creds, { fetch: f.fetch, sleep: noSleep }).generate(linkJob);
    expect(res.providerJobId).toBe("ltv_6");
    expect(f.done()).toBe(true);
  });

  test("persistent 429 → retryable ProviderError", async () => {
    const f = scriptedFetch([1, 2, 3].map(() => ({ url: "/api/links/", status: 429, text: "slow down" })));
    const err = await createCreatify(creds, { fetch: f.fetch, sleep: noSleep }).generate(linkJob).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
  });
});

describe("creatify avatar_ad", () => {
  test("picks a stock avatar, creates the lipsync, polls, maps result", async () => {
    const f = scriptedFetch([
      {
        method: "GET",
        url: "https://api.creatify.ai/api/personas/?style=presenter",
        check: (r) => authed(r.headers),
        json: [
          { id: "p_off", is_active: false },
          { id: "p_1", is_active: true, creator_name: "Ava" },
        ],
      },
      {
        method: "POST",
        url: "https://api.creatify.ai/api/lipsyncs/",
        check: (r) => {
          authed(r.headers);
          expect(r.json).toEqual({ name: "day2 Buddy", text: avatarJob.script, creator: "p_1", aspect_ratio: "1x1", no_caption: false, no_music: true });
        },
        status: 201,
        json: { id: "ls_1", status: "pending" },
      },
      { method: "GET", url: "/api/lipsyncs/ls_1/", json: { id: "ls_1", status: "running" } },
      { method: "GET", url: "/api/lipsyncs/ls_1/", json: { id: "ls_1", status: "done", output: "https://cdn.creatify.ai/avatar.mp4", video_thumbnail: "https://cdn/t.jpg", duration: 8, credits_used: 5 } },
    ]);
    const cr = createCreatify(creds, { fetch: f.fetch, sleep: noSleep });
    expect(cr.estimateUsd(avatarJob)).toBe(0.75);
    const res = await cr.generate(avatarJob);
    expect(res).toEqual({ url: "https://cdn.creatify.ai/avatar.mp4", thumbnailUrl: "https://cdn/t.jpg", durationSec: 8, aiPerson: true, costUsd: 0.75, providerJobId: "ls_1" });
    expect(f.done()).toBe(true);
  });

  test("uses the configured avatar and voice without listing personas", async () => {
    const f = scriptedFetch([
      { url: "/api/lipsyncs/", check: (r) => expect(r.json).toMatchObject({ creator: "av1", accent: "v1" }), json: { id: "ls_2", status: "done", output: "https://cdn/a.mp4", credits_used: 5 } },
    ]);
    const res = await createCreatify({ ...creds, avatarId: "av1", voiceId: "v1" }, { fetch: f.fetch, sleep: noSleep }).generate(avatarJob);
    expect(res.url).toBe("https://cdn/a.mp4");
  });

  test("failed lipsync → ProviderError", async () => {
    const f = scriptedFetch([
      { url: "/api/lipsyncs/", json: { id: "ls_3", status: "in_queue" } },
      { url: "/api/lipsyncs/ls_3/", json: { id: "ls_3", status: "failed", failed_reason: "Insufficient credits" } },
    ]);
    const err = await createCreatify({ ...creds, avatarId: "av1" }, { fetch: f.fetch, sleep: noSleep }).generate(avatarJob).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("Insufficient credits");
  });

  test("bad input fails before any call", async () => {
    const f = scriptedFetch([]);
    const cr = createCreatify(creds, { fetch: f.fetch, sleep: noSleep });
    await expect(cr.generate({ ...avatarJob, script: " " })).rejects.toBeInstanceOf(ProviderError);
    await expect(cr.generate({ ...linkJob, link: undefined })).rejects.toBeInstanceOf(ProviderError);
    await expect(cr.generate({ ...linkJob, kind: "image_to_video" })).rejects.toBeInstanceOf(ProviderError);
    expect(f.calls.length).toBe(0);
  });
});
