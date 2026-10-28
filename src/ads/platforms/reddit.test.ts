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

const lookups = (opts: { funding?: boolean } = { funding: true }): Expect[] => [
  { method: "GET", url: `${BASE}/ad_accounts/a2_acct/profiles?page.size=1000`, check: authed, json: { data: [{ id: "t2_other" }, { id: "t2_buddy", name: "BuddyApp" }], pagination: {} } },
  { method: "GET", url: `${BASE}/ad_accounts/a2_acct/pixels`, check: authed, json: { data: [{ id: "a2_acct" }] } },
  ...(opts.funding
    ? [{ method: "GET", url: `${BASE}/ad_accounts/a2_acct/funding_instruments`, json: { data: [{ id: "fi_old", is_servable: false }, { id: "fi_1", is_servable: true }] } } satisfies Expect]
    : []),
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

const campaignStep = (fi = "fi_1"): Expect => ({
  method: "POST",
  url: `${BASE}/ad_accounts/a2_acct/campaigns`,
  check: (r) => {
    authed(r);
    expect(r.json).toEqual({ data: { name: "day2 Buddy B-4", objective: "CLICKS", configured_status: "PAUSED", funding_instrument_id: fi, is_campaign_budget_optimization: false } });
  },
  status: 201,
  json: { data: { id: "cmp_1", configured_status: "PAUSED" } },
});

const adGroupStep = (countries = ["DE"], micro = 20_000_000): Expect => ({
  method: "POST",
  url: `${BASE}/ad_accounts/a2_acct/ad_groups`,
  check: (r) =>
    expect(r.json).toEqual({
      data: {
        campaign_id: "cmp_1",
        name: `day2 Buddy B-4 · ${countries.join(",")}`,
        configured_status: "ACTIVE",
        bid_strategy: "MAXIMIZE_VOLUME",
        bid_type: "CPC",
        optimization_goal: "CLICKS",
        goal_type: "DAILY_SPEND",
        goal_value: micro,
        conversion_pixel_id: "a2_acct",
        start_time: "2026-10-28T12:00:00+00:00",
        targeting: { geolocations: countries },
      },
    }),
  status: 201,
  json: { data: { id: "ag_1" } },
});

const adStep = (key: string, postId: string, adId: string): Expect => ({
  method: "POST",
  url: `${BASE}/ad_accounts/a2_acct/ads`,
  check: (r) => expect(r.json).toEqual({ data: { ad_group_id: "ag_1", name: `day2 Buddy B-4 ${key}`, configured_status: "ACTIVE", post_id: postId, click_url: LINK } }),
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
      dailyBudgetUsd: 12.5,
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
    const { f, platform } = make([tokenStep, { method: "GET", url: "/ad_accounts/a2_acct/profiles", json: { data: [{ id: "t2_other" }] } }]);
    await expect(platform.launch(good)).rejects.toThrow(/not linked/);
    expect(f.done()).toBe(true);

    const none = make([]).platform;
    await expect(none.launch({ ...good, identity: null })).rejects.toBeInstanceOf(PlatformError);
    await expect(none.launch({ ...good, dailyBudgetUsd: 4 })).rejects.toThrow(/minimum/);
    await expect(none.launch(testSpec({ identity }))).rejects.toThrow(/9:16 is not accepted/);
    await expect(none.launch({ ...good, creatives: [{ ...good.creatives[0]!, asset: null }] })).rejects.toThrow(/no image or video/);
    await expect(none.launch({ ...good, creatives: [{ ...good.creatives[0]!, asset: testAsset({ ratio: "1:1", width: 1080, height: 1080, thumbnail: undefined }) }] })).rejects.toThrow(/thumbnail/);
  });
});

describe("reddit operate", () => {
  test("stats: reporting endpoint with AD_ID breakdown, spend in micro, status and rejection", async () => {
    const { f, platform } = make([
      tokenStep,
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
      spendUsd: 13.35,
      impressions: 4100,
      clicks: 53,
      status: "active",
      rejection: "B-4-v2: Misleading claims",
      byCreative: {
        "B-4-v1": { spendUsd: 12.35, impressions: 4000, clicks: 52, status: "active" },
        "B-4-v2": { spendUsd: 1, impressions: 100, clicks: 1, status: "rejected" },
      },
    });
    expect(f.done()).toBe(true);
  });

  test("stats: all ads rejected → rejected; ads pending → in_review; paused campaign → paused", async () => {
    const run = async (campaign: object, ads: object[]) => {
      const { platform } = make([
        tokenStep,
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

  test("setDailyBudget patches the ad group goal_value in micro and enforces the minimum", async () => {
    const { f, platform } = make([
      tokenStep,
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
