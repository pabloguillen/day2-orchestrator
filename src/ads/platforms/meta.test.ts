import { describe, expect, test } from "bun:test";
import { noSleep, scriptedFetch, testAsset, testImage, testSpec, type Recorded } from "../test-helpers";
import { PlatformError, type Launched } from "../types";
import { create, credentialsFromEnv, info, META_API_VERSION, type MetaCreds } from "./meta";

const creds: MetaCreds = { accessToken: "EAAsecret", adAccountId: "act_123", apiVersion: META_API_VERSION, dsaPayor: "day2" };
const G = `https://graph.facebook.com/${META_API_VERSION}`;
const bytes = async () => new Uint8Array([1, 2, 3]);
const body = (r: Recorded) => r.json as Record<string, string>;
const parsed = (r: Recorded, k: string) => JSON.parse(body(r)[k] ?? "null");

const spec = () =>
  testSpec({
    identity: { platform: "meta", ref: "777:888", displayName: "Buddy" },
    targeting: { countries: ["DE"], languages: ["de"], ageMin: 18, ageMax: 44, audience: "consumer", interests: [], keywords: [] },
    creatives: [
      { key: "B-4-v1-9x16", copy: { headline: "Split a dinner bill in 10 seconds", body: "Add the bill, pick who was there, done.", description: "Free for groups", cta: "sign_up" }, asset: testAsset() },
      { key: "B-4-v1-1x1", copy: { headline: "Split bills with friends, no math needed at all, ever", body: "Fast.", cta: "download" }, asset: testImage() },
    ],
  });

const launched: Launched = { platform: "meta", campaignId: "c1", refs: { adSetId: "as1", adAccountId: "act_123" }, ads: { "B-4-v1-9x16": "ad1", "B-4-v1-1x1": "ad2" } };

describe("meta info + credentials", () => {
  test("credentialsFromEnv returns null when vars are missing", () => {
    expect(credentialsFromEnv({})).toBeNull();
    expect(credentialsFromEnv({ META_ACCESS_TOKEN: "x" })).toBeNull();
    expect(credentialsFromEnv({ DAY2_META_AD_ACCOUNT_ID: "123" })).toBeNull();
    expect(credentialsFromEnv({ META_ACCESS_TOKEN: "x", DAY2_META_AD_ACCOUNT_ID: "not-an-id" })).toBeNull();
  });

  test("credentialsFromEnv normalizes the account id", () => {
    expect(credentialsFromEnv({ META_ACCESS_TOKEN: "x", DAY2_META_AD_ACCOUNT_ID: "123" })?.adAccountId).toBe("act_123");
    const c = credentialsFromEnv({ META_ACCESS_TOKEN: "x", DAY2_META_AD_ACCOUNT_ID: "act_456", META_APP_SECRET: "s", META_API_VERSION: "v25.0" });
    expect(c).toMatchObject({ adAccountId: "act_456", appSecret: "s", apiVersion: "v25.0" });
  });

  test("info", () => {
    expect(info.id).toBe("meta");
    expect(info.formats.map((f) => `${f.kind}:${f.ratio}`)).toEqual(expect.arrayContaining(["video:9:16", "image:1:1", "video:4:5", "image:4:5"]));
    expect(info.apiVersion).toBe(META_API_VERSION);
  });
});

describe("meta launch", () => {
  test("uploads media, creates creatives, campaign paused → ad set → ads → campaign active", async () => {
    const f = scriptedFetch([
      { method: "GET", url: `${G}/act_123?fields=currency%2Caccount_status`, json: { currency: "USD", account_status: 1, id: "act_123" } },
      { method: "GET", url: `${G}/search?type=adlocale&q=German`, json: { data: [{ key: 5, name: "German" }] } },
      {
        method: "POST",
        url: `${G}/act_123/advideos`,
        check: (r) => expect(body(r)).toEqual({ file_url: "https://day2.example/api/assets/as_video1.mp4", name: "as_video1" }),
        json: { id: "v1" },
      },
      { method: "POST", url: `${G}/act_123/adimages`, check: (r) => expect(body(r)).toEqual({ bytes: "AQID" }), json: { images: { bytes: { hash: "h_thumb", url: "https://x" } } } },
      { method: "GET", url: `${G}/v1?fields=status`, json: { status: { video_status: "processing" } } },
      { method: "GET", url: `${G}/v1?fields=status`, json: { status: { video_status: "ready" } } },
      { method: "POST", url: `${G}/act_123/adimages`, json: { images: { bytes: { hash: "h_img" } } } },
      {
        method: "POST",
        url: `${G}/act_123/adcreatives`,
        check: (r) => {
          expect(body(r).name).toBe("day2 Buddy B-4 · B-4-v1-9x16");
          expect(parsed(r, "object_story_spec")).toEqual({
            page_id: "777",
            instagram_user_id: "888",
            video_data: {
              video_id: "v1",
              image_hash: "h_thumb",
              message: "Add the bill, pick who was there, done.",
              title: "Split a dinner bill in 10 seconds",
              link_description: "Free for groups",
              call_to_action: { type: "SIGN_UP", value: { link: "https://buddy.example/go/split?d2=B-4.x" } },
            },
          });
        },
        json: { id: "cr1" },
      },
      {
        method: "POST",
        url: `${G}/act_123/adcreatives`,
        check: (r) => {
          const s = parsed(r, "object_story_spec");
          expect(s.link_data).toEqual({
            image_hash: "h_img",
            link: "https://buddy.example/go/split?d2=B-4.x",
            message: "Fast.",
            name: "Split bills with friends, no math…",
            call_to_action: { type: "DOWNLOAD", value: { link: "https://buddy.example/go/split?d2=B-4.x" } },
          });
          expect(s.link_data.name.length).toBeLessThanOrEqual(info.copyLimits.headline);
        },
        json: { id: "cr2" },
      },
      {
        method: "POST",
        url: `${G}/act_123/campaigns`,
        check: (r) =>
          expect(body(r)).toEqual({
            name: "day2 Buddy B-4",
            objective: "OUTCOME_TRAFFIC",
            status: "PAUSED",
            buying_type: "AUCTION",
            special_ad_categories: "[]",
            is_adset_budget_sharing_enabled: "false",
          }),
        json: { id: "c1" },
      },
      {
        method: "POST",
        url: `${G}/act_123/adsets`,
        check: (r) => {
          const b = body(r);
          expect(b).toMatchObject({
            name: "day2 Buddy B-4 · ad set",
            campaign_id: "c1",
            daily_budget: "2000",
            billing_event: "IMPRESSIONS",
            optimization_goal: "LINK_CLICKS",
            bid_strategy: "LOWEST_COST_WITHOUT_CAP",
            destination_type: "WEBSITE",
            status: "ACTIVE",
            dsa_beneficiary: "Buddy",
            dsa_payor: "day2",
          });
          expect(parsed(r, "targeting")).toEqual({ geo_locations: { countries: ["DE"] }, age_min: 18, age_max: 44, locales: [5], targeting_automation: { advantage_audience: 0 } });
          expect(b.publisher_platforms).toBeUndefined(); // Advantage+ placements
        },
        json: { id: "as1" },
      },
      { method: "POST", url: `${G}/act_123/ads`, check: (r) => expect(body(r)).toEqual({ name: "day2 Buddy B-4 · B-4-v1-9x16", adset_id: "as1", creative: '{"creative_id":"cr1"}', status: "ACTIVE" }), json: { id: "ad1" } },
      { method: "POST", url: `${G}/act_123/ads`, check: (r) => expect(parsed(r, "creative")).toEqual({ creative_id: "cr2" }), json: { id: "ad2" } },
      { method: "POST", url: `${G}/c1`, check: (r) => expect(body(r)).toEqual({ status: "ACTIVE" }), json: { success: true } },
    ]);
    const meta = create(creds, { fetch: f.fetch, sleep: noSleep, readAsset: bytes });
    const out = await meta.launch(spec());
    expect(out).toEqual(launched);
    expect(f.done()).toBe(true);
    for (const c of f.calls) {
      expect(c.headers.authorization).toBe("OAuth EAAsecret");
      expect(c.url).not.toContain("EAAsecret");
      expect(c.url).not.toContain("appsecret_proof"); // no app secret configured
    }
  });

  test("adds appsecret_proof when META_APP_SECRET is set", async () => {
    const f = scriptedFetch([{ method: "POST", url: /\/c1\?appsecret_proof=[0-9a-f]{64}$/, json: { success: true } }]);
    await create({ ...creds, appSecret: "shh" }, { fetch: f.fetch, sleep: noSleep }).pause(launched);
    expect(f.done()).toBe(true);
  });

  test("a failure after the campaign exists deletes it and rethrows", async () => {
    const one = testSpec({ identity: { platform: "meta", ref: "777", displayName: "Buddy" }, targeting: { ...testSpec().targeting, countries: ["US"], languages: [] }, creatives: [{ key: "k", copy: testSpec().creatives[0]!.copy, asset: testImage() }] });
    const f = scriptedFetch([
      { url: "/act_123?fields", json: { currency: "USD", account_status: 1 } },
      { url: "/act_123/adimages", json: { images: { bytes: { hash: "h" } } } },
      { url: "/act_123/adcreatives", check: (r) => expect(parsed(r, "object_story_spec").instagram_user_id).toBeUndefined(), json: { id: "cr1" } },
      { url: "/act_123/campaigns", json: { id: "c9" } },
      { url: "/act_123/adsets", check: (r) => expect(body(r).dsa_payor).toBeUndefined(), json: { id: "as9" } },
      { url: "/act_123/ads", status: 400, json: { error: { message: "Invalid parameter", code: 100, error_subcode: 1487390, error_user_msg: "The link is not allowed" } } },
      { method: "DELETE", url: `${G}/c9`, json: { success: true } },
    ]);
    const err = await create(creds, { fetch: f.fetch, sleep: noSleep, readAsset: bytes })
      .launch(one)
      .catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.message).toContain("deleted the campaign");
    expect(err.message).toContain("The link is not allowed (code 100/1487390)");
    expect(err.retryable).toBe(false);
    expect(f.done()).toBe(true);
  });

  test("refuses a non-USD account before creating anything", async () => {
    const f = scriptedFetch([{ url: "/act_123?fields", json: { currency: "EUR", account_status: 1 } }]);
    await expect(create(creds, { fetch: f.fetch, sleep: noSleep }).launch(spec())).rejects.toThrow("expected USD");
    expect(f.done()).toBe(true);
  });
});

describe("meta stats", () => {
  test("maps spend, impressions, link clicks, status, per-creative and rejection", async () => {
    const f = scriptedFetch([
      { method: "GET", url: `${G}/c1?fields=effective_status`, json: { effective_status: "ACTIVE", id: "c1" } },
      { method: "GET", url: `${G}/c1/ads?fields=id%2Cname%2Ceffective_status%2Cad_review_feedback`, json: { data: [
        { id: "ad1", effective_status: "ACTIVE" },
        { id: "ad2", effective_status: "DISAPPROVED", ad_review_feedback: { global: { "Misleading Claims": "Ads can't include misleading claims." } } },
      ] } },
      {
        method: "GET",
        url: `${G}/c1/insights`,
        check: (r) => {
          const q = new URL(r.url).searchParams;
          expect(q.get("level")).toBe("ad");
          expect(q.get("date_preset")).toBe("maximum");
          expect(q.get("fields")).toBe("ad_id,spend,impressions,inline_link_clicks,account_currency");
        },
        json: { data: [
          { ad_id: "ad1", spend: "12.34", impressions: "4000", inline_link_clicks: "80", account_currency: "USD" },
          { ad_id: "ad2", spend: "0.10", impressions: "15", inline_link_clicks: "1", account_currency: "USD" },
        ] },
      },
    ]);
    const s = await create(creds, { fetch: f.fetch, sleep: noSleep }).stats(launched);
    expect(s).toEqual({
      spendUsd: 12.44,
      impressions: 4015,
      clicks: 81,
      status: "active",
      rejection: "B-4-v1-1x1: Ads can't include misleading claims.",
      byCreative: {
        "B-4-v1-9x16": { spendUsd: 12.34, impressions: 4000, clicks: 80, status: "active" },
        "B-4-v1-1x1": { spendUsd: 0.1, impressions: 15, clicks: 1, status: "rejected" },
      },
    });
  });

  test("all ads in review / all rejected", async () => {
    const run = async (statuses: string[]) => {
      const f = scriptedFetch([
        { url: "/c1?fields", json: { effective_status: "ACTIVE" } },
        { url: "/c1/ads", json: { data: statuses.map((s, i) => ({ id: `ad${i + 1}`, effective_status: s })) } },
        { url: "/c1/insights", json: { data: [] } },
      ]);
      return create(creds, { fetch: f.fetch, sleep: noSleep }).stats(launched);
    };
    expect((await run(["PENDING_REVIEW", "IN_PROCESS"])).status).toBe("in_review");
    const r = await run(["DISAPPROVED", "DISAPPROVED"]);
    expect(r.status).toBe("rejected");
    expect(r.spendUsd).toBe(0);
  });
});

describe("meta operations", () => {
  test("pause / resume set the campaign status", async () => {
    const f = scriptedFetch([
      { method: "POST", url: `${G}/c1`, check: (r) => expect(body(r)).toEqual({ status: "PAUSED" }), json: { success: true } },
      { method: "POST", url: `${G}/c1`, check: (r) => expect(body(r)).toEqual({ status: "ACTIVE" }), json: { success: true } },
    ]);
    const meta = create(creds, { fetch: f.fetch, sleep: noSleep });
    await meta.pause(launched);
    await meta.resume(launched);
    expect(f.done()).toBe(true);
  });

  test("setDailyBudget sends cents to the ad set", async () => {
    const f = scriptedFetch([{ method: "POST", url: `${G}/as1`, check: (r) => expect(body(r)).toEqual({ daily_budget: "1250" }), json: { success: true } }]);
    await create(creds, { fetch: f.fetch, sleep: noSleep }).setDailyBudget(launched, 12.5);
    expect(f.done()).toBe(true);
    await expect(create(creds, { fetch: f.fetch }).setDailyBudget(launched, 0.5)).rejects.toThrow("at least $1");
  });

  test("retries a 429 then succeeds", async () => {
    const f = scriptedFetch([
      { method: "POST", url: `${G}/c1`, status: 429, headers: { "retry-after": "1" }, json: { error: { message: "rate limited", code: 17 } } },
      { method: "POST", url: `${G}/c1`, json: { success: true } },
    ]);
    await create(creds, { fetch: f.fetch, sleep: noSleep }).pause(launched);
    expect(f.done()).toBe(true);
  });

  test("Graph throttling sent as 400 is marked retryable", async () => {
    const f = scriptedFetch([{ url: `${G}/c1`, status: 400, json: { error: { message: "User request limit reached", code: 17 } } }]);
    const err = await create(creds, { fetch: f.fetch, sleep: noSleep })
      .pause(launched)
      .catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain("EAAsecret");
  });
});
