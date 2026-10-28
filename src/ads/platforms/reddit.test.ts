import { describe, expect, test } from "bun:test";
import { noSleep, scriptedFetch, testAsset, testImage, testSpec, type Expect, type Recorded } from "../test-helpers";
import { PlatformError, type Launched } from "../types";
import { BASE, create, credentialsFromEnv, DEFAULT_USER_AGENT, info, type RedditCreds } from "./reddit";

const UA = "server:day2-ads-test:1.0 (by /u/day2ops)";
const creds: RedditCreds = { clientId: "cid", clientSecret: "csecret", refreshToken: "rtok", adAccountId: "a2_acct", userAgent: UA };
const NOW = new Date("2026-10-28T12:00:00.000Z");
const identity = { platform: "reddit" as const, ref: "t2_buddy", displayName: "Buddy" };
const LINK = "https://buddy.example/go/split?d2=B-4.x";

const tokenStep: Expect = {
  method: "POST",
  url: "https://www.reddit.com/api/v1/access_token",
  check: (r) => {
    expect(r.headers.authorization).toBe(`Basic ${Buffer.from("cid:csecret").toString("base64")}`);
    expect(r.headers["user-agent"]).toBe(UA);
    expect(r.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(r.json).toEqual({ grant_type: "refresh_token", refresh_token: "rtok" });
  },
  json: { access_token: "atok", token_type: "bearer", expires_in: 86400, scope: "adsread adsedit" },
};
const authed = (r: Recorded) => {
  expect(r.headers.authorization).toBe("Bearer atok");
  expect(r.headers["user-agent"]).toBe(UA);
};

function make(script: Expect[], c: RedditCreds = creds) {
  const f = scriptedFetch(script);
  const platform = create(c, { fetch: f.fetch, sleep: noSleep, now: () => NOW });
  return { f, platform };
}

const accountStep = (over: object = {}): Expect => ({
  method: "GET",
  url: `${BASE}/ad_accounts/a2_acct`,
  check: (r) => {
    authed(r);
    expect(new URL(r.url).pathname).toBe("/api/v3/ad_accounts/a2_acct");
  },
  json: { data: { id: "a2_acct", name: "day2 ads", currency: "USD", admin_approval: "APPROVED", suspension_reason: null, ...over } },
});
const fundingStep: Expect = { method: "GET", url: `${BASE}/ad_accounts/a2_acct/funding_instruments`, json: { data: [{ id: "fi_old", is_servable: false }, { id: "fi_1", is_servable: true }] } };
const profilesStep: Expect = { method: "GET", url: `${BASE}/ad_accounts/a2_acct/profiles?page.size=1000`, check: authed, json: { data: [{ id: "t2_other" }, { id: "t2_buddy", name: "BuddyApp" }], pagination: {} } };
const pixelsStep: Expect = { method: "GET", url: `${BASE}/ad_accounts/a2_acct/pixels`, check: authed, json: { data: [{ id: "a2_acct" }] } };

const lookups = (opts: { funding?: boolean; pixel?: boolean; currency?: string } = {}): Expect[] => [
  accountStep(opts.currency ? { currency: opts.currency } : {}),
  ...(opts.funding === false ? [] : [fundingStep]),
  profilesStep,
  ...(opts.pixel === false ? [] : [pixelsStep]),
];

const destination = { type: "URL", url: LINK, display_url: "buddy.example", call_to_action: "Sign Up" };

function postSteps(creative: unknown, jobId: string, postId: string): Expect[] {
  return [
    {
      method: "POST",
      url: `${BASE}/profiles/t2_buddy/structured_posts/jobs`,
      check: (r) => {
        authed(r);
        expect(r.json).toEqual({ data: { allow_comments: false, creative } });
      },
      status: 201,
      json: { data: { id: jobId, status: "QUEUED" } },
    },
    { method: "GET", url: `${BASE}/structured_posts/jobs/${jobId}`, json: { data: { id: jobId, status: "PROCESSING" } } },
    { method: "GET", url: `${BASE}/structured_posts/jobs/${jobId}`, json: { data: { id: jobId, status: "SUCCESS", post_id: postId } } },
  ];
}

const campaignStep = (fi = "fi_1", objective = "CLICKS"): Expect => ({
  method: "POST",
  url: `${BASE}/ad_accounts/a2_acct/campaigns`,
  check: (r) => {
    authed(r);
    expect(r.json).toEqual({ data: { name: "day2 Buddy B-4", objective, configured_status: "PAUSED", funding_instrument_id: fi, is_campaign_budget_optimization: false } });
  },
  status: 201,
  json: { data: { id: "cmp_1", configured_status: "PAUSED" } },
});

const adGroupStep = (countries = ["DE"], micro = 20_000_000, opts: { signups?: boolean; pixel?: string } = {}): Expect => ({
  method: "POST",
  url: `${BASE}/ad_accounts/a2_acct/ad_groups`,
  check: (r) =>
    expect(r.json).toEqual({
      data: {
        campaign_id: "cmp_1",
        name: `day2 Buddy B-4 · ${countries.join(",")}`,
        configured_status: "ACTIVE",
        bid_strategy: "MAXIMIZE_VOLUME",
        ...(opts.signups ? { bid_type: "CPM", optimization_goal: "SIGN_UP", view_through_conversion_type: "SEVEN_DAY_CLICKS" } : { bid_type: "CPC", optimization_goal: "CLICKS" }),
        goal_type: "DAILY_SPEND",
        goal_value: micro,
        conversion_pixel_id: opts.pixel ?? "a2_acct",
        start_time: "2026-10-28T12:00:00+00:00",
        targeting: { geolocations: countries },
      },
    }),
  status: 201,
  json: { data: { id: "ag_1" } },
});

const adStep = (key: string, postId: string, adId: string, link = LINK): Expect => ({
  method: "POST",
  url: `${BASE}/ad_accounts/a2_acct/ads`,
  check: (r) => expect(r.json).toEqual({ data: { ad_group_id: "ag_1", name: `day2 Buddy B-4 ${key}`, configured_status: "ACTIVE", post_id: postId, click_url: link } }),
  status: 201,
  json: { data: { id: adId } },
});

const statusStep = (status: string, extra: Partial<Expect> = {}): Expect => ({
  method: "PATCH",
  url: `${BASE}/campaigns/cmp_1`,
  check: (r) => {
    authed(r);
    expect(r.json).toEqual({ data: { configured_status: status } });
  },
  json: { data: { id: "cmp_1", configured_status: status } },
  ...extra,
});

const launched: Launched = { platform: "reddit", campaignId: "cmp_1", refs: { adGroupId: "ag_1", profileId: "t2_buddy", startedAt: "2026-10-01T09:30:00.000Z" }, ads: { "B-4-v1": "ad_1", "B-4-v2": "ad_2" } };

describe("reddit info + credentials", () => {
  test("credentialsFromEnv returns null when any required var is missing", () => {
    const full = { REDDIT_CLIENT_ID: "a", REDDIT_CLIENT_SECRET: "b", REDDIT_REFRESH_TOKEN: "c", REDDIT_AD_ACCOUNT_ID: "a2_x" };
    expect(credentialsFromEnv({})).toBeNull();
    for (const k of Object.keys(full)) expect(credentialsFromEnv({ ...full, [k]: undefined })).toBeNull();
    expect(credentialsFromEnv({ ...full, REDDIT_REFRESH_TOKEN: "  " })).toBeNull();
    expect(credentialsFromEnv(full)).toEqual({ clientId: "a", clientSecret: "b", refreshToken: "c", adAccountId: "a2_x", userAgent: DEFAULT_USER_AGENT });
    expect(credentialsFromEnv({ ...full, REDDIT_USER_AGENT: UA, REDDIT_FUNDING_INSTRUMENT_ID: "fi_9" })).toMatchObject({ userAgent: UA, fundingInstrumentId: "fi_9" });
  });

  test("info describes Reddit", () => {
    expect(info.id).toBe("reddit");
    expect(info.identity).toBe("app_account");
    expect(info.identityHelp).toContain("profile");
    expect(info.minDailyUsd).toBe(5);
    expect(info.clickIdParam).toBe("rdt_cid");
    expect(info.copyLimits.headline).toBe(300);
    expect(info.audiences).toEqual(["consumer", "business"]);
    expect(info.apiVersion).toBe("v3");
    expect(info.formats.map((f) => `${f.kind} ${f.ratio}`)).toEqual(["image 1:1", "image 4:5", "image 16:9", "video 1:1", "video 4:5", "video 16:9"]);
    expect(info.env).toEqual(expect.arrayContaining(["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_REFRESH_TOKEN", "REDDIT_AD_ACCOUNT_ID"]));
  });
});

describe("reddit launch", () => {
  test("image creative: post job on the profile → paused campaign → ad group → ad → activate", async () => {
    const image = testImage();
    const creative = { type: "IMAGE", headline: "Split a dinner bill in 10 seconds", image: { media: { type: "URL", url: image.url } }, destination };
    const { f, platform } = make([tokenStep, ...lookups(), ...postSteps(creative, "job_1", "t3_post1"), campaignStep(), adGroupStep(), adStep("B-4-v1", "t3_post1", "ad_1"), statusStep("ACTIVE")]);
    const spec = testSpec({ identity, creatives: [{ ...testSpec().creatives[0]!, asset: image }] });
    const out = await platform.launch(spec);
    expect(out).toEqual({ platform: "reddit", campaignId: "cmp_1", refs: { adGroupId: "ag_1", profileId: "t2_buddy", startedAt: NOW.toISOString() }, ads: { "B-4-v1": "ad_1" } });
    expect(f.done()).toBe(true);
    // the access token is fetched once and reused; it never appears outside the auth header
    expect(f.calls.filter((c) => c.url.includes("access_token"))).toHaveLength(1);
    for (const c of f.calls.slice(1)) expect(typeof c.body === "string" ? c.body : "").not.toContain("atok");
  });

  test("video creative: thumbnail, AI-presenter disclosure in the headline, configured funding instrument, budget in micro, several countries", async () => {
    const video = testAsset({ ratio: "4:5", width: 1080, height: 1350, aiPerson: true, aiGenerated: true });
    const creative = {
      type: "VIDEO",
      headline: "Split a dinner bill in 10 seconds (AI presenter)",
      video: { media: { type: "URL", url: video.url } },
      thumbnail: { media: { type: "URL", url: video.thumbnail!.url } },
      destination: { ...destination, call_to_action: "Download" },
    };
    const { f, platform } = make(
      [tokenStep, ...lookups({ funding: false }), ...postSteps(creative, "job_v", "t3_vid"), campaignStep("fi_cfg"), adGroupStep(["DE", "AT"], 12_500_000), adStep("B-4-v1", "t3_vid", "ad_v"), statusStep("ACTIVE")],
      { ...creds, fundingInstrumentId: "fi_cfg" },
    );
    const base = testSpec().creatives[0]!;
    const spec = testSpec({
      identity,
      aiContent: true,
      dailyBudget: 12.5,
      targeting: { ...testSpec().targeting, countries: ["DE", "at"] },
      creatives: [{ ...base, copy: { ...base.copy, cta: "download" }, asset: video }],
    });
    const out = await platform.launch(spec);
    expect(out.ads).toEqual({ "B-4-v1": "ad_v" });
    expect(f.done()).toBe(true);
  });

  test("a failure after the campaign exists archives it and rethrows PlatformError", async () => {
    const image = testImage();
    const creative = { type: "IMAGE", headline: "Split a dinner bill in 10 seconds", image: { media: { type: "URL", url: image.url } }, destination };
    const { f, platform } = make([
      tokenStep,
      ...lookups(),
      ...postSteps(creative, "job_1", "t3_post1"),
      campaignStep(),
      adGroupStep(),
      { method: "POST", url: `${BASE}/ad_accounts/a2_acct/ads`, status: 400, json: { error: { message: "post_id: invalid" } } },
      statusStep("ARCHIVED"),
    ]);
    const err = await platform.launch(testSpec({ identity, creatives: [{ ...testSpec().creatives[0]!, asset: image }] })).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.status).toBe(400);
    expect(f.done()).toBe(true);
  });

  test("a rejected post job fails before any campaign is created", async () => {
    const image = testImage();
    const { f, platform } = make([
      tokenStep,
      ...lookups(),
      { method: "POST", url: "/structured_posts/jobs", json: { data: { id: "job_x", status: "QUEUED" } } },
      { method: "GET", url: "/structured_posts/jobs/job_x", json: { data: { id: "job_x", status: "CLIENT_ERROR", error_message: "image could not be fetched" } } },
    ]);
    const err = await platform.launch(testSpec({ identity, creatives: [{ ...testSpec().creatives[0]!, asset: image }] })).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.message).toContain("image could not be fetched");
    expect(f.done()).toBe(true);
  });

  test("refuses before any write: profile not linked, missing identity, low budget, unsupported asset, text-only", async () => {
    const image = testImage();
    const good = testSpec({ identity, creatives: [{ ...testSpec().creatives[0]!, asset: image }] });
    const { f, platform } = make([tokenStep, accountStep(), fundingStep, { method: "GET", url: "/ad_accounts/a2_acct/profiles", json: { data: [{ id: "t2_other" }] } }]);
    await expect(platform.launch(good)).rejects.toThrow(/not linked/);
    expect(f.done()).toBe(true);

    const none = make([]).platform;
    await expect(none.launch({ ...good, identity: null })).rejects.toBeInstanceOf(PlatformError);
    await expect(none.launch({ ...good, dailyBudget: 4 })).rejects.toThrow(/minimum/);
    await expect(none.launch({ ...good, optimizeFor: "signups" })).rejects.toThrow(/ensureConversions/);
    await expect(none.launch({ ...good, creatives: [{ ...good.creatives[0]!, link: "http://buddy.example/x" }] })).rejects.toThrow(/https/);
    await expect(none.launch(testSpec({ identity }))).rejects.toThrow(/9:16 is not accepted/);
    await expect(none.launch({ ...good, creatives: [{ ...good.creatives[0]!, asset: null }] })).rejects.toThrow(/no image or video/);
    await expect(none.launch({ ...good, creatives: [{ ...good.creatives[0]!, asset: testAsset({ ratio: "1:1", width: 1080, height: 1080, thumbnail: undefined }) }] })).rejects.toThrow(/thumbnail/);
  });
});

describe("reddit operate", () => {
  test("stats: reporting endpoint with AD_ID breakdown, spend in micro, status and rejection", async () => {
    const { f, platform } = make([
      tokenStep,
      accountStep(),
      fundingStep,
      { method: "GET", url: `${BASE}/campaigns/cmp_1`, check: authed, json: { data: { id: "cmp_1", configured_status: "ACTIVE", effective_status: "ACTIVE" } } },
      {
        method: "GET",
        url: `${BASE}/ad_accounts/a2_acct/ads?campaign_id=cmp_1&page.size=1000`,
        json: {
          data: [
            { id: "ad_1", configured_status: "ACTIVE", effective_status: "ACTIVE" },
            { id: "ad_2", configured_status: "ACTIVE", effective_status: "REJECTED", rejection_reason: "Misleading claims" },
          ],
          pagination: { next_url: null },
        },
      },
      {
        method: "POST",
        url: `${BASE}/ad_accounts/a2_acct/reports?page.size=1000`,
        check: (r) => {
          authed(r);
          expect(r.json).toEqual({
            data: {
              starts_at: "2026-10-01T09:00:00Z",
              ends_at: "2026-10-28T12:00:00Z",
              time_zone_id: "UTC",
              fields: ["SPEND", "IMPRESSIONS", "CLICKS"],
              breakdowns: ["AD_ID"],
              filter: "campaign:id==cmp_1",
            },
          });
        },
        json: {
          data: {
            metrics: [
              { ad_id: "ad_1", spend: 12_345_678, impressions: 4000, clicks: 52 },
              { ad_id: "ad_2", spend: 1_000_000, impressions: 100, clicks: 1 },
            ],
            metrics_updated_at: "2026-10-28T11:00:00Z",
          },
          pagination: {},
        },
      },
    ]);
    const s = await platform.stats(launched);
    expect(s).toEqual({
      spend: 13.35,
      currency: "USD",
      impressions: 4100,
      clicks: 53,
      status: "active",
      rejection: "B-4-v2: Misleading claims",
      byCreative: {
        "B-4-v1": { spend: 12.35, impressions: 4000, clicks: 52, status: "active" },
        "B-4-v2": { spend: 1, impressions: 100, clicks: 1, status: "rejected" },
      },
    });
    expect(f.done()).toBe(true);
  });

  test("stats: all ads rejected → rejected; ads pending → in_review; paused campaign → paused", async () => {
    const run = async (campaign: object, ads: object[]) => {
      const { platform } = make([
        tokenStep,
        accountStep({ currency: "EUR" }),
        fundingStep,
        { method: "GET", url: "/campaigns/cmp_1", json: { data: { id: "cmp_1", ...campaign } } },
        { method: "GET", url: "/ad_accounts/a2_acct/ads", json: { data: ads } },
        { method: "POST", url: "/ad_accounts/a2_acct/reports", json: { data: { metrics: [] } } },
      ]);
      return platform.stats(launched);
    };
    const rej = await run({ configured_status: "ACTIVE", effective_status: "ACTIVE" }, [
      { id: "ad_1", effective_status: "REJECTED", rejection_reason: "Prohibited content" },
      { id: "ad_2", effective_status: "REJECTED" },
    ]);
    expect(rej.status).toBe("rejected");
    expect(rej.rejection).toBe("B-4-v1: Prohibited content; B-4-v2: rejected");
    expect((await run({ configured_status: "ACTIVE" }, [{ id: "ad_1", effective_status: "PENDING_APPROVAL" }])).status).toBe("in_review");
    expect((await run({ configured_status: "PAUSED", effective_status: "PAUSED" }, [{ id: "ad_1", effective_status: "ACTIVE" }])).status).toBe("paused");
  });

  test("pause and resume flip the campaign's configured_status", async () => {
    const { f, platform } = make([tokenStep, statusStep("PAUSED"), statusStep("ACTIVE")]);
    await platform.pause(launched);
    await platform.resume(launched);
    expect(f.done()).toBe(true);
  });

  test("setDailyBudget patches the ad group goal_value in micro (account currency) and enforces the USD minimum", async () => {
    const { f, platform } = make([
      tokenStep,
      accountStep(),
      fundingStep,
      { method: "PATCH", url: `${BASE}/ad_groups/ag_1`, check: (r) => expect(r.json).toEqual({ data: { goal_value: 37_250_000 } }), json: { data: { id: "ag_1" } } },
    ]);
    await platform.setDailyBudget(launched, 37.25);
    await expect(platform.setDailyBudget(launched, 2)).rejects.toThrow(/minimum/);
    expect(f.done()).toBe(true);
  });

  test("a 429 is retried after Retry-After", async () => {
    const slept: number[] = [];
    const f = scriptedFetch([
      tokenStep,
      { method: "PATCH", url: "/campaigns/cmp_1", status: 429, headers: { "retry-after": "2" }, text: "Too Many Requests" },
      statusStep("PAUSED"),
    ]);
    const platform = create(creds, { fetch: f.fetch, sleep: async (ms) => void slept.push(ms), now: () => NOW });
    await platform.pause(launched);
    expect(slept).toEqual([2000]);
    expect(f.done()).toBe(true);
  });

  test("persistent 429 surfaces as a retryable PlatformError", async () => {
    const tooMany: Expect = { method: "PATCH", url: "/campaigns/cmp_1", status: 429, text: "slow down" };
    const { platform } = make([tokenStep, tooMany, tooMany, tooMany]);
    const err = await platform.pause(launched).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(429);
  });

  test("a rotated refresh token is handed to onRefreshToken and used next time", async () => {
    const rotated: string[] = [];
    const f = scriptedFetch([{ ...tokenStep, json: { access_token: "atok", expires_in: 1, refresh_token: "rtok2" } }, statusStep("PAUSED")]);
    const platform = create({ ...creds, onRefreshToken: (t) => void rotated.push(t) }, { fetch: f.fetch, sleep: noSleep, now: () => NOW });
    await platform.pause(launched);
    expect(rotated).toEqual(["rtok2"]);
  });

  test("a failed refresh is a PlatformError without the secret", async () => {
    const { platform } = make([{ method: "POST", url: "access_token", status: 401, json: { error: "invalid_grant", refresh_token: "rtok" } }]);
    const err = await platform.pause(launched).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.message).not.toContain("rtok");
    expect(err.message).not.toContain("csecret");
  });
});

describe("reddit upgrade: currency, per-ad links, sign-ups", () => {
  test("optimizeFor signups: CONVERSIONS campaign, SIGN_UP goal on the setup's pixel, per-ad links, EUR budget below the USD floor", async () => {
    const img1 = testImage();
    const img2 = testImage({ id: "as_img2", ratio: "16:9", width: 1920, height: 1080, mime: "image/jpeg", url: "https://day2.example/api/assets/as_img2.jpg" });
    const L1 = "https://buddy.example/go/split?d2=B-4.reddit.v1";
    const L2 = "https://buddy.example/go/split?d2=B-4.reddit.v2";
    const base = testSpec().creatives[0]!;
    const c1 = { type: "IMAGE", headline: base.copy.headline, image: { media: { type: "URL", url: img1.url } }, destination: { ...destination, url: L1 } };
    const c2 = { type: "IMAGE", headline: base.copy.headline, image: { media: { type: "URL", url: img2.url } }, destination: { ...destination, url: L2 } };
    const { f, platform } = make([
      tokenStep,
      ...lookups({ currency: "EUR", pixel: false }),
      ...postSteps(c1, "job_1", "t3_p1"),
      ...postSteps(c2, "job_2", "t3_p2"),
      campaignStep("fi_1", "CONVERSIONS"),
      adGroupStep(["DE"], 3_000_000, { signups: true, pixel: "px_9" }),
      adStep("B-4-reddit-v1", "t3_p1", "ad_1", L1),
      adStep("B-4-reddit-v2", "t3_p2", "ad_2", L2),
      statusStep("ACTIVE"),
    ]);
    const out = await platform.launch(
      testSpec({
        identity,
        currency: "EUR",
        dailyBudget: 3,
        optimizeFor: "signups",
        conversion: { platform: "reddit", refs: { pixelId: "px_9" } },
        creatives: [
          { ...base, key: "B-4-reddit-v1", link: L1, asset: img1 },
          { ...base, key: "B-4-reddit-v2", link: L2, asset: img2 },
        ],
      }),
    );
    expect(out.ads).toEqual({ "B-4-reddit-v1": "ad_1", "B-4-reddit-v2": "ad_2" });
    expect(f.done()).toBe(true);
  });

  test("refuses when the spec's currency is not the ad account's, or the account cannot spend — before any write", async () => {
    const good = testSpec({ identity, creatives: [{ ...testSpec().creatives[0]!, asset: testImage() }] });
    let m = make([tokenStep, accountStep({ currency: "EUR" }), fundingStep]);
    await expect(m.platform.launch(good)).rejects.toThrow(/bills in EUR/);
    expect(m.f.done()).toBe(true);
    m = make([tokenStep, accountStep({ suspension_reason: "BILLING" })]);
    await expect(m.platform.launch(good)).rejects.toThrow(/cannot spend: suspended/);
    expect(m.f.done()).toBe(true);
  });
});

describe("reddit upgrade: account, identity, ads, conversions", () => {
  test("accountInfo: approved account with a payment method can spend", async () => {
    const { f, platform } = make([tokenStep, accountStep({ currency: "eur" }), fundingStep]);
    expect(await platform.accountInfo()).toEqual({ id: "a2_acct", name: "day2 ads", currency: "EUR", canSpend: true });
    expect(f.done()).toBe(true);
  });

  test("accountInfo: pending approval, or no usable funding instrument → canSpend false with the problem", async () => {
    let m = make([tokenStep, accountStep({ admin_approval: "PENDING" })]);
    expect(await m.platform.accountInfo()).toMatchObject({ canSpend: false, problem: "awaiting Reddit's approval" });
    m = make([tokenStep, accountStep(), { method: "GET", url: "/funding_instruments", json: { data: [{ id: "fi_x", is_servable: false }] } }]);
    expect(await m.platform.accountInfo()).toMatchObject({ canSpend: false, problem: expect.stringContaining("payment method") });
  });

  test("checkIdentity: linked profile ok, unlinked profile explains what to do", async () => {
    const { platform } = make([tokenStep, profilesStep, profilesStep]);
    expect(await platform.checkIdentity!(identity)).toEqual({ ok: true });
    const r = await platform.checkIdentity!({ ...identity, ref: "t2_stranger" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain("not linked");
  });

  test("setAdActive pauses / re-activates one ad by creative key", async () => {
    const patch = (id: string, status: string): Expect => ({ method: "PATCH", url: `${BASE}/ads/${id}`, check: (r) => expect(r.json).toEqual({ data: { configured_status: status } }), json: { data: { id } } });
    const { f, platform } = make([tokenStep, patch("ad_2", "PAUSED"), patch("ad_2", "ACTIVE")]);
    await platform.setAdActive(launched, "B-4-v2", false);
    await platform.setAdActive(launched, "B-4-v2", true);
    await expect(platform.setAdActive(launched, "nope", true)).rejects.toBeInstanceOf(PlatformError);
    expect(f.done()).toBe(true);
  });

  test("ensureConversions finds the ad account's pixel, and fails clearly when there is none", async () => {
    let m = make([tokenStep, pixelsStep]);
    expect(await m.platform.ensureConversions!()).toEqual({ platform: "reddit", refs: { pixelId: "a2_acct" } });
    m = make([tokenStep, { method: "GET", url: "/pixels", json: { data: [] } }]);
    await expect(m.platform.ensureConversions!()).rejects.toThrow(/no conversion pixel/);
  });

  test("sendConversions: SIGN_UP / custom Activated events with rdt_cid, conversion_id and hashed external_id", async () => {
    const hashed = "a".repeat(64);
    const { f, platform } = make([
      tokenStep,
      {
        method: "POST",
        url: `${BASE}/pixels/px_9/conversion_events`,
        check: (r) => {
          authed(r);
          expect(r.json).toEqual({
            data: {
              events: [
                {
                  event_at: Date.parse("2026-10-28T10:00:00.000Z"),
                  action_source: "WEBSITE",
                  type: { tracking_type: "SIGN_UP" },
                  click_id: "cid_1",
                  event_source_url: "https://buddy.example/go/split",
                  metadata: { conversion_id: "dev-1:signup" },
                  user: { external_id: hashed, ip_address: "203.0.113.7", user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" },
                },
                {
                  event_at: Date.parse("2026-10-28T11:00:00.000Z"),
                  action_source: "WEBSITE",
                  type: { tracking_type: "CUSTOM", custom_event_name: "Activated" },
                  click_id: "cid_2",
                  event_source_url: "https://buddy.example/go/split",
                  metadata: { conversion_id: "dev-2:activated" },
                  user: { external_id: "d92b69cfb82cecab45c753f56002b2c0e6d01f132fe39f2c878858dc9528e10b" }, // sha256("user-2")
                },
              ],
            },
          });
        },
        json: { data: { message: "Successfully processed 2 conversion events." } },
      },
    ]);
    const res = await platform.sendConversions!({ platform: "reddit", refs: { pixelId: "px_9" } }, [
      { eventId: "dev-1:signup", name: "signup", at: "2026-10-28T10:00:00.000Z", click: { param: "rdt_cid", value: "cid_1" }, pageUrl: "https://buddy.example/go/split", externalId: hashed, clientIp: " 203.0.113.7 ", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" },
      { eventId: "dev-2:activated", name: "activated", at: "2026-10-28T11:00:00.000Z", click: { param: "rdt_cid", value: "cid_2" }, pageUrl: "https://buddy.example/go/split", externalId: "user-2" },
      { eventId: "dev-3:signup", name: "signup", at: "2026-10-28T11:00:00.000Z", click: { param: "fbclid", value: "x" }, pageUrl: "https://buddy.example/go/split" },
      { eventId: "dev-4:signup", name: "signup", at: "2026-10-01T11:00:00.000Z", click: { param: "rdt_cid", value: "old" }, pageUrl: "https://buddy.example/go/split" },
    ]);
    expect(res.sent).toBe(2);
    expect(res.rejected.map((r) => r.eventId)).toEqual(["dev-3:signup", "dev-4:signup"]);
    expect(f.done()).toBe(true);
  });

  test("sendConversions: a 400 from Reddit rejects that batch instead of throwing", async () => {
    const { platform } = make([tokenStep, { method: "POST", url: "/conversion_events", status: 400, json: { error: { message: "invalid click_id" } } }]);
    const res = await platform.sendConversions!({ platform: "reddit", refs: { pixelId: "px_9" } }, [
      { eventId: "e1", name: "signup", at: "2026-10-28T10:00:00.000Z", click: { param: "rdt_cid", value: "bad" }, pageUrl: "https://buddy.example/", clientIp: "2001:db8::1" },
    ]);
    expect(res.sent).toBe(0);
    expect(res.rejected[0]).toMatchObject({ eventId: "e1", why: expect.stringContaining("invalid click_id") });
  });
});
