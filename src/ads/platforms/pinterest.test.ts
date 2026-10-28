import { describe, expect, test } from "bun:test";
import { noSleep, scriptedFetch, testAsset, testImage, testSpec, type Expect } from "../test-helpers";
import { PlatformError, type Launched } from "../types";
import { create, credentialsFromEnv, info, type PinterestCreds } from "./pinterest";

const API = "https://api.pinterest.com/v5";
const ACCT = `${API}/ad_accounts/549755885175`;
const creds: PinterestCreds = { clientId: "cid", clientSecret: "csecret", refreshToken: "rt_1", adAccountId: "549755885175" };
const NOW = new Date("2026-10-28T12:00:00Z");

const oauth: Expect = {
  method: "POST",
  url: `${API}/oauth/token`,
  check: (r) => {
    expect(r.headers["authorization"]).toBe(`Basic ${btoa("cid:csecret")}`);
    expect(r.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(r.json).toEqual({ grant_type: "refresh_token", refresh_token: "rt_1" });
  },
  json: { access_token: "at_1", expires_in: 2592000, token_type: "bearer", refresh_token: "rt_2", refresh_token_expires_in: 5184000 },
};
const account: Expect = {
  method: "GET",
  url: ACCT,
  check: (r) => {
    expect(r.url).toBe(ACCT);
    expect(r.headers["authorization"]).toBe("Bearer at_1");
  },
  json: { id: "549755885175", currency: "USD", country: "DE" },
};

function campaignCreate(): Expect {
  return {
    method: "POST",
    url: `${ACCT}/campaigns`,
    check: (r) =>
      expect(r.json).toEqual([
        {
          ad_account_id: "549755885175",
          name: "day2 Buddy B-4",
          objective_type: "CONSIDERATION",
          status: "PAUSED",
          is_campaign_budget_optimization: true,
          is_flexible_daily_budgets: false,
          daily_spend_cap: 20_000_000,
        },
      ]),
    json: { items: [{ data: { id: "626736533506", status: "PAUSED" }, exceptions: [] }] },
  };
}
function adGroupCreate(): Expect {
  return {
    method: "POST",
    url: `${ACCT}/ad_groups`,
    check: (r) =>
      expect(r.json).toEqual([
        {
          campaign_id: "626736533506",
          name: "day2 Buddy B-4 · ad group",
          status: "ACTIVE",
          budget_type: "CBO_ADGROUP",
          billable_event: "CLICKTHROUGH",
          bid_strategy_type: "AUTOMATIC_BID",
          auto_targeting_enabled: false,
          placement_group: "ALL",
          targeting_spec: { LOCATION: ["DE"], MINIMUM_AGE: "18", MAXIMUM_AGE: "65+", LOCALE: ["de"] },
        },
      ]),
    json: { items: [{ data: { id: "2680059592705", campaign_id: "626736533506" }, exceptions: [] }] },
  };
}
function activate(): Expect {
  return {
    method: "PATCH",
    url: `${ACCT}/campaigns`,
    check: (r) => expect(r.json).toEqual([{ id: "626736533506", ad_account_id: "549755885175", status: "ACTIVE" }]),
    json: { items: [{ data: { id: "626736533506", status: "ACTIVE" }, exceptions: [] }] },
  };
}

describe("pinterest info & env", () => {
  test("info", () => {
    expect(info.id).toBe("pinterest");
    expect(info.identity).toBe("none");
    expect(info.formats.map((f) => `${f.kind} ${f.ratio}`)).toEqual(["image 2:3", "image 1:1", "video 9:16", "video 1:1", "video 2:3"]);
    expect(info.copyLimits).toEqual({ headline: 100, body: 500 });
    expect(info.audiences).toEqual(["consumer"]);
    expect(info.env).toContain("PINTEREST_AD_ACCOUNT_ID");
  });

  test("credentialsFromEnv returns null when vars are missing", () => {
    expect(credentialsFromEnv({})).toBeNull();
    expect(credentialsFromEnv({ PINTEREST_CLIENT_ID: "a", PINTEREST_CLIENT_SECRET: "b", PINTEREST_REFRESH_TOKEN: "c" })).toBeNull();
    expect(credentialsFromEnv({ PINTEREST_CLIENT_ID: "a", PINTEREST_CLIENT_SECRET: "b", PINTEREST_REFRESH_TOKEN: "", PINTEREST_AD_ACCOUNT_ID: "d" })).toBeNull();
    expect(credentialsFromEnv({ PINTEREST_CLIENT_ID: "a", PINTEREST_CLIENT_SECRET: "b", PINTEREST_REFRESH_TOKEN: "c", PINTEREST_AD_ACCOUNT_ID: "d" })).toEqual({
      clientId: "a",
      clientSecret: "b",
      refreshToken: "c",
      adAccountId: "d",
    });
    expect(credentialsFromEnv({ PINTEREST_CLIENT_ID: "a", PINTEREST_CLIENT_SECRET: "b", PINTEREST_REFRESH_TOKEN: "c", PINTEREST_AD_ACCOUNT_ID: "d", PINTEREST_BOARD_ID: "42" })?.boardId).toBe("42");
  });
});

describe("pinterest launch", () => {
  test("2:3 image creative: OAuth refresh, pin from image_url, campaign → ad group → ad, then activate", async () => {
    const image = testImage({ ratio: "2:3", width: 1000, height: 1500 });
    const rotated: string[] = [];
    const f = scriptedFetch([
      oauth,
      account,
      {
        method: "POST",
        url: `${API}/pins?ad_account_id=549755885175`,
        check: (r) => {
          expect(r.headers["authorization"]).toBe("Bearer at_1");
          expect(r.json).toEqual({
            title: "Split a dinner bill in 10 seconds",
            description: "Add the bill, pick who was there, done.",
            link: "https://buddy.example/go/split?d2=B-4.x",
            alt_text: "Split a dinner bill in 10 seconds",
            media_source: { source_type: "image_url", url: "https://day2.example/api/assets/as_img1.png" },
            board_id: "777",
          });
        },
        json: { id: "813744226420795884" },
      },
      campaignCreate(),
      adGroupCreate(),
      {
        method: "POST",
        url: `${ACCT}/ads`,
        check: (r) =>
          expect(r.json).toEqual([
            {
              ad_group_id: "2680059592705",
              pin_id: "813744226420795884",
              creative_type: "REGULAR",
              name: "day2 Buddy B-4 B-4-v1",
              status: "ACTIVE",
              destination_url: "https://buddy.example/go/split?d2=B-4.x",
              customizable_cta_type: "SIGN_UP",
            },
          ]),
        json: { items: [{ data: { id: "687195134316", pin_id: "813744226420795884" } }] },
      },
      activate(),
    ]);
    const p = create({ ...creds, boardId: "777", onRefreshToken: (t) => void rotated.push(t) }, { fetch: f.fetch, sleep: noSleep, now: () => NOW });
    const spec = testSpec();
    const launched = await p.launch({ ...spec, creatives: [{ ...spec.creatives[0]!, asset: image }] });
    expect(f.done()).toBe(true);
    expect(rotated).toEqual(["rt_2"]);
    expect(launched).toEqual({
      platform: "pinterest",
      campaignId: "626736533506",
      refs: { adGroupId: "2680059592705", startDate: "2026-10-28", "pin:B-4-v1": "813744226420795884" },
      ads: { "B-4-v1": "687195134316" },
    });
  });

  test("video creative: media register → upload with form fields → poll → video pin with cover; ad-only pin without board", async () => {
    const video = testAsset({ aiGenerated: true });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const f = scriptedFetch([
      oauth,
      account,
      {
        method: "POST",
        url: `${API}/media`,
        check: (r) => expect(r.json).toEqual({ media_type: "video" }),
        json: {
          media_id: "12345",
          media_type: "video",
          upload_url: "https://pinterest-media-upload.s3-accelerate.amazonaws.com/",
          upload_parameters: { "x-amz-date": "20261028T000000Z", key: "uploads/12/34/5", policy: "pol", "x-amz-signature": "sig", "Content-Type": "multipart/form-data" },
        },
      },
      {
        method: "POST",
        url: "https://pinterest-media-upload.s3-accelerate.amazonaws.com/",
        check: (r) => {
          expect(r.headers["authorization"]).toBeUndefined();
          const form = r.body as FormData;
          expect(form).toBeInstanceOf(FormData);
          expect(form.get("x-amz-date")).toBe("20261028T000000Z");
          expect(form.get("key")).toBe("uploads/12/34/5");
          expect(form.get("policy")).toBe("pol");
          expect(form.get("x-amz-signature")).toBe("sig");
          expect(form.get("Content-Type")).toBe("multipart/form-data");
          const file = form.get("file") as File;
          expect(file.size).toBe(4);
          expect(file.type).toBe("video/mp4");
          // The file must be the last field for S3 POST uploads.
          expect([...form.keys()].at(-1)).toBe("file");
        },
        status: 204,
        text: "",
      },
      { method: "GET", url: `${API}/media/12345`, json: { media_id: "12345", media_type: "video", status: "registered" } },
      { method: "GET", url: `${API}/media/12345`, json: { media_id: "12345", media_type: "video", status: "processing" } },
      { method: "GET", url: `${API}/media/12345`, json: { media_id: "12345", media_type: "video", status: "succeeded" } },
      {
        method: "POST",
        url: `${API}/pins?ad_account_id=549755885175`,
        check: (r) => {
          const b = r.json as Record<string, unknown>;
          expect(b.board_id).toBeUndefined();
          expect(b.media_source).toEqual({ source_type: "video_id", media_id: "12345", cover_image_url: "https://day2.example/api/assets/as_thumb1.jpg" });
          expect(b.ai_disclosures).toEqual({ values: ["AI_MODIFIED"] });
        },
        json: { id: "900" },
      },
      campaignCreate(),
      adGroupCreate(),
      {
        method: "POST",
        url: `${ACCT}/ads`,
        check: (r) => {
          const [ad] = r.json as Array<Record<string, unknown>>;
          expect(ad!.creative_type).toBe("VIDEO");
          expect(ad!.pin_id).toBe("900");
        },
        json: { items: [{ data: { id: "687195134317" } }] },
      },
      activate(),
    ]);
    const p = create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW, readAsset: async () => bytes });
    const spec = testSpec({ aiContent: true });
    const launched = await p.launch({ ...spec, creatives: [{ ...spec.creatives[0]!, asset: video }] });
    expect(f.done()).toBe(true);
    expect(launched.ads).toEqual({ "B-4-v1": "687195134317" });
  });

  test("ad failure after campaign creation archives the campaign and rethrows PlatformError", async () => {
    const f = scriptedFetch([
      oauth,
      account,
      { method: "POST", url: `${API}/pins`, json: { id: "1" } },
      campaignCreate(),
      adGroupCreate(),
      { method: "POST", url: `${ACCT}/ads`, json: { items: [{ data: null, exceptions: { code: 2711, message: "Pin is not eligible for promotion" } }] } },
      {
        method: "PATCH",
        url: `${ACCT}/campaigns`,
        check: (r) => expect(r.json).toEqual([{ id: "626736533506", ad_account_id: "549755885175", status: "ARCHIVED" }]),
        json: { items: [{ data: { id: "626736533506", status: "ARCHIVED" } }] },
      },
    ]);
    const p = create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW });
    const spec = testSpec();
    const err = await p.launch({ ...spec, creatives: [{ ...spec.creatives[0]!, asset: testImage() }] }).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(String(err.message)).toContain("not eligible");
    expect(f.done()).toBe(true);
  });

  test("refuses a non-USD ad account before creating anything", async () => {
    const f = scriptedFetch([oauth, { ...account, json: { id: "549755885175", currency: "EUR" } }]);
    const p = create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW });
    await expect(p.launch(testSpec())).rejects.toBeInstanceOf(PlatformError);
    expect(f.done()).toBe(true);
  });

  test("a 429 is retried after Retry-After", async () => {
    const waits: number[] = [];
    const f = scriptedFetch([
      oauth,
      { method: "PATCH", url: `${ACCT}/campaigns`, status: 429, headers: { "retry-after": "2" }, json: { code: 8, message: "rate limited" } },
      { method: "PATCH", url: `${ACCT}/campaigns`, json: { items: [{ data: { id: "626736533506", status: "PAUSED" } }] } },
    ]);
    const p = create(creds, { fetch: f.fetch, sleep: async (ms) => void waits.push(ms), now: () => NOW });
    await p.pause({ platform: "pinterest", campaignId: "626736533506", refs: {}, ads: {} });
    expect(waits).toEqual([2000]);
    expect(f.done()).toBe(true);
  });
});

describe("pinterest operate", () => {
  const launched: Launched = {
    platform: "pinterest",
    campaignId: "626736533506",
    refs: { adGroupId: "2680059592705", startDate: "2026-10-20" },
    ads: { "B-4-v1": "687195134316", "B-4-v2": "687195134317" },
  };

  test("stats: campaign, ads (review/rejection), analytics in micro dollars", async () => {
    const f = scriptedFetch([
      oauth,
      account,
      { method: "GET", url: `${ACCT}/campaigns/626736533506`, json: { id: "626736533506", status: "ACTIVE", summary_status: "RUNNING" } },
      {
        method: "GET",
        url: `${ACCT}/ads?`,
        check: (r) => {
          const u = new URL(r.url);
          expect(u.searchParams.get("campaign_ids")).toBe("626736533506");
        },
        json: {
          items: [
            { id: "687195134316", status: "ACTIVE", review_status: "APPROVED", summary_status: "APPROVED", rejected_reasons: [], rejection_labels: [] },
            {
              id: "687195134317",
              status: "ACTIVE",
              review_status: "REJECTED",
              summary_status: "REJECTED",
              rejected_reasons: ["LANDING_PAGE"],
              rejection_labels: ["Landing page doesn't work"],
            },
          ],
          bookmark: null,
        },
      },
      {
        method: "GET",
        url: `${ACCT}/ads/analytics?`,
        check: (r) => {
          const u = new URL(r.url);
          expect(u.searchParams.get("ad_ids")).toBe("687195134316,687195134317");
          expect(u.searchParams.get("start_date")).toBe("2026-10-20");
          expect(u.searchParams.get("end_date")).toBe("2026-10-28");
          expect(u.searchParams.get("columns")).toBe("AD_ID,SPEND_IN_MICRO_DOLLAR,IMPRESSION_1,CLICKTHROUGH_1");
          expect(u.searchParams.get("granularity")).toBe("TOTAL");
        },
        json: [
          { AD_ID: "687195134316", SPEND_IN_MICRO_DOLLAR: 12_340_000, IMPRESSION_1: 4000, CLICKTHROUGH_1: 55 },
          { AD_ID: "687195134317", SPEND_IN_MICRO_DOLLAR: 660_000, IMPRESSION_1: 100, CLICKTHROUGH_1: 1 },
        ],
      },
    ]);
    const p = create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW });
    const s = await p.stats(launched);
    expect(f.done()).toBe(true);
    expect(s).toEqual({
      spendUsd: 13,
      impressions: 4100,
      clicks: 56,
      status: "active",
      rejection: "Landing page doesn't work",
      byCreative: {
        "B-4-v1": { spendUsd: 12.34, impressions: 4000, clicks: 55, status: "active" },
        "B-4-v2": { spendUsd: 0.66, impressions: 100, clicks: 1, status: "rejected" },
      },
    });
  });

  test("stats: all ads pending → in_review; old campaigns clamp to the 90-day analytics window", async () => {
    const f = scriptedFetch([
      oauth,
      account,
      { method: "GET", url: `${ACCT}/campaigns/626736533506`, json: { id: "626736533506", status: "ACTIVE", summary_status: "RUNNING" } },
      { method: "GET", url: `${ACCT}/ads?`, json: { items: [{ id: "687195134316", status: "ACTIVE", review_status: "PENDING", summary_status: "PENDING" }] } },
      {
        method: "GET",
        url: `${ACCT}/ads/analytics?`,
        check: (r) => expect(new URL(r.url).searchParams.get("start_date")).toBe("2026-07-31"),
        json: [],
      },
    ]);
    const p = create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW });
    const s = await p.stats({ ...launched, refs: { startDate: "2026-01-01" }, ads: { "B-4-v1": "687195134316" } });
    expect(s.status).toBe("in_review");
    expect(s.spendUsd).toBe(0);
    expect(f.done()).toBe(true);
  });

  test("pause / resume / setDailyBudget patch the campaign", async () => {
    const ok = { items: [{ data: { id: "626736533506" } }] };
    const f = scriptedFetch([
      oauth,
      { method: "PATCH", url: `${ACCT}/campaigns`, check: (r) => expect(r.json).toEqual([{ id: "626736533506", ad_account_id: "549755885175", status: "PAUSED" }]), json: ok },
      { method: "PATCH", url: `${ACCT}/campaigns`, check: (r) => expect(r.json).toEqual([{ id: "626736533506", ad_account_id: "549755885175", status: "ACTIVE" }]), json: ok },
      account,
      { method: "PATCH", url: `${ACCT}/campaigns`, check: (r) => expect(r.json).toEqual([{ id: "626736533506", ad_account_id: "549755885175", daily_spend_cap: 37_500_000 }]), json: ok },
    ]);
    const p = create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW });
    await p.pause(launched);
    await p.resume(launched);
    await p.setDailyBudget(launched, 37.5);
    expect(f.done()).toBe(true);
  });

  test("batch item exceptions surface as PlatformError", async () => {
    const f = scriptedFetch([oauth, { method: "PATCH", url: `${ACCT}/campaigns`, json: { items: [{ data: {}, exceptions: [{ code: 2, message: "Campaign not found" }] }] } }]);
    const p = create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW });
    await expect(p.pause(launched)).rejects.toThrow("Campaign not found");
  });

  test("errors never contain the token", async () => {
    const f = scriptedFetch([oauth, { method: "PATCH", url: `${ACCT}/campaigns`, status: 401, json: { code: 2, message: "Authentication failed. Bearer at_1" } }]);
    const p = create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW });
    const err = await p.pause(launched).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(String(err.message)).not.toContain("at_1");
  });
});
