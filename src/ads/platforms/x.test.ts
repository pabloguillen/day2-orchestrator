import { describe, expect, test } from "bun:test";
import { noSleep, scriptedFetch, testAsset, testImage, testSpec, type Expect, type Recorded } from "../test-helpers";
import { PlatformError, type Conversion, type Launched } from "../types";
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
const AD_LINK = "https://buddy.example/go/split?d2=B-4.x.v1";

const form = (r: Recorded) => r.json as Record<string, string>;
const q = (r: Recorded) => Object.fromEntries(new URL(r.url).searchParams);
const signed = (r: Recorded) => {
  expect(r.headers.authorization).toStartWith('OAuth oauth_consumer_key="ck", oauth_nonce="');
  expect(r.headers.authorization).toContain('oauth_signature_method="HMAC-SHA1"');
  expect(r.headers.authorization).toContain('oauth_token="at"');
  expect(r.headers.authorization).not.toContain("secret-xyz");
};
const deps = (f: ReturnType<typeof scriptedFetch>) => ({ fetch: f.fetch, sleep: noSleep, now: () => NOW, readAsset: async () => bytes });

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
    expect(info.clickIdParam).toBe("twclid");
    expect(info.identity).toBe("app_account");
    expect(info.audiences).toEqual(["consumer", "business"]);
    expect(info.copyLimits.body).toBe(256);
    expect(info.formats.map((f) => `${f.kind} ${f.ratio}`)).toEqual(["video 16:9", "video 1:1", "image 1:1", "image 16:9"]);
  });
});

const access = (permissions: string[]): Expect => ({ method: "GET", url: `${ADS}/authenticated_user_access`, json: { data: { user_id: "1", permissions } } });
const promotable = (type: string): Expect => ({
  method: "GET",
  url: `${ADS}/promotable_users`,
  json: { data: [{ id: "pu1", user_id: APP_USER, promotable_user_type: type, deleted: false }] },
});
const accountChecks = (currency = "EUR"): Expect[] => [
  { method: "GET", url: new RegExp(`${ADS}$`), json: { data: { id: "18ce54d4x5t", name: "day2 ads", approval_status: "ACCEPTED", deleted: false } } },
  {
    method: "GET",
    url: `${ADS}/funding_instruments`,
    check: (r) => expect(q(r)).toEqual({ count: "200" }),
    json: { data: [{ id: "old", entity_status: "CANCELLED", currency, able_to_fund: false }, { id: "lygyi", entity_status: "ACTIVE", currency, able_to_fund: true, deleted: false }] },
  },
  access(["AD_MANAGER", "TWEET_COMPOSER"]),
];

/** The calls before the campaign exists, for one video creative in DE. */
function preCampaign(): Expect[] {
  return [
    promotable("FULL"),
    access(["AD_MANAGER", "TWEET_COMPOSER"]),
    ...accountChecks(),
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
        const fd = r.body as FormData;
        expect(fd.get("segment_index")).toBe("0");
        expect((fd.get("media") as Blob).size).toBe(5);
      },
      json: {},
    },
    { method: "POST", url: "https://api.x.com/2/media/upload/111/finalize", json: { data: { id: "111", media_key: "13_111", processing_info: { state: "pending", check_after_secs: 1 } } } },
    { method: "GET", url: "https://api.x.com/2/media/upload?command=STATUS&media_id=111", json: { data: { id: "111", processing_info: { state: "in_progress", check_after_secs: 1 } } } },
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
      check: (r) => expect(form(r)).toEqual({ media_key: "13_111", name: "day2 Buddy B-4 B-4-v1", poster_media_key: "3_222" }),
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
            { type: "DETAILS", title: "Split a dinner bill in 10 seconds", destination: { type: "WEBSITE", url: AD_LINK } },
          ],
        });
      },
      json: { data: { id: "c1", card_uri: "card://1326399865065238531" } },
    },
    {
      method: "POST",
      url: `${ADS}/tweet`,
      check: (r) => {
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

const lineItem = (extra: Record<string, string> = {}): Expect => ({
  method: "POST",
  url: `${ADS}/line_items`,
  check: (r) =>
    expect(form(r)).toEqual({
      campaign_id: "hwtbm",
      name: "day2 Buddy B-4",
      objective: "WEBSITE_CLICKS",
      ...extra,
      product_type: "PROMOTED_TWEETS",
      placements: "ALL_ON_TWITTER",
      bid_strategy: "AUTO",
      advertiser_domain: "buddy.example",
      start_time: "2026-10-28T10:30:00.000Z",
      end_time: "2027-10-28T10:30:00.000Z",
      entity_status: "PAUSED",
    }),
  json: { data: { id: "9cqi0", entity_status: "PAUSED" } },
});

function postCampaign(): Expect[] {
  return [
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
  ];
}

const campaignCreate: Expect = {
  method: "POST",
  url: `${ADS}/campaigns`,
  check: (r) => expect(form(r)).toEqual({ funding_instrument_id: "lygyi", name: "day2 Buddy B-4", daily_budget_amount_local_micro: "25500000", entity_status: "PAUSED" }),
  json: { data: { id: "hwtbm", entity_status: "PAUSED" } },
};
const spec = (over: Parameters<typeof testSpec>[0] = {}) =>
  testSpec({ identity, dailyBudget: 25.5, currency: "EUR", creatives: [{ ...testSpec().creatives[0]!, asset: video, link: AD_LINK }], ...over });

describe("launch", () => {
  test("video creative (clicks): upload, library, card with the ad's link, promoted-only post, paused campaign in account currency, line item, targeting, promoted tweet, activate", async () => {
    const f = scriptedFetch([...preCampaign(), campaignCreate, lineItem(), ...postCampaign()]);
    const launched = await create(creds, deps(f)).launch(spec());
    expect(launched).toEqual({
      platform: "x",
      campaignId: "hwtbm",
      refs: { lineItemId: "9cqi0", fundingInstrumentId: "lygyi", currency: "EUR", createdAt: "2026-10-28T10:30:00.000Z", "tweet:B-4-v1": "1452000000000000000" },
      ads: { "B-4-v1": "pt1" },
    });
    expect(f.done()).toBe(true);
    for (const c of f.calls) signed(c);
  });

  test("signups: line item goal WEBSITE_CONVERSIONS with the sign-up web event tag", async () => {
    const f = scriptedFetch([...preCampaign(), campaignCreate, lineItem({ goal: "WEBSITE_CONVERSIONS", primary_web_event_tag: "o3bk1" }), ...postCampaign()]);
    await create(creds, deps(f)).launch(spec({ optimizeFor: "signups", conversion: { platform: "x", refs: { signup: "o3bk1", signupPixel: "ny3od" } } }));
    expect(f.done()).toBe(true);
  });

  test("signups without a conversion setup is refused before any call", async () => {
    const f = scriptedFetch([]);
    await expect(create(creds, deps(f)).launch(spec({ optimizeFor: "signups" }))).rejects.toThrow(/ensureConversions/);
    expect(f.calls.length).toBe(0);
  });

  test("budget currency must match the funding instrument", async () => {
    const f = scriptedFetch([promotable("FULL"), access(["AD_MANAGER", "TWEET_COMPOSER"]), ...accountChecks("USD")]);
    await expect(create(creds, deps(f)).launch(spec())).rejects.toThrow(/EUR.*USD/);
    expect(f.done()).toBe(true);
  });

  test("failure after the campaign exists deletes it and rethrows PlatformError", async () => {
    const f = scriptedFetch([
      ...preCampaign(),
      campaignCreate,
      { method: "POST", url: `${ADS}/line_items`, status: 400, json: { errors: [{ code: "INVALID_PARAMETER", message: "bad objective" }] } },
      { method: "DELETE", url: `${ADS}/campaigns/hwtbm`, json: { data: { id: "hwtbm", deleted: true } } },
    ]);
    const err = await create(creds, deps(f)).launch(spec()).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect((err as PlatformError).status).toBe(400);
    expect(f.done()).toBe(true);
  });

  test("refuses before creating anything: unsupported ratio, non-promotable / RETWEETS_ONLY identity, missing identity", async () => {
    const f = scriptedFetch([{ method: "GET", url: `${ADS}/promotable_users`, json: { data: [{ user_id: "999", promotable_user_type: "FULL" }] } }, promotable("RETWEETS_ONLY")]);
    const x = create(creds, deps(f));
    await expect(x.launch(spec({ creatives: [{ ...testSpec().creatives[0]! }] }))).rejects.toThrow(/9:16/); // testAsset is 9:16
    expect(f.calls.length).toBe(0);
    const img = [{ ...testSpec().creatives[0]!, asset: testImage() }];
    await expect(x.launch(spec({ creatives: img }))).rejects.toThrow(/not a promotable user/);
    await expect(x.launch(spec({ creatives: img }))).rejects.toThrow(/RETWEETS_ONLY/);
    await expect(x.launch(spec({ identity: null }))).rejects.toThrow(/identity/);
    expect(f.done()).toBe(true);
  });
});

const launched: Launched = {
  platform: "x",
  campaignId: "hwtbm",
  refs: { lineItemId: "9cqi0", fundingInstrumentId: "lygyi", currency: "EUR", createdAt: "2026-10-20T08:15:00.000Z", "tweet:B-4-v1": "t1", "tweet:B-4-v2": "t2" },
  ads: { "B-4-v1": "pt1", "B-4-v2": "pt2" },
};

describe("stats", () => {
  test("sums billed_charge_local_micro, impressions, url_clicks over 7-day windows (incl. re-attached posts); maps status and rejection", async () => {
    const statsQuery = (start: string, end: string) => (r: Recorded) =>
      expect(q(r)).toEqual({
        entity: "PROMOTED_TWEET",
        entity_ids: "pt1,pt2,pt3",
        start_time: start,
        end_time: end,
        granularity: "TOTAL",
        placement: "ALL_ON_TWITTER",
        metric_groups: "BILLING,ENGAGEMENT",
      });
    const f = scriptedFetch([
      { method: "GET", url: `${ADS}/campaigns/hwtbm?with_deleted=true`, json: { data: { id: "hwtbm", entity_status: "ACTIVE", reasons_not_servable: [] } } },
      {
        method: "GET",
        url: `${ADS}/promoted_tweets`,
        check: (r) => expect(q(r)).toEqual({ line_item_ids: "9cqi0", with_deleted: "true", count: "1000" }),
        json: {
          data: [
            { id: "pt1", tweet_id: "t1", entity_status: "ACTIVE", approval_status: "ACCEPTED", deleted: true },
            { id: "pt2", tweet_id: "t2", entity_status: "ACTIVE", approval_status: "REJECTED" },
            { id: "pt3", tweet_id: "t1", entity_status: "ACTIVE", approval_status: "ACCEPTED" },
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
        json: { data: [{ id: "pt3", id_data: [{ metrics: { billed_charge_local_micro: [1_000_000], impressions: [400], clicks: [9] } }] }] },
      },
    ]);
    const s = await create(creds, deps(f)).stats(launched);
    expect(s).toEqual({
      spend: 13.34,
      currency: "EUR",
      impressions: 5400,
      clicks: 89,
      status: "active",
      rejection: expect.stringContaining("B-4-v2"),
      byCreative: {
        "B-4-v1": { spend: 13.34, impressions: 5400, clicks: 89, status: "active" },
        "B-4-v2": { spend: 0, impressions: 0, clicks: 0, status: "rejected" },
      },
    });
    expect(f.done()).toBe(true);
  });

  test("in review, paused, all-rejected, ended", async () => {
    const one: Launched = { ...launched, refs: { ...launched.refs, createdAt: "2026-10-28T09:00:00.000Z" }, ads: { "B-4-v1": "pt1" } };
    const run = async (campaign: object, pt: object) => {
      const f = scriptedFetch([
        { url: `${ADS}/campaigns/hwtbm`, json: { data: campaign } },
        { url: `${ADS}/promoted_tweets`, json: { data: [pt] } },
        { url: "/stats/accounts/", json: { data: [] } },
      ]);
      return (await create(creds, deps(f)).stats(one)).status;
    };
    expect(await run({ id: "hwtbm", entity_status: "ACTIVE" }, { id: "pt1", tweet_id: "t1", entity_status: "ACTIVE", approval_status: "UNDER_REVIEW" })).toBe("in_review");
    expect(await run({ id: "hwtbm", entity_status: "PAUSED" }, { id: "pt1", tweet_id: "t1", entity_status: "ACTIVE", approval_status: "ACCEPTED" })).toBe("paused");
    expect(await run({ id: "hwtbm", entity_status: "ACTIVE" }, { id: "pt1", tweet_id: "t1", entity_status: "ACTIVE", approval_status: "REJECTED" })).toBe("rejected");
    expect(await run({ id: "hwtbm", entity_status: "ACTIVE" }, { id: "pt1", tweet_id: "t1", approval_status: "ACCEPTED", deleted: true })).toBe("paused");
    expect(await run({ id: "hwtbm", entity_status: "ACTIVE", deleted: true }, { id: "pt1" })).toBe("ended");
  });
});

describe("operate", () => {
  test("pause / resume / setDailyBudget (local micro) update the campaign", async () => {
    const f = scriptedFetch([
      { method: "PUT", url: `${ADS}/campaigns/hwtbm`, check: (r) => expect(form(r)).toEqual({ entity_status: "PAUSED" }), json: { data: {} } },
      { method: "PUT", url: `${ADS}/campaigns/hwtbm`, check: (r) => expect(form(r)).toEqual({ entity_status: "ACTIVE" }), json: { data: {} } },
      { method: "PUT", url: `${ADS}/campaigns/hwtbm`, check: (r) => expect(form(r)).toEqual({ daily_budget_amount_local_micro: "35500000" }), json: { data: {} } },
    ]);
    const x = create(creds, deps(f));
    await x.pause(launched);
    await x.resume(launched);
    await x.setDailyBudget(launched, 35.5);
    await expect(x.setDailyBudget(launched, 0)).rejects.toThrow(PlatformError);
    expect(f.done()).toBe(true);
    for (const c of f.calls) signed(c);
  });

  test("setAdActive: false detaches the live promoted tweet, true re-attaches the post (idempotent)", async () => {
    const list = (data: object[]): Expect => ({ method: "GET", url: `${ADS}/promoted_tweets?line_item_ids=9cqi0`, json: { data } });
    const f = scriptedFetch([
      list([{ id: "pt1", tweet_id: "t1" }, { id: "pt2", tweet_id: "t2" }]),
      { method: "DELETE", url: `${ADS}/promoted_tweets/pt1`, json: { data: { id: "pt1", deleted: true } } },
      list([{ id: "pt1", tweet_id: "t1", deleted: true }, { id: "pt2", tweet_id: "t2" }]),
      { method: "POST", url: `${ADS}/promoted_tweets`, check: (r) => expect(form(r)).toEqual({ line_item_id: "9cqi0", tweet_ids: "t1" }), json: { data: [{ id: "pt3", tweet_id: "t1" }] } },
      list([{ id: "pt1", tweet_id: "t1", deleted: true }, { id: "pt3", tweet_id: "t1" }]),
    ]);
    const x = create(creds, deps(f));
    await x.setAdActive(launched, "B-4-v1", false);
    await x.setAdActive(launched, "B-4-v1", true);
    await x.setAdActive(launched, "B-4-v1", true); // already live: no call
    await expect(x.setAdActive(launched, "nope", true)).rejects.toThrow(/unknown creative/);
    expect(f.done()).toBe(true);
  });

  test("accountInfo: name, funding instrument currency, canSpend", async () => {
    const f = scriptedFetch(accountChecks("EUR"));
    expect(await create(creds, deps(f)).accountInfo()).toEqual({ id: "18ce54d4x5t", name: "day2 ads", currency: "EUR", canSpend: true });
    const g = scriptedFetch([
      { url: new RegExp(`${ADS}$`), json: { data: { id: "18ce54d4x5t", name: "day2 ads", approval_status: "UNDER_REVIEW" } } },
      { url: `${ADS}/funding_instruments`, json: { data: [] } },
      access(["CAMPAIGN_ANALYST"]),
    ]);
    const info2 = await create(creds, deps(g)).accountInfo();
    expect(info2.canSpend).toBe(false);
    expect(info2.problem).toContain("UNDER_REVIEW");
    expect(info2.problem).toContain("funding instrument");
    expect(info2.problem).toContain("Ad manager");
  });

  test("checkIdentity: ok for FULL + composer, explains what is missing otherwise", async () => {
    const f = scriptedFetch([promotable("FULL"), access(["ACCOUNT_ADMIN", "TWEET_COMPOSER"]), promotable("FULL"), access(["AD_MANAGER"])]);
    const x = create(creds, deps(f));
    expect(await x.checkIdentity!(identity)).toEqual({ ok: true });
    const r = await x.checkIdentity!(identity);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problem).toContain("TWEET_COMPOSER");
    expect(await x.checkIdentity!({ ...identity, ref: "@buddy" })).toMatchObject({ ok: false });
  });

  test("ensureConversions finds the existing tag by name and creates the missing one", async () => {
    const f = scriptedFetch([
      { method: "GET", url: `${ADS}/web_event_tags`, json: { data: [{ id: "o3bk1", name: "day2 signup", type: "SIGN_UP", website_tag_id: "ny3od", deleted: false }] } },
      {
        method: "POST",
        url: `${ADS}/web_event_tags`,
        check: (r) => expect(form(r)).toEqual({ name: "day2 activated", type: "CUSTOM", click_window: "30", view_through_window: "1", retargeting_enabled: "false" }),
        json: { data: { id: "o3bk2", name: "day2 activated", type: "CUSTOM", website_tag_id: "ny3od" } },
      },
    ]);
    expect(await create(creds, deps(f)).ensureConversions!()).toEqual({
      platform: "x",
      refs: { signup: "o3bk1", signupPixel: "ny3od", activated: "o3bk2", activatedPixel: "ny3od" },
    });
    expect(f.done()).toBe(true);
  });

  test("sendConversions posts twclid (+ IPv4 / user agent) conversions with conversion_id = eventId", async () => {
    const setup = { platform: "x" as const, refs: { signup: "o3bk1", signupPixel: "ny3od", activated: "o3bk2", activatedPixel: "ny3od" } };
    const ev = (eventId: string, param = "twclid", device: Partial<Conversion> = {}): Conversion => ({
      eventId,
      name: "signup",
      at: "2026-10-28T09:12:00Z",
      click: { param, value: "26ab7ql5k0yf4mq" },
      pageUrl: "https://buddy.example/go/split",
      externalId: "hashed-user",
      ...device,
    });
    const f = scriptedFetch([
      {
        method: "POST",
        url: "https://ads-api.x.com/12/measurement/conversions/ny3od",
        check: (r) => {
          signed(r);
          expect(r.json).toEqual({
            conversions: [
              {
                conversion_time: "2026-10-28T09:12:00.000Z",
                event_id: "tw-ny3od-o3bk1",
                identifiers: [{ twclid: "26ab7ql5k0yf4mq" }, { ip_address: "8.25.197.25", user_agent: "Mozilla/5.0 (iPhone)" }],
                conversion_id: "dev-1:signup",
                description: "day2 signup",
              },
              // IPv6 is not documented by X: only the user agent goes along.
              { conversion_time: "2026-10-28T09:12:00.000Z", event_id: "tw-ny3od-o3bk1", identifiers: [{ twclid: "26ab7ql5k0yf4mq" }, { user_agent: "UA2" }], conversion_id: "dev-3:signup", description: "day2 signup" },
              { conversion_time: "2026-10-28T09:12:00.000Z", event_id: "tw-ny3od-o3bk1", identifiers: [{ twclid: "26ab7ql5k0yf4mq" }], conversion_id: "dev-4:signup", description: "day2 signup" },
            ],
          });
        },
        json: { data: { conversions_processed: 3, debug_id: "d" } },
      },
    ]);
    const res = await create(creds, deps(f)).sendConversions!(setup, [
      ev("dev-1:signup", "twclid", { clientIp: " 8.25.197.25 ", userAgent: " Mozilla/5.0 (iPhone) " }),
      ev("dev-2:signup", "fbclid"),
      ev("dev-3:signup", "twclid", { clientIp: "2001:db8::1", userAgent: "UA2" }),
      ev("dev-4:signup"),
    ]);
    expect(res).toEqual({ sent: 3, rejected: [{ eventId: "dev-2:signup", why: "no twclid click id" }] });
    expect(f.done()).toBe(true);
  });

  test("429 waits until x-rate-limit-reset and retries with a fresh signature", async () => {
    const reset = Math.floor(NOW.getTime() / 1000) + 12;
    const f = scriptedFetch([
      { method: "PUT", url: `${ADS}/campaigns/hwtbm`, status: 429, headers: { "x-rate-limit-limit": "300", "x-rate-limit-remaining": "0", "x-rate-limit-reset": String(reset) }, json: { errors: [{ code: "TOO_MANY_REQUESTS" }] } },
      { method: "PUT", url: `${ADS}/campaigns/hwtbm`, json: { data: {} } },
    ]);
    const slept: number[] = [];
    await create(creds, { fetch: f.fetch, sleep: async (ms) => void slept.push(ms), now: () => NOW }).pause(launched);
    expect(slept).toEqual([12_000]);
    expect(f.calls[0]!.headers.authorization).not.toBe(f.calls[1]!.headers.authorization);
    expect(f.done()).toBe(true);
  });

  test("429 that persists surfaces as a retryable PlatformError", async () => {
    const r429: Expect = { method: "PUT", url: `${ADS}/campaigns/hwtbm`, status: 429, headers: { "x-account-rate-limit-reset": String(Math.floor(NOW.getTime() / 1000) + 3) }, json: {} };
    const f = scriptedFetch([r429, r429, r429]);
    const err = await create(creds, deps(f)).resume(launched).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect((err as PlatformError).retryable).toBe(true);
    expect((err as PlatformError).status).toBe(429);
  });
});
