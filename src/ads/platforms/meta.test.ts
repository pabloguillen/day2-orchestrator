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
      { key: "B-4-v1-1x1", copy: { headline: "Split bills with friends, no math needed at all, ever", body: "Fast.", cta: "download" }, asset: testImage(), link: "https://buddy.example/go/split?d2=B-4.meta.v2" },
    ],
  });

const launched: Launched = { platform: "meta", campaignId: "c1", refs: { adSetId: "as1", adAccountId: "act_123", currency: "USD" }, ads: { "B-4-v1-9x16": "ad1", "B-4-v1-1x1": "ad2" } };

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
    expect(info.clickIdParam).toBe("fbclid");
  });
});

describe("meta launch", () => {
  test("uploads media, creates creatives, campaign paused → ad set → ads → campaign active", async () => {
    const f = scriptedFetch([
      { method: "GET", url: `${G}/act_123?fields=id%2Cname%2Ccurrency%2Caccount_status%2Cdisable_reason`, json: { currency: "USD", account_status: 1, id: "act_123" } },
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
            link: "https://buddy.example/go/split?d2=B-4.meta.v2",
            message: "Fast.",
            name: "Split bills with friends, no math…",
            call_to_action: { type: "DOWNLOAD", value: { link: "https://buddy.example/go/split?d2=B-4.meta.v2" } },
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

  test("refuses when the budget currency isn't the account's, before creating anything", async () => {
    const f = scriptedFetch([{ url: "/act_123?fields", json: { currency: "EUR", account_status: 1 } }]);
    await expect(create(creds, { fetch: f.fetch, sleep: noSleep }).launch(spec())).rejects.toThrow("ad account currency is EUR, but the budget is in USD");
    expect(f.done()).toBe(true);
  });

  test("refuses an account that can't spend", async () => {
    const f = scriptedFetch([{ url: "/act_123?fields", json: { currency: "USD", account_status: 3 } }]);
    await expect(create(creds, { fetch: f.fetch, sleep: noSleep }).launch(spec())).rejects.toThrow("unsettled");
  });

  test("optimizeFor signups: OUTCOME_LEADS, OFFSITE_CONVERSIONS on the pixel's CompleteRegistration, budget in yen", async () => {
    const one = testSpec({
      identity: { platform: "meta", ref: "777", displayName: "Buddy" },
      dailyBudget: 3000,
      currency: "JPY",
      optimizeFor: "signups",
      conversion: { platform: "meta", refs: { pixelId: "px1" } },
      targeting: { ...testSpec().targeting, countries: ["JP"], languages: [] },
      creatives: [{ key: "k", copy: testSpec().creatives[0]!.copy, asset: testImage() }],
    });
    const f = scriptedFetch([
      { url: "/act_123?fields", json: { currency: "JPY", account_status: 1 } },
      { url: "/act_123/adimages", json: { images: { bytes: { hash: "h" } } } },
      { url: "/act_123/adcreatives", json: { id: "cr1" } },
      { url: "/act_123/campaigns", check: (r) => expect(body(r).objective).toBe("OUTCOME_LEADS"), json: { id: "c2" } },
      {
        url: "/act_123/adsets",
        check: (r) => {
          expect(body(r)).toMatchObject({ daily_budget: "3000", optimization_goal: "OFFSITE_CONVERSIONS", billing_event: "IMPRESSIONS", destination_type: "WEBSITE" });
          expect(parsed(r, "promoted_object")).toEqual({ pixel_id: "px1", custom_event_type: "COMPLETE_REGISTRATION" });
        },
        json: { id: "as2" },
      },
      { url: "/act_123/ads", json: { id: "ad9" } },
      { url: `${G}/c2`, json: { success: true } },
    ]);
    const out = await create(creds, { fetch: f.fetch, sleep: noSleep, readAsset: bytes }).launch(one);
    expect(out.refs).toEqual({ adSetId: "as2", adAccountId: "act_123", currency: "JPY" });
    expect(f.done()).toBe(true);
  });

  test("optimizeFor signups without a pixel is refused up front", async () => {
    const f = scriptedFetch([]);
    await expect(create(creds, { fetch: f.fetch }).launch(testSpec({ identity: { platform: "meta", ref: "777", displayName: "B" }, optimizeFor: "signups" }))).rejects.toThrow("pixel");
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
      spend: 12.44,
      currency: "USD",
      impressions: 4015,
      clicks: 81,
      status: "active",
      rejection: "B-4-v1-1x1: Ads can't include misleading claims.",
      byCreative: {
        "B-4-v1-9x16": { spend: 12.34, impressions: 4000, clicks: 80, status: "active" },
        "B-4-v1-1x1": { spend: 0.1, impressions: 15, clicks: 1, status: "rejected" },
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
    expect(r.spend).toBe(0);
    expect(r.currency).toBe("USD");
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

  test("setDailyBudget sends the account currency's minor unit to the ad set", async () => {
    const f = scriptedFetch([
      { method: "POST", url: `${G}/as1`, check: (r) => expect(body(r)).toEqual({ daily_budget: "1250" }), json: { success: true } },
      { method: "POST", url: `${G}/as1`, check: (r) => expect(body(r)).toEqual({ daily_budget: "2500" }), json: { success: true } },
      { method: "POST", url: `${G}/as1`, check: (r) => expect(body(r)).toEqual({ daily_budget: "1999" }), json: { success: true } },
    ]);
    const meta = create(creds, { fetch: f.fetch, sleep: noSleep });
    await meta.setDailyBudget(launched, 12.5); // USD → cents
    await meta.setDailyBudget({ ...launched, refs: { ...launched.refs, currency: "JPY" } }, 2500); // JPY: offset 1
    await meta.setDailyBudget({ ...launched, refs: { ...launched.refs, currency: "EUR" } }, 19.99);
    expect(f.done()).toBe(true);
    await expect(meta.setDailyBudget(launched, 0)).rejects.toThrow("positive");
    await expect(meta.setDailyBudget({ ...launched, refs: { ...launched.refs, currency: "XXX" } }, 5)).rejects.toThrow("not supported");
  });

  test("setAdActive pauses / activates one ad by creative key", async () => {
    const f = scriptedFetch([
      { method: "POST", url: /\/v26\.0\/ad2$/, check: (r) => expect(body(r)).toEqual({ status: "PAUSED" }), json: { success: true } },
      { method: "POST", url: /\/v26\.0\/ad1$/, check: (r) => expect(body(r)).toEqual({ status: "ACTIVE" }), json: { success: true } },
    ]);
    const meta = create(creds, { fetch: f.fetch, sleep: noSleep });
    await meta.setAdActive(launched, "B-4-v1-1x1", false);
    await meta.setAdActive(launched, "B-4-v1-9x16", true);
    expect(f.done()).toBe(true);
    await expect(meta.setAdActive(launched, "nope", true)).rejects.toThrow("no ad for creative nope");
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

describe("meta account, identity, conversions", () => {
  test("accountInfo maps status and disable reason", async () => {
    const f = scriptedFetch([
      { url: `${G}/act_123?fields=id%2Cname%2Ccurrency%2Caccount_status%2Cdisable_reason`, json: { id: "act_123", name: "day2", currency: "EUR", account_status: 1 } },
      { url: "/act_123?fields", json: { id: "act_123", name: "day2", currency: "EUR", account_status: 2, disable_reason: 3 } },
    ]);
    const meta = create(creds, { fetch: f.fetch, sleep: noSleep });
    expect(await meta.accountInfo()).toEqual({ id: "act_123", name: "day2", currency: "EUR", canSpend: true });
    expect(await meta.accountInfo()).toEqual({ id: "act_123", name: "day2", currency: "EUR", canSpend: false, problem: "disabled (payment risk)" });
  });

  test("checkIdentity: needs the Page with the Advertise task among day2's pages", async () => {
    const f = scriptedFetch([
      { url: `${G}/me/accounts?fields=id%2Cname%2Ctasks&limit=100`, json: { data: [{ id: "777", name: "Buddy", tasks: ["ADVERTISE", "ANALYZE"] }] } },
      { url: "/me/accounts", json: { data: [{ id: "777", name: "Buddy", tasks: ["ANALYZE"] }] } },
      { url: "/me/accounts", json: { data: [{ id: "1", tasks: ["ADVERTISE"] }], paging: { cursors: { after: "A" }, next: "https://graph.facebook.com/next" } } },
      { url: "/me/accounts?fields=id%2Cname%2Ctasks&limit=100&after=A", json: { data: [] } },
    ]);
    const meta = create(creds, { fetch: f.fetch, sleep: noSleep });
    const id = { platform: "meta" as const, ref: "777:888", displayName: "Buddy" };
    expect(await meta.checkIdentity!(id)).toEqual({ ok: true });
    expect(await meta.checkIdentity!(id)).toEqual({ ok: false, problem: "day2 can see Page Buddy but lacks the Advertise task on it" });
    const r = await meta.checkIdentity!(id);
    expect(r.ok).toBe(false);
    expect(f.done()).toBe(true);
  });

  test("ensureConversions finds the day2 pixel, or creates it", async () => {
    const f = scriptedFetch([
      { url: `${G}/act_123/adspixels?fields=id%2Cname`, json: { data: [{ id: "px0", name: "Other" }, { id: "px1", name: "day2" }] } },
      { url: "/act_123/adspixels?fields", json: { data: [] } },
      { method: "POST", url: `${G}/act_123/adspixels`, check: (r) => expect(body(r)).toEqual({ name: "day2" }), json: { id: "px2" } },
    ]);
    const meta = create(creds, { fetch: f.fetch, sleep: noSleep });
    expect(await meta.ensureConversions!()).toEqual({ platform: "meta", refs: { pixelId: "px1", adAccountId: "act_123" } });
    expect(await meta.ensureConversions!()).toEqual({ platform: "meta", refs: { pixelId: "px2", adAccountId: "act_123" } });
    expect(f.done()).toBe(true);
  });

  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";
  const setup = { platform: "meta" as const, refs: { pixelId: "px1" } };
  const at = "2026-10-28T10:00:00.000Z";
  const ms = Date.parse(at);
  const deps = (f: ReturnType<typeof scriptedFetch>) => ({ fetch: f.fetch, sleep: noSleep, now: () => new Date(ms + 60_000) });
  const sha = (v: string) => new Bun.CryptoHasher("sha256").update(v).digest("hex");

  test("sendConversions posts Conversions API events with fbc, hashed external_id and event_id", async () => {
    const hashed = sha("already-hashed-by-day2"); // a SHA-256 hex is sent as is
    const f = scriptedFetch([
      {
        method: "POST",
        url: `${G}/px1/events`,
        check: (r) =>
          expect(parsed(r, "data")).toEqual([
            {
              event_name: "CompleteRegistration",
              event_time: ms / 1000,
              event_id: "dev-1:signup",
              action_source: "website",
              event_source_url: "https://buddy.example/go/split",
              user_data: { client_ip_address: "203.0.113.7", client_user_agent: UA, fbc: `fb.1.${ms}.IwAR123`, external_id: [hashed] },
            },
            {
              event_name: "Activated",
              event_time: ms / 1000,
              event_id: "dev-2:activated",
              action_source: "website",
              event_source_url: "https://buddy.example/go/split",
              user_data: { client_user_agent: UA, fbc: `fb.1.${ms}.IwAR456`, external_id: [sha("u-2")] },
            },
          ]),
        json: { events_received: 2, messages: [], fbtrace_id: "x" },
      },
    ]);
    const r = await create(creds, deps(f)).sendConversions!(setup, [
      { eventId: "dev-1:signup", name: "signup", at, click: { param: "fbclid", value: "IwAR123" }, pageUrl: "https://buddy.example/go/split", externalId: hashed, clientIp: "203.0.113.7", userAgent: UA },
      { eventId: "dev-2:activated", name: "activated", at, click: { param: "fbclid", value: "IwAR456" }, pageUrl: "https://buddy.example/go/split", externalId: "U-2", userAgent: UA },
      { eventId: "old", name: "signup", at: "2026-10-01T00:00:00Z", click: { param: "fbclid", value: "x" }, pageUrl: "https://buddy.example/", userAgent: UA },
      { eventId: "other", name: "signup", at, click: { param: "ttclid", value: "x" }, pageUrl: "https://buddy.example/", userAgent: UA },
      { eventId: "nobrowser", name: "signup", at, click: { param: "fbclid", value: "x" }, pageUrl: "https://buddy.example/" },
    ]);
    expect(r).toEqual({
      sent: 2,
      rejected: [
        { eventId: "old", why: "older than 7 days (Meta rejects it)" },
        { eventId: "other", why: "no fbclid or external id to match on" },
        { eventId: "nobrowser", why: "no client IP or user agent (Meta needs them for website events)" },
      ],
    });
    expect(f.done()).toBe(true);
  });

  test("sendConversions isolates a bad event when Meta rejects the batch", async () => {
    const bad = { status: 400, json: { error: { message: "Invalid parameter", code: 100, error_user_msg: "event_source_url is invalid" } } };
    const f = scriptedFetch([
      { url: "/px1/events", ...bad },
      { url: "/px1/events", check: (r) => expect(parsed(r, "data")[0].event_id).toBe("a"), json: { events_received: 1 } },
      { url: "/px1/events", ...bad },
    ]);
    const ev = (eventId: string, pageUrl: string) => ({ eventId, name: "signup" as const, at, click: { param: "fbclid", value: "c" }, pageUrl, userAgent: UA });
    const r = await create(creds, deps(f)).sendConversions!(setup, [ev("a", "https://ok.example/"), ev("b", "not a url")]);
    expect(r).toEqual({ sent: 1, rejected: [{ eventId: "b", why: "event_source_url is invalid (code 100)" }] });
  });

  test("sendConversions surfaces throttling for a later retry", async () => {
    const f = scriptedFetch([{ url: "/px1/events", status: 400, json: { error: { message: "Too many calls", code: 80004 } } }]);
    const err = await create(creds, deps(f))
      .sendConversions!(setup, [{ eventId: "a", name: "signup", at, click: { param: "fbclid", value: "c" }, pageUrl: "https://ok.example/", clientIp: "198.51.100.1" }])
      .catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.retryable).toBe(true);
  });
});
