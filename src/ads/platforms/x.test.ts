import { describe, expect, test } from "bun:test";
import { noSleep, scriptedFetch, testAsset, testImage, testSpec, type Expect, type Recorded } from "../test-helpers";
import { PlatformError, type Launched } from "../types";
import { create, credentialsFromEnv, info, oauthHeader, oauthSignature, percentEncode, type XCreds } from "./x";

const creds: XCreds = {
  consumerKey: "ck",
  consumerSecret: "consumer-secret-xyz",
  accessToken: "at",
  accessTokenSecret: "token-secret-xyz",
  adsAccountId: "18ce54d4x5t",
};
const NOW = new Date("2026-10-28T10:30:00Z");
const ADS = "https://ads-api.x.com/12/accounts/18ce54d4x5t";
const APP_USER = "756201191646691328";
const identity = { platform: "x" as const, ref: APP_USER, displayName: "Buddy" };
const video = testAsset({ ratio: "16:9", width: 1920, height: 1080 });
const bytes = new Uint8Array([1, 2, 3, 4, 5]);

const form = (r: Recorded) => r.json as Record<string, string>;
const q = (r: Recorded) => Object.fromEntries(new URL(r.url).searchParams);
const signed = (r: Recorded) => {
  expect(r.headers.authorization).toStartWith('OAuth oauth_consumer_key="ck", oauth_nonce="');
  expect(r.headers.authorization).toContain('oauth_signature_method="HMAC-SHA1"');
  expect(r.headers.authorization).toContain('oauth_token="at"');
  expect(r.headers.authorization).not.toContain("secret-xyz");
};

describe("OAuth 1.0a", () => {
  // https://docs.x.com/resources/fundamentals/authentication/oauth-1-0a/creating-a-signature
  const doc = {
    consumerKey: "xvz1evFS4wEEPTGEFPHBog",
    consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    accessTokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
  };
  const nonce = "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg";
  const url = "https://api.x.com/1.1/statuses/update.json?include_entities=true";
  const body: Array<[string, string]> = [["status", "Hello Ladies + Gentlemen, a signed OAuth request!"]];

  test("signature matches X's documented vector", () => {
    const sig = oauthSignature(
      "POST",
      url,
      [
        ...body,
        ["oauth_consumer_key", doc.consumerKey],
        ["oauth_nonce", nonce],
        ["oauth_signature_method", "HMAC-SHA1"],
        ["oauth_timestamp", "1318622958"],
        ["oauth_token", doc.accessToken],
        ["oauth_version", "1.0"],
      ],
      doc.consumerSecret,
      doc.accessTokenSecret,
    );
    expect(sig).toBe("Ls93hJiZbQ3akF3HF3x1Bz8/zU4=");
  });

  test("header is built in X's documented format", () => {
    expect(oauthHeader(doc, "POST", url, body, nonce, 1318622958)).toBe(
      'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", ' +
        'oauth_signature="Ls93hJiZbQ3akF3HF3x1Bz8%2FzU4%3D", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", ' +
        'oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1.0"',
    );
  });

  test("RFC 3986 encoding", () => {
    expect(percentEncode("Ladies + Gentlemen!*'()")).toBe("Ladies%20%2B%20Gentlemen%21%2A%27%28%29");
  });
});

describe("credentialsFromEnv", () => {
  const env = { X_CONSUMER_KEY: "a", X_CONSUMER_SECRET: "b", X_ACCESS_TOKEN: "c", X_ACCESS_TOKEN_SECRET: "d", X_ADS_ACCOUNT_ID: "e" };
  test("reads all vars", () => {
    expect(credentialsFromEnv({ ...env, X_FUNDING_INSTRUMENT_ID: "fi" })).toEqual({
      consumerKey: "a",
      consumerSecret: "b",
      accessToken: "c",
      accessTokenSecret: "d",
      adsAccountId: "e",
      fundingInstrumentId: "fi",
    });
    expect(credentialsFromEnv(env)?.fundingInstrumentId).toBeUndefined();
  });
  test("null when any required var is missing or blank", () => {
    for (const k of Object.keys(env)) expect(credentialsFromEnv({ ...env, [k]: undefined })).toBeNull();
    expect(credentialsFromEnv({ ...env, X_ACCESS_TOKEN: "  " })).toBeNull();
    expect(credentialsFromEnv({})).toBeNull();
  });
});

describe("info", () => {
  test("contract fields", () => {
    expect(info.id).toBe("x");
    expect(info.apiVersion).toBe("12");
    expect(info.identity).toBe("app_account");
    expect(info.audiences).toEqual(["consumer", "business"]);
    expect(info.copyLimits.body).toBe(256);
    expect(info.formats.map((f) => `${f.kind} ${f.ratio}`)).toEqual(["video 16:9", "video 1:1", "image 1:1", "image 16:9"]);
  });
});

/** The calls before the campaign exists, for one video creative in DE. */
function preCampaign(): Expect[] {
  return [
    { method: "GET", url: `${ADS}/promotable_users`, json: { data: [{ id: "pu1", user_id: APP_USER, promotable_user_type: "RETWEETS_ONLY", deleted: false }] } },
    {
      method: "GET",
      url: `${ADS}/funding_instruments`,
      json: { data: [{ id: "old", entity_status: "CANCELLED", currency: "USD", able_to_fund: false }, { id: "lygyi", entity_status: "ACTIVE", currency: "USD", able_to_fund: true, deleted: false }] },
    },
    {
      method: "GET",
      url: "https://ads-api.x.com/12/targeting_criteria/locations",
      check: (r) => expect(q(r)).toEqual({ location_type: "COUNTRIES", country_code: "DE" }),
      json: { data: [{ name: "Germany", country_code: "DE", location_type: "COUNTRIES", targeting_type: "LOCATION", targeting_value: "fdcd221ac44fa326" }] },
    },
    // video upload
    {
      method: "POST",
      url: "https://api.x.com/2/media/upload/initialize",
      check: (r) => {
        signed(r);
        expect(r.json).toEqual({ media_type: "video/mp4", total_bytes: 5, media_category: "amplify_video" });
      },
      json: { data: { id: "111", media_key: "13_111", expires_after_secs: 86400 } },
    },
    {
      method: "POST",
      url: "https://api.x.com/2/media/upload/111/append",
      check: (r) => {
        signed(r);
        const fd = r.body as FormData;
        expect(fd.get("segment_index")).toBe("0");
        expect((fd.get("media") as Blob).size).toBe(5);
      },
      json: {},
    },
    { method: "POST", url: "https://api.x.com/2/media/upload/111/finalize", json: { data: { id: "111", media_key: "13_111", processing_info: { state: "pending", check_after_secs: 1 } } } },
    {
      method: "GET",
      url: "https://api.x.com/2/media/upload?command=STATUS&media_id=111",
      json: { data: { id: "111", processing_info: { state: "in_progress", check_after_secs: 1 } } },
    },
    { method: "GET", url: "https://api.x.com/2/media/upload?command=STATUS&media_id=111", json: { data: { id: "111", processing_info: { state: "succeeded" } } } },
    // poster image upload
    {
      method: "POST",
      url: "https://api.x.com/2/media/upload/initialize",
      check: (r) => expect(r.json).toEqual({ media_type: "image/jpeg", total_bytes: 5, media_category: "tweet_image" }),
      json: { data: { id: "222", media_key: "3_222" } },
    },
    { method: "POST", url: "https://api.x.com/2/media/upload/222/append", json: {} },
    { method: "POST", url: "https://api.x.com/2/media/upload/222/finalize", json: { data: { id: "222", media_key: "3_222" } } },
    {
      method: "POST",
      url: `${ADS}/media_library`,
      check: (r) => {
        signed(r);
        expect(form(r)).toEqual({ media_key: "13_111", name: "day2 Buddy B-4 B-4-v1", poster_media_key: "3_222" });
      },
      json: { data: { media_key: "13_111", media_category: "AMPLIFY_VIDEO" } },
    },
    {
      method: "POST",
      url: `${ADS}/cards`,
      check: (r) => {
        expect(r.headers["content-type"]).toBe("application/json");
        expect(r.json).toEqual({
          name: "day2 Buddy B-4 B-4-v1",
          components: [
            { type: "MEDIA", media_key: "13_111" },
            { type: "DETAILS", title: "Split a dinner bill in 10 seconds", destination: { type: "WEBSITE", url: "https://buddy.example/go/split?d2=B-4.x" } },
          ],
        });
      },
      json: { data: { id: "c1", card_uri: "card://1326399865065238531" } },
    },
    {
      method: "POST",
      url: `${ADS}/tweet`,
      check: (r) => {
        signed(r);
        expect(form(r)).toEqual({
          as_user_id: APP_USER,
          nullcast: "true",
          name: "day2 Buddy B-4 B-4-v1",
          text: "Add the bill, pick who was there, done.",
          card_uri: "card://1326399865065238531",
        });
        // RFC 3986 on the wire (matches the signature), not "+" for spaces.
        expect(r.body as string).toContain("text=Add%20the%20bill%2C%20pick");
      },
      json: { data: { id: 1452, id_str: "1452000000000000000" } },
    },
  ];
}

describe("launch", () => {
  test("video creative: upload, library, card, promoted-only post, paused campaign + line item, targeting, promoted tweet, activate", async () => {
    const f = scriptedFetch([
      ...preCampaign(),
      {
        method: "POST",
        url: `${ADS}/campaigns`,
        check: (r) =>
          expect(form(r)).toEqual({ funding_instrument_id: "lygyi", name: "day2 Buddy B-4", daily_budget_amount_local_micro: "20000000", entity_status: "PAUSED" }),
        json: { data: { id: "hwtbm", entity_status: "PAUSED" } },
      },
      {
        method: "POST",
        url: `${ADS}/line_items`,
        check: (r) =>
          expect(form(r)).toEqual({
            campaign_id: "hwtbm",
            name: "day2 Buddy B-4",
            objective: "WEBSITE_CLICKS",
            product_type: "PROMOTED_TWEETS",
            placements: "ALL_ON_TWITTER",
            bid_strategy: "AUTO",
            advertiser_domain: "buddy.example",
            start_time: "2026-10-28T10:30:00.000Z",
            end_time: "2027-10-28T10:30:00.000Z",
            entity_status: "PAUSED",
          }),
        json: { data: { id: "9cqi0", entity_status: "PAUSED" } },
      },
      {
        method: "POST",
        url: "https://ads-api.x.com/12/batch/accounts/18ce54d4x5t/targeting_criteria",
        check: (r) =>
          expect(r.json).toEqual([{ operation_type: "Create", params: { line_item_id: "9cqi0", targeting_type: "LOCATION", targeting_value: "fdcd221ac44fa326" } }]),
        json: { data: [{ id: "tc1" }], operation_errors: [[]] },
      },
      {
        method: "POST",
        url: `${ADS}/promoted_tweets`,
        check: (r) => expect(form(r)).toEqual({ line_item_id: "9cqi0", tweet_ids: "1452000000000000000" }),
        json: { data: [{ id: "pt1", tweet_id: "1452000000000000000", line_item_id: "9cqi0", entity_status: "ACTIVE", approval_status: "UNDER_REVIEW" }] },
      },
      { method: "PUT", url: `${ADS}/line_items/9cqi0`, check: (r) => expect(form(r)).toEqual({ entity_status: "ACTIVE" }), json: { data: { id: "9cqi0" } } },
      { method: "PUT", url: `${ADS}/campaigns/hwtbm`, check: (r) => expect(form(r)).toEqual({ entity_status: "ACTIVE" }), json: { data: { id: "hwtbm" } } },
    ]);
    const x = create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW, readAsset: async () => bytes });
    const launched = await x.launch(testSpec({ identity, creatives: [{ ...testSpec().creatives[0]!, asset: video }] }));
    expect(launched).toEqual({
      platform: "x",
      campaignId: "hwtbm",
      refs: { lineItemId: "9cqi0", fundingInstrumentId: "lygyi", currency: "USD", createdAt: "2026-10-28T10:30:00.000Z" },
      ads: { "B-4-v1": "pt1" },
    });
    expect(f.done()).toBe(true);
    for (const c of f.calls) signed(c);
  });

  test("failure after the campaign exists deletes it and rethrows PlatformError", async () => {
    const f = scriptedFetch([
      ...preCampaign(),
      { method: "POST", url: `${ADS}/campaigns`, json: { data: { id: "hwtbm" } } },
      { method: "POST", url: `${ADS}/line_items`, status: 400, json: { errors: [{ code: "INVALID_PARAMETER", message: "bad objective" }] } },
      { method: "DELETE", url: `${ADS}/campaigns/hwtbm`, json: { data: { id: "hwtbm", deleted: true } } },
    ]);
    const x = create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW, readAsset: async () => bytes });
    const err = await x.launch(testSpec({ identity, creatives: [{ ...testSpec().creatives[0]!, asset: video }] })).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect((err as PlatformError).status).toBe(400);
    expect(f.done()).toBe(true);
  });

  test("refuses before creating anything when the app account is not promotable, or the asset ratio is unsupported", async () => {
    const f = scriptedFetch([{ method: "GET", url: `${ADS}/promotable_users`, json: { data: [{ user_id: "999" }] } }]);
    const x = create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW });
    await expect(x.launch(testSpec({ identity }))).rejects.toThrow(/9:16/); // testAsset is 9:16
    expect(f.calls.length).toBe(0);
    await expect(x.launch(testSpec({ identity, creatives: [{ ...testSpec().creatives[0]!, asset: testImage() }] }))).rejects.toThrow(/not a promotable user/);
    await expect(x.launch(testSpec())).rejects.toThrow(/identity/);
  });
});

const launched: Launched = {
  platform: "x",
  campaignId: "hwtbm",
  refs: { lineItemId: "9cqi0", fundingInstrumentId: "lygyi", currency: "USD", createdAt: "2026-10-20T08:15:00.000Z" },
  ads: { "B-4-v1": "pt1", "B-4-v2": "pt2" },
};

describe("stats", () => {
  test("sums billed_charge_local_micro, impressions, url_clicks over 7-day windows; maps status and rejection", async () => {
    const statsQuery = (start: string, end: string) => (r: Recorded) =>
      expect(q(r)).toEqual({
        entity: "PROMOTED_TWEET",
        entity_ids: "pt1,pt2",
        start_time: start,
        end_time: end,
        granularity: "TOTAL",
        placement: "ALL_ON_TWITTER",
        metric_groups: "BILLING,ENGAGEMENT",
      });
    const f = scriptedFetch([
      {
        method: "GET",
        url: `${ADS}/campaigns/hwtbm?with_deleted=true`,
        json: { data: { id: "hwtbm", entity_status: "ACTIVE", reasons_not_servable: [] } },
      },
      {
        method: "GET",
        url: `${ADS}/promoted_tweets`,
        check: (r) => expect(q(r)).toEqual({ line_item_ids: "9cqi0", with_deleted: "true", count: "1000" }),
        json: {
          data: [
            { id: "pt1", entity_status: "ACTIVE", approval_status: "ACCEPTED" },
            { id: "pt2", entity_status: "ACTIVE", approval_status: "REJECTED" },
          ],
        },
      },
      {
        method: "GET",
        url: "https://ads-api.x.com/12/stats/accounts/18ce54d4x5t",
        check: statsQuery("2026-10-20T08:00:00Z", "2026-10-27T08:00:00Z"),
        json: {
          data_type: "stats",
          data: [
            { id: "pt1", id_data: [{ segment: null, metrics: { billed_charge_local_micro: [12_340_000], impressions: [5000], url_clicks: [80], clicks: [120] } }] },
            { id: "pt2", id_data: [{ segment: null, metrics: { billed_charge_local_micro: null, impressions: null, url_clicks: null, clicks: null } }] },
          ],
        },
      },
      {
        method: "GET",
        url: "https://ads-api.x.com/12/stats/accounts/18ce54d4x5t",
        check: statsQuery("2026-10-27T08:00:00Z", "2026-10-28T11:00:00Z"),
        json: { data: [{ id: "pt1", id_data: [{ metrics: { billed_charge_local_micro: [1_000_000], impressions: [400], clicks: [9] } }] }] },
      },
    ]);
    const x = create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW });
    const s = await x.stats(launched);
    expect(s).toEqual({
      spendUsd: 13.34,
      impressions: 5400,
      clicks: 89,
      status: "active",
      rejection: expect.stringContaining("B-4-v2"),
      byCreative: {
        "B-4-v1": { spendUsd: 13.34, impressions: 5400, clicks: 89, status: "active" },
        "B-4-v2": { spendUsd: 0, impressions: 0, clicks: 0, status: "rejected" },
      },
    });
    expect(f.done()).toBe(true);
  });

  test("in review, paused and all-rejected campaigns", async () => {
    const one: Launched = { ...launched, refs: { ...launched.refs, createdAt: "2026-10-28T09:00:00.000Z" }, ads: { "B-4-v1": "pt1" } };
    const run = async (campaign: object, pt: object) => {
      const f = scriptedFetch([
        { url: `${ADS}/campaigns/hwtbm`, json: { data: campaign } },
        { url: `${ADS}/promoted_tweets`, json: { data: [pt] } },
        { url: "/stats/accounts/", json: { data: [] } },
      ]);
      return (await create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW }).stats(one)).status;
    };
    expect(await run({ id: "hwtbm", entity_status: "ACTIVE" }, { id: "pt1", entity_status: "ACTIVE", approval_status: "UNDER_REVIEW" })).toBe("in_review");
    expect(await run({ id: "hwtbm", entity_status: "PAUSED" }, { id: "pt1", entity_status: "ACTIVE", approval_status: "ACCEPTED" })).toBe("paused");
    expect(await run({ id: "hwtbm", entity_status: "ACTIVE" }, { id: "pt1", entity_status: "ACTIVE", approval_status: "REJECTED" })).toBe("rejected");
    expect(await run({ id: "hwtbm", entity_status: "ACTIVE", deleted: true }, { id: "pt1" })).toBe("ended");
  });
});

describe("operate", () => {
  test("pause / resume / setDailyBudget update the campaign", async () => {
    const f = scriptedFetch([
      { method: "PUT", url: `${ADS}/campaigns/hwtbm`, check: (r) => expect(form(r)).toEqual({ entity_status: "PAUSED" }), json: { data: {} } },
      { method: "PUT", url: `${ADS}/campaigns/hwtbm`, check: (r) => expect(form(r)).toEqual({ entity_status: "ACTIVE" }), json: { data: {} } },
      { method: "PUT", url: `${ADS}/campaigns/hwtbm`, check: (r) => expect(form(r)).toEqual({ daily_budget_amount_local_micro: "35500000" }), json: { data: {} } },
    ]);
    const x = create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW });
    await x.pause(launched);
    await x.resume(launched);
    await x.setDailyBudget(launched, 35.5);
    await expect(x.setDailyBudget(launched, 0)).rejects.toThrow(PlatformError);
    expect(f.done()).toBe(true);
    for (const c of f.calls) signed(c);
  });

  test("429 waits until x-rate-limit-reset and retries with a fresh signature", async () => {
    const reset = Math.floor(NOW.getTime() / 1000) + 12;
    const f = scriptedFetch([
      { method: "PUT", url: `${ADS}/campaigns/hwtbm`, status: 429, headers: { "x-rate-limit-limit": "300", "x-rate-limit-remaining": "0", "x-rate-limit-reset": String(reset) }, json: { errors: [{ code: "TOO_MANY_REQUESTS" }] } },
      { method: "PUT", url: `${ADS}/campaigns/hwtbm`, json: { data: {} } },
    ]);
    const slept: number[] = [];
    const x = create(creds, { fetch: f.fetch, sleep: async (ms) => void slept.push(ms), now: () => NOW });
    await x.pause(launched);
    expect(slept).toEqual([12_000]);
    expect(f.calls[0]!.headers.authorization).not.toBe(f.calls[1]!.headers.authorization);
    expect(f.done()).toBe(true);
  });

  test("429 that persists surfaces as a retryable PlatformError", async () => {
    const r429: Expect = { method: "PUT", url: `${ADS}/campaigns/hwtbm`, status: 429, headers: { "x-account-rate-limit-reset": String(Math.floor(NOW.getTime() / 1000) + 3) }, json: {} };
    const f = scriptedFetch([r429, r429, r429]);
    const err = await create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW }).resume(launched).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect((err as PlatformError).retryable).toBe(true);
    expect((err as PlatformError).status).toBe(429);
  });
});
