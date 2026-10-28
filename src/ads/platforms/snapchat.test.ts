import { describe, expect, test } from "bun:test";
import { scriptedFetch, testAsset, testImage, testSpec, noSleep, type Expect } from "../test-helpers";
import { PlatformError, type Launched } from "../types";
import { create, credentialsFromEnv, info, type SnapchatCreds } from "./snapchat";

const creds: SnapchatCreds = { clientId: "cid", clientSecret: "csecret", refreshToken: "rtok", adAccountId: "acct1" };
const NOW = new Date("2026-10-28T12:00:00.000Z");
const identity = { platform: "snapchat" as const, ref: "prof_1", displayName: "Buddy" };

const tokenStep: Expect = {
  method: "POST",
  url: "https://accounts.snapchat.com/login/oauth2/access_token",
  check: (r) => {
    expect(r.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(r.json).toEqual({ grant_type: "refresh_token", client_id: "cid", client_secret: "csecret", refresh_token: "rtok" });
    expect(r.headers.authorization).toBeUndefined();
  },
  json: { access_token: "atok", token_type: "Bearer", expires_in: 3600, refresh_token: "rtok" },
};
const bearer = (r: { headers: Record<string, string> }) => expect(r.headers.authorization).toBe("Bearer atok");
const ok = { request_status: "SUCCESS", request_id: "r1" };

function make(script: Expect[], bytes = new Uint8Array([1, 2, 3])) {
  const f = scriptedFetch(script);
  const platform = create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW, readAsset: async () => bytes });
  return { f, platform };
}

const accountStep: Expect = { method: "GET", url: "/v1/adaccounts/acct1", check: bearer, json: { ...ok, adaccounts: [{ sub_request_status: "SUCCESS", adaccount: { id: "acct1", currency: "USD" } }] } };

function mediaSteps(type: "VIDEO" | "IMAGE", mediaId: string, opts: { ai?: boolean } = {}): Expect[] {
  return [
    {
      method: "POST",
      url: "/v1/adaccounts/acct1/media",
      check: (r) => {
        bearer(r);
        expect(r.json).toEqual({
          media: [{ name: "day2 Buddy B-4 B-4-v1", type, ad_account_id: "acct1", ...(opts.ai ? { ai_content_source: "USER_AI_GEN" } : {}) }],
        });
      },
      json: { ...ok, media: [{ sub_request_status: "SUCCESS", media: { id: mediaId, type, media_status: "PENDING_UPLOAD" } }] },
    },
    {
      method: "POST",
      url: `/v1/media/${mediaId}/upload`,
      check: (r) => {
        bearer(r);
        expect(r.body).toBeInstanceOf(FormData);
        const file = (r.body as FormData).get("file") as File;
        expect(file).toBeInstanceOf(Blob);
        expect(file.size).toBe(3);
      },
      json: { ...ok, result: { id: mediaId, media_status: "PENDING_UPLOAD" } },
    },
    { method: "GET", url: `/v1/media/${mediaId}`, json: { ...ok, media: [{ sub_request_status: "SUCCESS", media: { id: mediaId, media_status: "PENDING_UPLOAD" } }] } },
    { method: "GET", url: `/v1/media/${mediaId}`, json: { ...ok, media: [{ sub_request_status: "SUCCESS", media: { id: mediaId, media_status: "READY" } }] } },
  ];
}

function restSteps(mediaId: string, cta = "SIGN_UP"): Expect[] {
  return [
    {
      method: "POST",
      url: "/v1/adaccounts/acct1/creatives",
      check: (r) =>
        expect(r.json).toEqual({
          creatives: [
            {
              ad_account_id: "acct1",
              name: "day2 Buddy B-4 B-4-v1",
              type: "WEB_VIEW",
              top_snap_media_id: mediaId,
              headline: "Split a dinner bill in 10 seconds",
              brand_name: "Buddy",
              shareable: true,
              call_to_action: cta,
              profile_properties: { profile_id: "prof_1" },
              web_view_properties: { url: "https://buddy.example/go/split?d2=B-4.x", block_preload: true },
            },
          ],
        }),
      json: { ...ok, creatives: [{ sub_request_status: "SUCCESS", creative: { id: "cr_1", review_status: "PENDING_REVIEW" } }] },
    },
    {
      method: "POST",
      url: "/v1/adaccounts/acct1/campaigns",
      check: (r) =>
        expect(r.json).toEqual({
          campaigns: [
            {
              name: "day2 Buddy B-4",
              ad_account_id: "acct1",
              status: "PAUSED",
              start_time: "2026-10-28T12:00:00.000Z",
              buy_model: "AUCTION",
              objective_v2_properties: { objective_v2_type: "TRAFFIC" },
            },
          ],
        }),
      json: { ...ok, campaigns: [{ sub_request_status: "SUCCESS", campaign: { id: "camp_1", status: "PAUSED" } }] },
    },
    {
      method: "POST",
      url: "/v1/campaigns/camp_1/adsquads",
      check: (r) =>
        expect(r.json).toEqual({
          adsquads: [
            {
              name: "day2 Buddy B-4",
              campaign_id: "camp_1",
              type: "SNAP_ADS",
              status: "ACTIVE",
              targeting: { regulated_content: false, geos: [{ country_code: "de" }], demographics: [{ min_age: "18", languages: ["de"] }] },
              placement_v2: { config: "AUTOMATIC" },
              billing_event: "IMPRESSION",
              optimization_goal: "SWIPES",
              bid_strategy: "AUTO_BID",
              delivery_constraint: "DAILY_BUDGET",
              daily_budget_micro: 20_000_000,
            },
          ],
        }),
      json: { ...ok, adsquads: [{ sub_request_status: "SUCCESS", adsquad: { id: "sq_1" } }] },
    },
    {
      method: "POST",
      url: "/v1/adsquads/sq_1/ads",
      check: (r) =>
        expect(r.json).toEqual({
          ads: [{ ad_squad_id: "sq_1", creative_id: "cr_1", name: "day2 Buddy B-4 B-4-v1", type: "REMOTE_WEBPAGE", status: "ACTIVE" }],
        }),
      json: { ...ok, ads: [{ sub_request_status: "SUCCESS", ad: { id: "ad_1", review_status: "PENDING" } }] },
    },
    {
      method: "PATCH",
      url: "/v1/adaccounts/acct1/campaigns/camp_1",
      check: (r) => {
        expect(r.headers["content-type"]).toBe("application/json-patch+json");
        expect(r.json).toEqual([{ op: "replace", path: "/status", value: "ACTIVE" }]);
      },
      json: { ...ok, campaigns: [{ sub_request_status: "SUCCESS", campaign: { id: "camp_1", status: "ACTIVE" } }] },
    },
  ];
}

const launched: Launched = { platform: "snapchat", campaignId: "camp_1", refs: { adAccountId: "acct1", adSquadId: "sq_1" }, ads: { "B-4-v1": "ad_1" } };

describe("snapchat", () => {
  test("info", () => {
    expect(info.id).toBe("snapchat");
    expect(info.formats.every((f) => f.ratio === "9:16")).toBe(true);
    expect(info.identity).toBe("app_account");
    expect(info.minDailyUsd).toBe(5);
  });

  test("credentialsFromEnv", () => {
    const env = { SNAP_CLIENT_ID: "a", SNAP_CLIENT_SECRET: "b", SNAP_REFRESH_TOKEN: "c", SNAP_AD_ACCOUNT_ID: "d" };
    expect(credentialsFromEnv(env)).toEqual({ clientId: "a", clientSecret: "b", refreshToken: "c", adAccountId: "d" });
    expect(credentialsFromEnv({ ...env, SNAP_REFRESH_TOKEN: undefined })).toBeNull();
    expect(credentialsFromEnv({ ...env, SNAP_AD_ACCOUNT_ID: "" })).toBeNull();
    expect(credentialsFromEnv({})).toBeNull();
  });

  test("OAuth refresh happens once and the token is reused", async () => {
    const { f, platform } = make([
      tokenStep,
      { method: "PATCH", url: "/v1/adaccounts/acct1/campaigns/camp_1", check: bearer, json: ok },
      { method: "PATCH", url: "/v1/adaccounts/acct1/campaigns/camp_1", check: bearer, json: ok },
    ]);
    await platform.pause(launched);
    await platform.resume(launched);
    expect(f.done()).toBe(true);
  });

  test("launch with a 9:16 video", async () => {
    const { f, platform } = make([tokenStep, accountStep, ...mediaSteps("VIDEO", "md_v"), ...restSteps("md_v")]);
    const out = await platform.launch(testSpec({ identity }));
    expect(out).toEqual(launched);
    expect(f.done()).toBe(true);
  });

  test("launch with a 9:16 image, AI-labelled, learn_more CTA", async () => {
    const img = testImage({ ratio: "9:16", width: 1080, height: 1920, mime: "image/jpeg", aiGenerated: true });
    const spec = testSpec({ identity, aiContent: true });
    spec.creatives[0] = { ...spec.creatives[0]!, asset: img, copy: { ...spec.creatives[0]!.copy, cta: "learn_more" } };
    const { f, platform } = make([tokenStep, accountStep, ...mediaSteps("IMAGE", "md_i", { ai: true }), ...restSteps("md_i", "MORE")]);
    await platform.launch(spec);
    expect(f.done()).toBe(true);
  });

  test("large video uses chunked upload", async () => {
    const big = new Uint8Array(40_000_000);
    const spec = testSpec({ identity });
    spec.creatives[0] = { ...spec.creatives[0]!, asset: testAsset({ bytes: big.byteLength }) };
    const [create1, , ...pollSteps] = mediaSteps("VIDEO", "md_v");
    const { f, platform } = make(
      [
        tokenStep,
        accountStep,
        create1!,
        {
          method: "POST",
          url: "/v1/media/md_v/multipart-upload-v2?action=INIT",
          check: (r) => {
            const fd = r.body as FormData;
            expect(fd.get("file_name")).toBe("as_video1.mp4");
            expect(fd.get("file_size")).toBe("40000000");
            expect(fd.get("number_of_parts")).toBe("2");
          },
          json: { ...ok, upload_id: "up1", add_path: "/v1/media/md_v/multipart-upload-v2?action=ADD", finalize_path: "/v1/media/md_v/multipart-upload-v2?action=FINALIZE" },
        },
        {
          method: "POST",
          url: "https://adsapi.snapchat.com/v1/media/md_v/multipart-upload-v2?action=ADD",
          check: (r) => {
            const fd = r.body as FormData;
            expect(fd.get("part_number")).toBe("1");
            expect(fd.get("upload_id")).toBe("up1");
            expect((fd.get("file") as File).size).toBe(31_000_000);
          },
          json: ok,
        },
        {
          method: "POST",
          url: "action=ADD",
          check: (r) => {
            expect((r.body as FormData).get("part_number")).toBe("2");
            expect(((r.body as FormData).get("file") as File).size).toBe(9_000_000);
          },
          json: ok,
        },
        { method: "POST", url: "action=FINALIZE", check: (r) => expect((r.body as FormData).get("upload_id")).toBe("up1"), json: ok },
        ...pollSteps,
        ...restSteps("md_v"),
      ],
      big,
    );
    await platform.launch(spec);
    expect(f.done()).toBe(true);
  });

  test("launch failure deletes what was created and rethrows PlatformError", async () => {
    const rest = restSteps("md_v");
    const { f, platform } = make([
      tokenStep,
      accountStep,
      ...mediaSteps("VIDEO", "md_v"),
      rest[0]!,
      rest[1]!,
      rest[2]!,
      { method: "POST", url: "/v1/adsquads/sq_1/ads", status: 400, json: { request_status: "ERROR", display_message: "bad creative" } },
      { method: "DELETE", url: "/v1/adsquads/sq_1", json: ok },
      { method: "DELETE", url: "/v1/campaigns/camp_1", json: ok },
    ]);
    const e = await platform.launch(testSpec({ identity })).catch((x) => x);
    expect(e).toBeInstanceOf(PlatformError);
    expect(String(e.message)).toContain("bad creative");
    expect(f.done()).toBe(true);
  });

  test("launch refuses without identity or with a non-9:16 asset, before any call", async () => {
    const { f, platform } = make([]);
    await expect(platform.launch(testSpec())).rejects.toBeInstanceOf(PlatformError);
    const spec = testSpec({ identity });
    spec.creatives[0] = { ...spec.creatives[0]!, asset: testImage() };
    await expect(platform.launch(spec)).rejects.toThrow("9:16");
    await expect(platform.launch(testSpec({ identity, dailyBudgetUsd: 2 }))).rejects.toThrow("at least $5");
    expect(f.calls.length).toBe(0);
  });

  test("stats: micro → USD, swipes as clicks, rejection", async () => {
    const { f, platform } = make([
      tokenStep,
      {
        method: "GET",
        url: "/v1/campaigns/camp_1/stats",
        check: (r) => {
          const u = new URL(r.url);
          expect(u.searchParams.get("granularity")).toBe("TOTAL");
          expect(u.searchParams.get("fields")).toBe("impressions,swipes,spend");
          expect(u.searchParams.get("breakdown")).toBe("ad");
        },
        json: {
          ...ok,
          total_stats: [
            {
              sub_request_status: "SUCCESS",
              total_stat: {
                id: "camp_1",
                type: "CAMPAIGN",
                granularity: "TOTAL",
                stats: { impressions: 1200, swipes: 34, spend: 12_345_678 },
                breakdown_stats: { ad: [{ id: "ad_1", type: "AD", granularity: "TOTAL", stats: { impressions: 1200, swipes: 34, spend: 12_345_678 } }] },
              },
            },
          ],
        },
      },
      { method: "GET", url: "/v1/campaigns/camp_1", json: { ...ok, campaigns: [{ sub_request_status: "SUCCESS", campaign: { id: "camp_1", status: "ACTIVE" } }] } },
      {
        method: "GET",
        url: "/v1/adsquads/sq_1/ads",
        json: { ...ok, ads: [{ sub_request_status: "SUCCESS", ad: { id: "ad_1", status: "ACTIVE", review_status: "REJECTED", review_status_reasons: ["Misleading claim"] } }] },
      },
    ]);
    const s = await platform.stats(launched);
    expect(s).toEqual({
      spendUsd: 12.35,
      impressions: 1200,
      clicks: 34,
      status: "rejected",
      rejection: "Misleading claim",
      byCreative: { "B-4-v1": { spendUsd: 12.35, impressions: 1200, clicks: 34, status: "rejected" } },
    });
    expect(f.done()).toBe(true);
  });

  test("stats: approved + active campaign is active; pending is in_review", async () => {
    const statsStep: Expect = { method: "GET", url: "/stats", json: { ...ok, total_stats: [{ total_stat: { stats: { impressions: 0, swipes: 0, spend: 0 } } }] } };
    const campStep: Expect = { method: "GET", url: "/v1/campaigns/camp_1", json: { ...ok, campaigns: [{ campaign: { id: "camp_1", status: "ACTIVE" } }] } };
    const ads = (review: string): Expect => ({ method: "GET", url: "/v1/adsquads/sq_1/ads", json: { ...ok, ads: [{ ad: { id: "ad_1", status: "ACTIVE", review_status: review } }] } });
    const { platform } = make([tokenStep, statsStep, campStep, ads("PENDING"), statsStep, campStep, ads("APPROVED")]);
    expect((await platform.stats(launched)).status).toBe("in_review");
    expect((await platform.stats(launched)).status).toBe("active");
  });

  test("pause / resume patch the campaign status", async () => {
    const step = (value: string): Expect => ({
      method: "PATCH",
      url: "/v1/adaccounts/acct1/campaigns/camp_1",
      check: (r) => expect(r.json).toEqual([{ op: "replace", path: "/status", value }]),
      json: ok,
    });
    const { f, platform } = make([tokenStep, step("PAUSED"), step("ACTIVE")]);
    await platform.pause(launched);
    await platform.resume(launched);
    expect(f.done()).toBe(true);
  });

  test("setDailyBudget PUTs the full ad squad with the new budget", async () => {
    const squad = {
      id: "sq_1",
      name: "day2 Buddy B-4",
      campaign_id: "camp_1",
      status: "ACTIVE",
      type: "SNAP_ADS",
      targeting: { geos: [{ country_code: "de" }] },
      placement_v2: { config: "AUTOMATIC" },
      billing_event: "IMPRESSION",
      bid_strategy: "AUTO_BID",
      auto_bid: true,
      target_bid: false,
      optimization_goal: "SWIPES",
      delivery_constraint: "DAILY_BUDGET",
      daily_budget_micro: 20_000_000,
      created_at: "x",
      updated_at: "y",
      delivery_status: ["DELIVERING"],
    };
    const { f, platform } = make([
      tokenStep,
      { method: "GET", url: "/v1/adsquads/sq_1", json: { ...ok, adsquads: [{ sub_request_status: "SUCCESS", adsquad: squad }] } },
      {
        method: "PUT",
        url: "/v1/campaigns/camp_1/adsquads",
        check: (r) => {
          const { auto_bid, target_bid, created_at, updated_at, delivery_status, ...rest } = squad;
          expect(r.json).toEqual({ adsquads: [{ ...rest, daily_budget_micro: 35_500_000 }] });
        },
        json: { ...ok, adsquads: [{ sub_request_status: "SUCCESS", adsquad: { id: "sq_1" } }] },
      },
    ]);
    await platform.setDailyBudget(launched, 35.5);
    expect(f.done()).toBe(true);
    await expect(platform.setDailyBudget(launched, 4)).rejects.toBeInstanceOf(PlatformError);
  });

  test("429 is retried", async () => {
    const { f, platform } = make([
      tokenStep,
      { method: "PATCH", url: "/v1/adaccounts/acct1/campaigns/camp_1", status: 429, headers: { "retry-after": "1" }, json: { request_status: "ERROR" } },
      { method: "PATCH", url: "/v1/adaccounts/acct1/campaigns/camp_1", json: ok },
    ]);
    await platform.pause(launched);
    expect(f.done()).toBe(true);
  });

  test("errors never contain tokens", async () => {
    const { platform } = make([
      tokenStep,
      { method: "PATCH", url: "/campaigns/camp_1", status: 401, text: '{"error":"bad access_token=atok"}' },
    ]);
    const e = await platform.pause(launched).catch((x) => x);
    expect(e).toBeInstanceOf(PlatformError);
    expect(String(e.message)).not.toContain("atok");
  });
});
