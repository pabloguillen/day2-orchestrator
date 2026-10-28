import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { noSleep, scriptedFetch, testAsset, testImage, testSpec, type Expect, type Recorded } from "../test-helpers";
import { PlatformError, type Conversion, type Identity, type Launched } from "../types";
import { ageGroups, create, credentialsFromEnv, hashExternalId, info } from "./tiktok";

const BASE = "https://business-api.tiktok.com/open_api/v1.3";
const creds = { accessToken: "tok_secret_123", advertiserId: "7000000000000000001" };
const NOW = new Date("2026-10-28T09:30:00Z");

const ok = (data: unknown) => ({ code: 0, message: "OK", request_id: "req1", data });
const form = (r: Recorded) => r.body as FormData;
const q = (r: Recorded, k: string) => new URL(r.url).searchParams.get(k);
const authed = (r: Recorded) => {
  expect(r.headers["access-token"]).toBe("tok_secret_123");
  expect(r.url).not.toContain("tok_secret_123");
};

function platform(script: Expect[]) {
  const f = scriptedFetch(script);
  const p = create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW });
  return { p, f };
}

const advertiser = (currency = "USD", status = "STATUS_ENABLE"): Expect => ({
  method: "GET",
  url: `${BASE}/advertiser/info/`,
  check: (r) => {
    authed(r);
    expect(JSON.parse(q(r, "advertiser_ids")!)).toEqual([creds.advertiserId]);
    expect(JSON.parse(q(r, "fields")!)).toEqual(["advertiser_id", "name", "currency", "status"]);
  },
  json: ok({ list: [{ advertiser_id: creds.advertiserId, name: "day2 ads", currency, status }] }),
});
const region: Expect = { url: `${BASE}/tool/region/`, json: ok({ region_info: [{ location_id: "2921044", region_code: "DE", level: "COUNTRY", name: "Germany" }, { location_id: "2782113", region_code: "AT", level: "COUNTRY" }] }) };

const identity: Identity = { platform: "tiktok", ref: "ident_42", displayName: "Buddy" };
const launched: Launched = { platform: "tiktok", campaignId: "cmp_1", refs: { adgroupId: "ag_1" }, ads: { "B-4-v1": "ad_1", "B-4-v2": "ad_2" } };

describe("info / credentials", () => {
  test("info", () => {
    expect(info.id).toBe("tiktok");
    expect(info.identity).toBe("custom");
    expect(info.clickIdParam).toBe("ttclid");
    expect(info.formats[0]).toMatchObject({ kind: "video", ratio: "9:16", minDurationSec: 5, maxDurationSec: 60 });
    expect(info.minDailyUsd).toBe(20);
    expect(info.apiVersion).toBe("v1.3");
    expect(info.env).toEqual(["TIKTOK_ACCESS_TOKEN", "TIKTOK_ADVERTISER_ID"]);
  });

  test("credentialsFromEnv", () => {
    expect(credentialsFromEnv({})).toBeNull();
    expect(credentialsFromEnv({ TIKTOK_ACCESS_TOKEN: "t" })).toBeNull();
    expect(credentialsFromEnv({ TIKTOK_ADVERTISER_ID: "a" })).toBeNull();
    expect(credentialsFromEnv({ TIKTOK_ACCESS_TOKEN: " ", TIKTOK_ADVERTISER_ID: "a" })).toBeNull();
    expect(credentialsFromEnv({ TIKTOK_ACCESS_TOKEN: "t", TIKTOK_ADVERTISER_ID: "a" })).toEqual({ accessToken: "t", advertiserId: "a" });
  });

  test("ageGroups", () => {
    expect(ageGroups(18)).toEqual(["AGE_18_24", "AGE_25_34", "AGE_35_44", "AGE_45_54", "AGE_55_100"]);
    expect(ageGroups(25, 44)).toEqual(["AGE_25_34", "AGE_35_44"]);
    expect(ageGroups(21, 23)).toEqual(["AGE_18_24"]);
  });

  test("hashExternalId", () => {
    const digest = createHash("sha256").update("user-1").digest("hex");
    expect(hashExternalId("User-1")).toBe(digest);
    expect(hashExternalId(digest)).toBe(digest);
  });
});

describe("accountInfo", () => {
  test("enabled account can spend", async () => {
    const { p, f } = platform([advertiser("EUR")]);
    expect(await p.accountInfo()).toEqual({ id: creds.advertiserId, name: "day2 ads", currency: "EUR", canSpend: true });
    expect(f.done()).toBe(true);
  });

  test("account under review cannot spend, with the problem", async () => {
    const { p } = platform([advertiser("USD", "STATUS_PENDING_CONFIRM")]);
    const acc = await p.accountInfo();
    expect(acc.canSpend).toBe(false);
    expect(acc.problem).toContain("under review");
  });
});

describe("ensureIdentity", () => {
  const logo = testImage({ id: "as_logo", url: "https://day2.example/api/assets/logo.png" });

  test("creates a custom identity when none matches", async () => {
    const { p, f } = platform([
      {
        method: "GET",
        url: `${BASE}/identity/get/`,
        check: (r) => {
          authed(r);
          expect(q(r, "advertiser_id")).toBe(creds.advertiserId);
          expect(q(r, "identity_type")).toBe("CUSTOMIZED_USER");
        },
        json: ok({ identity_list: [{ identity_id: "other", identity_type: "CUSTOMIZED_USER", display_name: "Someone Else" }], page_info: { page: 1, total_page: 1 } }),
      },
      {
        method: "POST",
        url: `${BASE}/file/image/ad/upload/`,
        check: (r) => {
          authed(r);
          expect(form(r).get("advertiser_id")).toBe(creds.advertiserId);
          expect(form(r).get("upload_type")).toBe("UPLOAD_BY_URL");
          expect(form(r).get("image_url")).toBe(logo.url);
        },
        json: ok({ image_id: "img_logo", width: 1080, height: 1080 }),
      },
      {
        method: "POST",
        url: `${BASE}/identity/create/`,
        check: (r) => expect(r.json).toEqual({ advertiser_id: creds.advertiserId, display_name: "Buddy", image_uri: "img_logo" }),
        json: ok({ identity_id: "ident_new" }),
      },
    ]);
    const id = await p.ensureIdentity!({ appId: "app_1", displayName: "Buddy", logo });
    expect(id).toEqual({ platform: "tiktok", ref: "ident_new", displayName: "Buddy", logo });
    expect(f.done()).toBe(true);
  });

  test("reuses an existing identity with the same name (searching all pages)", async () => {
    const { p, f } = platform([
      { url: `${BASE}/identity/get/`, check: (r) => expect(q(r, "page")).toBe("1"), json: ok({ identity_list: [{ identity_id: "x", display_name: "Nope" }], page_info: { total_page: 2 } }) },
      { url: `${BASE}/identity/get/`, check: (r) => expect(q(r, "page")).toBe("2"), json: ok({ identity_list: [{ identity_id: "ident_42", display_name: "Buddy" }], page_info: { total_page: 2 } }) },
    ]);
    const id = await p.ensureIdentity!({ appId: "app_1", displayName: "Buddy", logo });
    expect(id.ref).toBe("ident_42");
    expect(f.done()).toBe(true);
  });
});

describe("launch", () => {
  test("9:16 video, clicks: uploads by URL with cover, disabled campaign, ad group, ad (own link), then enables", async () => {
    const spec = testSpec({ identity, aiContent: true });
    spec.creatives[0]!.link = "https://buddy.example/go/split?d2=B-4.tiktok.v1";
    const { p, f } = platform([
      advertiser(),
      {
        method: "GET",
        ...region,
        check: (r) => {
          authed(r);
          expect(JSON.parse(q(r, "placements")!)).toEqual(["PLACEMENT_TIKTOK"]);
          expect(q(r, "objective_type")).toBe("TRAFFIC");
          expect(q(r, "level_range")).toBe("TO_COUNTRY");
        },
      },
      {
        method: "POST",
        url: `${BASE}/file/video/ad/upload/`,
        check: (r) => {
          authed(r);
          expect(form(r).get("upload_type")).toBe("UPLOAD_BY_URL");
          expect(form(r).get("video_url")).toBe("https://day2.example/api/assets/as_video1.mp4");
          expect(String(form(r).get("file_name"))).toContain("as_video1");
        },
        json: ok([{ video_id: "v_1", width: 1080, height: 1920, duration: 15 }]),
      },
      {
        method: "POST",
        url: `${BASE}/file/image/ad/upload/`,
        check: (r) => expect(form(r).get("image_url")).toBe("https://day2.example/api/assets/as_thumb1.jpg"),
        json: ok({ image_id: "img_cover" }),
      },
      {
        method: "POST",
        url: `${BASE}/campaign/create/`,
        check: (r) =>
          expect(r.json).toEqual({
            advertiser_id: creds.advertiserId,
            campaign_name: "day2 Buddy B-4",
            objective_type: "TRAFFIC",
            budget_mode: "BUDGET_MODE_INFINITE",
            operation_status: "DISABLE",
          }),
        json: ok({ campaign_id: "cmp_1" }),
      },
      {
        method: "POST",
        url: `${BASE}/adgroup/create/`,
        check: (r) =>
          expect(r.json).toEqual({
            advertiser_id: creds.advertiserId,
            campaign_id: "cmp_1",
            adgroup_name: "day2 Buddy B-4 · ad group",
            promotion_type: "WEBSITE",
            placement_type: "PLACEMENT_TYPE_NORMAL",
            placements: ["PLACEMENT_TIKTOK"],
            location_ids: ["2921044"],
            languages: ["de"],
            age_groups: ["AGE_18_24", "AGE_25_34", "AGE_35_44", "AGE_45_54", "AGE_55_100"],
            gender: "GENDER_UNLIMITED",
            budget_mode: "BUDGET_MODE_DAY",
            budget: 20,
            schedule_type: "SCHEDULE_FROM_NOW",
            schedule_start_time: "2026-10-28 09:30:00",
            optimization_goal: "CLICK",
            billing_event: "CPC",
            bid_type: "BID_TYPE_NO_BID",
            pacing: "PACING_MODE_SMOOTH",
            operation_status: "ENABLE",
          }),
        json: ok({ adgroup_id: "ag_1" }),
      },
      {
        method: "POST",
        url: `${BASE}/ad/create/`,
        check: (r) =>
          expect(r.json).toEqual({
            advertiser_id: creds.advertiserId,
            adgroup_id: "ag_1",
            creatives: [
              {
                ad_name: "day2 Buddy B-4 B-4-v1",
                ad_format: "SINGLE_VIDEO",
                identity_type: "CUSTOMIZED_USER",
                identity_id: "ident_42",
                video_id: "v_1",
                image_ids: ["img_cover"],
                ad_text: "Add the bill, pick who was there, done.",
                call_to_action: "SIGN_UP",
                landing_page_url: "https://buddy.example/go/split?d2=B-4.tiktok.v1",
                aigc_disclosure_type: "SELF_DISCLOSURE",
              },
            ],
          }),
        json: ok({ ad_ids: ["ad_1"] }),
      },
      {
        method: "POST",
        url: `${BASE}/campaign/status/update/`,
        check: (r) => expect(r.json).toEqual({ advertiser_id: creds.advertiserId, campaign_ids: ["cmp_1"], operation_status: "ENABLE" }),
        json: ok({ campaign_ids: ["cmp_1"] }),
      },
    ]);
    const res = await p.launch(spec);
    expect(res).toEqual({ platform: "tiktok", campaignId: "cmp_1", refs: { adgroupId: "ag_1" }, ads: { "B-4-v1": "ad_1" } });
    expect(f.done()).toBe(true);
  });

  test("signups in EUR: WEB_CONVERSIONS campaign, ad group optimises for the pixel's registration event", async () => {
    const spec = testSpec({ identity, currency: "EUR", dailyBudget: 25.5, optimizeFor: "signups", conversion: { platform: "tiktok", refs: { pixelId: "px_1", pixelCode: "CODE1" } } });
    const { p, f } = platform([
      advertiser("EUR"),
      region,
      { url: "/file/video/ad/upload/", json: ok([{ video_id: "v_1" }]) },
      { url: "/file/image/ad/upload/", json: ok({ image_id: "img_c" }) },
      { url: "/campaign/create/", check: (r) => expect((r.json as Record<string, unknown>).objective_type).toBe("WEB_CONVERSIONS"), json: ok({ campaign_id: "cmp_1" }) },
      {
        url: "/adgroup/create/",
        check: (r) => {
          const b = r.json as Record<string, unknown>;
          expect(b.optimization_goal).toBe("CONVERT");
          expect(b.pixel_id).toBe("px_1");
          expect(b.optimization_event).toBe("ON_WEB_REGISTER");
          expect(b.billing_event).toBe("OCPM");
          expect(b.budget).toBe(25.5);
          expect(b.promotion_type).toBe("WEBSITE");
        },
        json: ok({ adgroup_id: "ag_1" }),
      },
      { url: "/ad/create/", check: (r) => expect((r.json as { creatives: Array<Record<string, unknown>> }).creatives[0]!.landing_page_url).toBe(spec.link), json: ok({ ad_ids: ["ad_1"] }) },
      { url: "/campaign/status/update/", json: ok({}) },
    ]);
    await p.launch(spec);
    expect(f.done()).toBe(true);
  });

  test("fits long copy, maps CTA, no AI label when not AI, caches account currency and location ids", async () => {
    const long = "word ".repeat(40);
    const spec = testSpec({
      identity,
      creatives: [{ key: "k1", copy: { headline: "h", body: long, cta: "download" }, asset: testAsset() }],
    });
    const happy = (adCheck?: (r: Recorded) => void): Expect[] => [
      { url: "/file/video/ad/upload/", json: ok([{ video_id: "v_1" }]) },
      { url: "/file/image/ad/upload/", json: ok({ image_id: "img_c" }) },
      { url: "/campaign/create/", json: ok({ campaign_id: "cmp_1" }) },
      { url: "/adgroup/create/", json: ok({ adgroup_id: "ag_1" }) },
      { url: "/ad/create/", check: adCheck, json: ok({ ad_ids: ["ad_1"] }) },
      { url: "/campaign/status/update/", json: ok({}) },
    ];
    const { p, f } = platform([
      advertiser(),
      region,
      ...happy((r) => {
        const c = (r.json as { creatives: Array<Record<string, unknown>> }).creatives[0]!;
        expect((c.ad_text as string).length).toBeLessThanOrEqual(100);
        expect(c.ad_text as string).toEndWith("…");
        expect(c.call_to_action).toBe("DOWNLOAD_NOW");
        expect(c.aigc_disclosure_type).toBeUndefined();
      }),
      ...happy(), // second launch: no advertiser/info, no tool/region
    ]);
    await p.launch(spec);
    await p.launch(spec);
    expect(f.done()).toBe(true);
  });

  test("deletes the disabled campaign and rethrows when ad creation fails", async () => {
    const { p, f } = platform([
      advertiser(),
      region,
      { url: "/file/video/ad/upload/", json: ok([{ video_id: "v_1" }]) },
      { url: "/file/image/ad/upload/", json: ok({ image_id: "img_c" }) },
      { url: "/campaign/create/", json: ok({ campaign_id: "cmp_9" }) },
      { url: "/adgroup/create/", json: ok({ adgroup_id: "ag_9" }) },
      { url: "/ad/create/", json: { code: 40002, message: "Invalid video", request_id: "r9", data: {} } },
      {
        url: "/campaign/status/update/",
        check: (r) => expect(r.json).toEqual({ advertiser_id: creds.advertiserId, campaign_ids: ["cmp_9"], operation_status: "DELETE" }),
        json: ok({}),
      },
    ]);
    const err = await p.launch(testSpec({ identity })).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.message).toContain("Invalid video");
    expect(err.message).toContain("40002");
    expect(err.retryable).toBe(false);
    expect(f.done()).toBe(true);
  });

  test("validates before creating anything: identity, USD minimum, pixel, video, currency, country", async () => {
    const { p, f } = platform([advertiser("EUR"), region]);
    await expect(p.launch(testSpec())).rejects.toThrow(/identity/);
    await expect(p.launch(testSpec({ identity, dailyBudget: 10 }))).rejects.toThrow(/minimum/);
    await expect(p.launch(testSpec({ identity, optimizeFor: "signups" }))).rejects.toThrow(/pixel/);
    await expect(p.launch(testSpec({ identity, creatives: [{ key: "i", copy: testSpec().creatives[0]!.copy, asset: testImage() }] }))).rejects.toThrow(/video/);
    await expect(p.launch(testSpec({ identity, currency: "USD" }))).rejects.toThrow(/bills in EUR/);
    await expect(p.launch(testSpec({ identity, currency: "EUR", targeting: { ...testSpec().targeting, countries: ["DE", "ZZ"] } }))).rejects.toThrow(/ZZ/);
    expect(f.done()).toBe(true); // only advertiser/info and tool/region were called
  });
});

describe("stats", () => {
  test("maps spend (account currency)/impressions/clicks per creative, status, and the rejection reason", async () => {
    const { p, f } = platform([
      advertiser("EUR"),
      {
        method: "GET",
        url: `${BASE}/report/integrated/get/`,
        check: (r) => {
          authed(r);
          expect(q(r, "report_type")).toBe("BASIC");
          expect(q(r, "data_level")).toBe("AUCTION_AD");
          expect(q(r, "query_lifetime")).toBe("true");
          expect(JSON.parse(q(r, "dimensions")!)).toEqual(["ad_id"]);
          expect(JSON.parse(q(r, "metrics")!)).toEqual(["spend", "impressions", "clicks"]);
          expect(JSON.parse(q(r, "filtering")!)).toEqual([{ field_name: "campaign_ids", filter_type: "IN", filter_value: '["cmp_1"]' }]);
        },
        json: ok({
          list: [
            { dimensions: { ad_id: "ad_1" }, metrics: { spend: "12.34", impressions: "5000", clicks: "80" } },
            { dimensions: { ad_id: "ad_2" }, metrics: { spend: "0.66", impressions: "100", clicks: "2" } },
          ],
          page_info: { total_page: 1 },
        }),
      },
      {
        method: "GET",
        url: `${BASE}/ad/get/`,
        check: (r) => expect(JSON.parse(q(r, "filtering")!)).toEqual({ campaign_ids: ["cmp_1"] }),
        json: ok({
          list: [
            { ad_id: "ad_1", secondary_status: "AD_STATUS_DELIVERY_OK", operation_status: "ENABLE" },
            { ad_id: "ad_2", secondary_status: "AD_STATUS_AUDIT_DENY", operation_status: "ENABLE" },
          ],
        }),
      },
      {
        method: "GET",
        url: `${BASE}/ad/review_info/`,
        check: (r) => expect(JSON.parse(q(r, "ad_ids")!)).toEqual(["ad_2"]),
        json: ok({ ad_review_map: { ad_2: { review_status: "REJECTED", reject_info: [{ reasons: ["Misleading claims"], suggestion: "Remove the time claim" }] } } }),
      },
    ]);
    const s = await p.stats(launched);
    expect(s).toEqual({
      spend: 13,
      currency: "EUR",
      impressions: 5100,
      clicks: 82,
      status: "active",
      rejection: "Misleading claims; Suggestion: Remove the time claim",
      byCreative: {
        "B-4-v1": { spend: 12.34, impressions: 5000, clicks: 80, status: "active" },
        "B-4-v2": { spend: 0.66, impressions: 100, clicks: 2, status: "rejected" },
      },
    });
    expect(f.done()).toBe(true);
  });

  test("all in review, no delivery yet → in_review with zeros", async () => {
    const { p } = platform([
      advertiser(),
      { url: "/report/integrated/get/", json: ok({ list: [] }) },
      { url: "/ad/get/", json: ok({ list: [{ ad_id: "ad_1", secondary_status: "AD_STATUS_AUDIT" }, { ad_id: "ad_2", secondary_status: "AD_STATUS_NOT_START" }] }) },
    ]);
    const s = await p.stats(launched);
    expect(s.status).toBe("in_review");
    expect(s.spend).toBe(0);
    expect(s.byCreative?.["B-4-v1"]).toEqual({ spend: 0, impressions: 0, clicks: 0, status: "in_review" });
  });

  test("paused campaign", async () => {
    const { p } = platform([
      advertiser(),
      { url: "/report/integrated/get/", json: ok({ list: [] }) },
      { url: "/ad/get/", json: ok({ list: [{ ad_id: "ad_1", secondary_status: "AD_STATUS_CAMPAIGN_DISABLE" }, { ad_id: "ad_2", secondary_status: "AD_STATUS_CAMPAIGN_DISABLE" }] }) },
    ]);
    expect((await p.stats(launched)).status).toBe("paused");
  });
});

describe("pause / resume / ads / budget", () => {
  test("pause and resume toggle the campaign", async () => {
    const { p, f } = platform([
      { method: "POST", url: `${BASE}/campaign/status/update/`, check: (r) => expect(r.json).toEqual({ advertiser_id: creds.advertiserId, campaign_ids: ["cmp_1"], operation_status: "DISABLE" }), json: ok({}) },
      { method: "POST", url: `${BASE}/campaign/status/update/`, check: (r) => expect(r.json).toEqual({ advertiser_id: creds.advertiserId, campaign_ids: ["cmp_1"], operation_status: "ENABLE" }), json: ok({}) },
    ]);
    await p.pause(launched);
    await p.resume(launched);
    expect(f.done()).toBe(true);
  });

  test("setAdActive toggles one ad by creative key", async () => {
    const { p, f } = platform([
      { method: "POST", url: `${BASE}/ad/status/update/`, check: (r) => expect(r.json).toEqual({ advertiser_id: creds.advertiserId, ad_ids: ["ad_2"], operation_status: "DISABLE" }), json: ok({}) },
      { method: "POST", url: `${BASE}/ad/status/update/`, check: (r) => expect(r.json).toEqual({ advertiser_id: creds.advertiserId, ad_ids: ["ad_2"], operation_status: "ENABLE" }), json: ok({}) },
    ]);
    await p.setAdActive(launched, "B-4-v2", false);
    await p.setAdActive(launched, "B-4-v2", true);
    await expect(p.setAdActive(launched, "nope", false)).rejects.toThrow(/nope/);
    expect(f.done()).toBe(true);
  });

  test("setDailyBudget updates the ad group (USD minimum enforced)", async () => {
    const { p, f } = platform([
      advertiser(),
      { method: "POST", url: `${BASE}/adgroup/update/`, check: (r) => expect(r.json).toEqual({ advertiser_id: creds.advertiserId, adgroup_id: "ag_1", budget: 35.5 }), json: ok({ adgroup_id: "ag_1" }) },
    ]);
    await p.setDailyBudget(launched, 35.499);
    await expect(p.setDailyBudget(launched, 5)).rejects.toThrow(/minimum/);
    expect(f.done()).toBe(true);
  });

  test("setDailyBudget in another currency: no USD minimum", async () => {
    const { p, f } = platform([advertiser("JPY"), { url: "/adgroup/update/", check: (r) => expect((r.json as Record<string, unknown>).budget).toBe(5000), json: ok({}) }]);
    await p.setDailyBudget(launched, 5000);
    expect(f.done()).toBe(true);
  });
});

describe("conversions", () => {
  test("ensureConversions reuses the day2 pixel by name", async () => {
    const { p, f } = platform([
      {
        method: "GET",
        url: `${BASE}/pixel/list/`,
        check: (r) => expect(q(r, "name")).toBe("day2 conversions"),
        json: ok({ pixels: [{ pixel_id: "px_other", pixel_code: "OTHER", pixel_name: "day2 conversions old" }, { pixel_id: 777, pixel_code: "CODE7", pixel_name: "day2 conversions" }], page_info: { total_page: 1 } }),
      },
    ]);
    expect(await p.ensureConversions!()).toEqual({ platform: "tiktok", refs: { pixelId: "777", pixelCode: "CODE7" } });
    expect(f.done()).toBe(true);
  });

  test("ensureConversions creates the pixel when missing", async () => {
    const { p, f } = platform([
      { url: "/pixel/list/", json: ok({ pixels: [], page_info: { total_page: 0 } }) },
      {
        method: "POST",
        url: `${BASE}/pixel/create/`,
        check: (r) => expect(r.json).toEqual({ advertiser_id: creds.advertiserId, pixel_name: "day2 conversions" }),
        json: ok({ pixel_id: "px_new", pixel_code: "CNEW", pixel_name: "day2 conversions" }),
      },
    ]);
    expect(await p.ensureConversions!()).toEqual({ platform: "tiktok", refs: { pixelId: "px_new", pixelCode: "CNEW" } });
    expect(f.done()).toBe(true);
  });

  const setup = { platform: "tiktok" as const, refs: { pixelId: "px_1", pixelCode: "CODE1" } };
  const ev = (over: Partial<Conversion> = {}): Conversion => ({
    eventId: "dev-1:signup",
    name: "signup",
    at: "2026-10-28T09:00:00Z",
    click: { param: "ttclid", value: "E.C.P.abc" },
    pageUrl: "https://buddy.example/go/split",
    externalId: "user-1",
    ...over,
  });

  test("sendConversions posts Events API 2.0 payloads and rejects non-TikTok clicks", async () => {
    const { p, f } = platform([
      {
        method: "POST",
        url: `${BASE}/event/track/`,
        check: (r) => {
          authed(r);
          expect(r.json).toEqual({
            event_source: "web",
            event_source_id: "CODE1",
            data: [
              {
                event: "CompleteRegistration",
                event_time: Math.floor(Date.parse("2026-10-28T09:00:00Z") / 1000),
                event_id: "dev-1:signup",
                user: { ttclid: "E.C.P.abc", external_id: createHash("sha256").update("user-1").digest("hex"), ip: "203.0.113.7", user_agent: "Mozilla/5.0 (iPhone)" },
                page: { url: "https://buddy.example/go/split" },
              },
              {
                event: "Activated",
                event_time: Math.floor(Date.parse("2026-10-28T09:05:00Z") / 1000),
                event_id: "dev-1:activated",
                user: { ttclid: "E.C.P.abc" },
                page: { url: "https://buddy.example/go/split" },
              },
            ],
          });
        },
        json: ok({}),
      },
    ]);
    const res = await p.sendConversions!(setup, [
      ev({ clientIp: "203.0.113.7", userAgent: "Mozilla/5.0 (iPhone)" }),
      ev({ eventId: "dev-1:activated", name: "activated", at: "2026-10-28T09:05:00Z", externalId: undefined }),
      ev({ eventId: "dev-2:signup", click: { param: "fbclid", value: "x" } }),
    ]);
    expect(res).toEqual({ sent: 2, rejected: [{ eventId: "dev-2:signup", why: "not a TikTok click (fbclid)" }] });
    expect(f.done()).toBe(true);
  });

  test("sendConversions: a permanent error rejects the batch; a rate limit throws retryable", async () => {
    const bad = platform([{ url: "/event/track/", json: { code: 40002, message: "Invalid pixel code" } }]);
    const res = await bad.p.sendConversions!(setup, [ev()]);
    expect(res.sent).toBe(0);
    expect(res.rejected[0]!.why).toContain("Invalid pixel code");

    const limited = { url: "/event/track/", json: { code: 40100, message: "Requests made too frequently" } };
    const slow = platform([limited, limited, limited]);
    const err = await slow.p.sendConversions!(setup, [ev()]).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.retryable).toBe(true);
  });
});

describe("error envelope", () => {
  test("code != 0 becomes a non-retryable PlatformError", async () => {
    const { p } = platform([{ url: "/campaign/status/update/", json: { code: 40001, message: "No permission to operate advertiser", request_id: "r1" } }]);
    const err = await p.pause(launched).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.platform).toBe("tiktok");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("No permission");
    expect(err.message).not.toContain("tok_secret_123");
  });

  test("rate-limit code is retried, then surfaces as retryable", async () => {
    const limited = { url: "/campaign/status/update/", json: { code: 40100, message: "Requests made too frequently", request_id: "r" } };
    const { p, f } = platform([limited, limited, limited]);
    const err = await p.pause(launched).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.retryable).toBe(true);
    expect(f.done()).toBe(true);
  });

  test("rate-limit code then success", async () => {
    const { p, f } = platform([
      { url: "/campaign/status/update/", json: { code: 40100, message: "Requests made too frequently" } },
      { url: "/campaign/status/update/", json: ok({}) },
    ]);
    await p.pause(launched);
    expect(f.done()).toBe(true);
  });

  test("system error codes are retryable", async () => {
    const { p } = platform([advertiser(), { url: "/adgroup/update/", json: { code: 50000, message: "System error" } }]);
    const err = await p.setDailyBudget(launched, 30).catch((e) => e);
    expect(err.retryable).toBe(true);
  });
});
