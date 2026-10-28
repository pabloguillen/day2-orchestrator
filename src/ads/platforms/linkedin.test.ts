import { describe, expect, test } from "bun:test";
import { noSleep, scriptedFetch, testAsset, testImage, testSpec, type Expect } from "../test-helpers";
import { PlatformError, type Launched } from "../types";
import { create, credentialsFromEnv, info, littleText, type LinkedInCreds } from "./linkedin";

const creds: LinkedInCreds = { clientId: "cid", clientSecret: "csecret", refreshToken: "rt_1", adAccountId: "5001", apiVersion: "202610" };
const NOW = new Date("2026-10-28T12:00:00Z");
const bytes = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i % 256));

const tokenCall: Expect = {
  method: "POST",
  url: "https://www.linkedin.com/oauth/v2/accessToken",
  check: (r) => {
    expect(r.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(r.json).toEqual({ grant_type: "refresh_token", refresh_token: "rt_1", client_id: "cid", client_secret: "csecret" });
  },
  json: { access_token: "at_1", expires_in: 5184000, refresh_token: "rt_1", refresh_token_expires_in: 31536000 },
};

const accountCall = (over: Record<string, unknown> = {}): Expect => ({
  method: "GET",
  url: "https://api.linkedin.com/rest/adAccounts/5001",
  check: (r) => versioned(r),
  json: { id: 5001, name: "day2 ads", currency: "USD", status: "ACTIVE", servingStatuses: ["RUNNABLE"], ...over },
});

const versioned = (r: { headers: Record<string, string> }) => {
  expect(r.headers.authorization).toBe("Bearer at_1");
  expect(r.headers["linkedin-version"]).toBe("202610");
  expect(r.headers["x-restli-protocol-version"]).toBe("2.0.0");
};
const partial = (r: { headers: Record<string, string> }) => {
  versioned(r);
  expect(r.headers["x-restli-method"]).toBe("PARTIAL_UPDATE");
};

function platform(script: Expect[], readAsset?: (a: { id: string }) => Promise<Uint8Array>) {
  const f = scriptedFetch(script);
  const p = create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW, readAsset: readAsset ?? (async () => bytes(10)) });
  return { p, f };
}

const launched: Launched = {
  platform: "linkedin",
  campaignId: "222",
  refs: { account: "5001", campaignGroup: "111", startDate: "2026-10-28", posts: "urn:li:share:9" },
  ads: { "B-4-v1": "urn:li:sponsoredCreative:333", "B-4-v2": "urn:li:sponsoredCreative:334" },
};

describe("linkedin", () => {
  test("credentialsFromEnv", () => {
    expect(credentialsFromEnv({})).toBeNull();
    expect(credentialsFromEnv({ LINKEDIN_CLIENT_ID: "a", LINKEDIN_CLIENT_SECRET: "b", LINKEDIN_REFRESH_TOKEN: "c" })).toBeNull();
    expect(credentialsFromEnv({ LINKEDIN_CLIENT_ID: "a", LINKEDIN_CLIENT_SECRET: "b", LINKEDIN_AD_ACCOUNT_ID: "1" })).toBeNull();
    expect(credentialsFromEnv({ LINKEDIN_CLIENT_ID: "a", LINKEDIN_CLIENT_SECRET: "b", LINKEDIN_REFRESH_TOKEN: "c", LINKEDIN_AD_ACCOUNT_ID: "urn:li:sponsoredAccount:42" })).toEqual({
      clientId: "a",
      clientSecret: "b",
      refreshToken: "c",
      adAccountId: "42",
      apiVersion: "202610",
    });
    expect(
      credentialsFromEnv({ LINKEDIN_CLIENT_ID: "a", LINKEDIN_CLIENT_SECRET: "b", LINKEDIN_REFRESH_TOKEN: "c", LINKEDIN_AD_ACCOUNT_ID: "42", LINKEDIN_API_VERSION: "202609" })?.apiVersion,
    ).toBe("202609");
  });

  test("info", () => {
    expect(info.id).toBe("linkedin");
    expect(info.identity).toBe("app_account");
    expect(info.audiences).toEqual(["business"]);
    expect(info.formats.some((f) => f.kind === "image" && f.ratio === "1.91:1")).toBe(true);
    expect(info.formats.some((f) => f.kind === "image" && f.ratio === "1:1")).toBe(true);
    expect(info.formats.some((f) => f.kind === "video")).toBe(true);
  });

  test("littleText escapes reserved characters", () => {
    expect(littleText("Hi (team) #1 @you")).toBe("Hi \\(team\\) \\#1 \\@you");
  });

  test("token refresh is cached across calls", async () => {
    const { p, f } = platform([
      tokenCall,
      { method: "POST", url: "/rest/adAccounts/5001/adCampaigns/222", check: partial },
      { method: "POST", url: "/rest/adAccounts/5001/adCampaigns/222", check: partial },
    ]);
    await p.pause(launched);
    await p.resume(launched);
    expect(f.done()).toBe(true);
  });

  test("launch: single image, business audience", async () => {
    const spec = testSpec({
      identity: { platform: "linkedin", ref: "urn:li:organization:777", displayName: "Buddy" },
      targeting: { countries: ["DE"], languages: ["de"], ageMin: 18, audience: "business", interests: ["Engineering", "unicorns"], keywords: [] },
      creatives: [{ key: "B-4-v1", copy: { headline: "Split bills (fast)", body: "Add the bill #now", cta: "sign_up" }, asset: testImage({ ratio: "1.91:1", width: 1200, height: 628 }), link: "https://buddy.example/go/split?d2=B-4.li.v1" }],
    });
    const { p, f } = platform([
      tokenCall,
      accountCall(),
      {
        method: "GET",
        url: "/rest/adTargetingEntities?q=typeahead&queryVersion=QUERY_USES_URNS&facet=urn%3Ali%3AadTargetingFacet%3Alocations&query=Germany&locale=(language:en,country:US)",
        check: versioned,
        json: { elements: [{ urn: "urn:li:geo:999", name: "Germany Area" }, { urn: "urn:li:geo:101282230", name: "Germany", facetUrn: "urn:li:adTargetingFacet:locations" }] },
      },
      {
        method: "GET",
        url: "/rest/adTargetingEntities?q=adTargetingFacet&queryVersion=QUERY_USES_URNS&facet=urn%3Ali%3AadTargetingFacet%3AjobFunctions",
        json: { elements: [{ urn: "urn:li:function:8", name: "Engineering" }, { urn: "urn:li:function:15", name: "Marketing" }] },
      },
      {
        method: "POST",
        url: "/rest/images?action=initializeUpload",
        check: (r) => {
          versioned(r);
          expect(r.json).toEqual({ initializeUploadRequest: { owner: "urn:li:organization:777" } });
        },
        json: { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/IMG1/uploaded-image/0?x=1", image: "urn:li:image:IMG1", uploadUrlExpiresAt: 1 } },
      },
      {
        method: "PUT",
        url: "https://www.linkedin.com/dms-uploads/IMG1/uploaded-image/0",
        check: (r) => {
          expect(r.headers["content-type"]).toBe("image/png");
          expect((r.body as Uint8Array).byteLength).toBe(10);
        },
        status: 201,
      },
      { method: "GET", url: "/rest/images/urn%3Ali%3Aimage%3AIMG1", check: versioned, json: { id: "urn:li:image:IMG1", status: "AVAILABLE" } },
      {
        method: "POST",
        url: "/rest/posts",
        check: (r) => {
          versioned(r);
          expect(r.json).toEqual({
            author: "urn:li:organization:777",
            commentary: "Add the bill \\#now",
            visibility: "PUBLIC",
            distribution: { feedDistribution: "NONE", targetEntities: [], thirdPartyDistributionChannels: [] },
            content: { media: { title: "Split bills (fast)", id: "urn:li:image:IMG1" } },
            contentLandingPage: "https://buddy.example/go/split?d2=B-4.li.v1",
            contentCallToActionLabel: "SIGN_UP",
            lifecycleState: "PUBLISHED",
            isReshareDisabledByAuthor: true,
            adContext: { dscAdAccount: "urn:li:sponsoredAccount:5001", dscStatus: "ACTIVE", dscName: "B-4-v1" },
          });
        },
        status: 201,
        headers: { "x-restli-id": "urn:li:share:9" },
      },
      {
        method: "POST",
        url: "/rest/adAccounts/5001/adCampaignGroups",
        check: (r) => {
          versioned(r);
          expect(r.json).toEqual({ account: "urn:li:sponsoredAccount:5001", name: "day2 Buddy B-4", status: "DRAFT", runSchedule: { start: NOW.getTime() } });
        },
        status: 201,
        headers: { "x-restli-id": "111" },
      },
      {
        method: "POST",
        url: "/rest/adAccounts/5001/adCampaigns",
        check: (r) => {
          versioned(r);
          expect(r.json).toEqual({
            account: "urn:li:sponsoredAccount:5001",
            campaignGroup: "urn:li:sponsoredCampaignGroup:111",
            name: "day2 Buddy B-4",
            type: "SPONSORED_UPDATES",
            objectiveType: "WEBSITE_VISIT",
            costType: "CPM",
            optimizationTargetType: "MAX_CLICK",
            unitCost: { amount: "0.00", currencyCode: "USD" },
            dailyBudget: { amount: "20.00", currencyCode: "USD" },
            locale: { country: "DE", language: "de" },
            targetingCriteria: {
              include: {
                and: [
                  { or: { "urn:li:adTargetingFacet:locations": ["urn:li:geo:101282230"] } },
                  { or: { "urn:li:adTargetingFacet:interfaceLocales": ["urn:li:locale:de_DE"] } },
                  { or: { "urn:li:adTargetingFacet:jobFunctions": ["urn:li:function:8"] } },
                ],
              },
            },
            runSchedule: { start: NOW.getTime() },
            creativeSelection: "OPTIMIZED",
            audienceExpansionEnabled: false,
            offsiteDeliveryEnabled: false,
            politicalIntent: "NOT_POLITICAL",
            status: "DRAFT",
          });
        },
        status: 201,
        headers: { "x-restli-id": "222" },
      },
      {
        method: "POST",
        url: "/rest/adAccounts/5001/creatives",
        check: (r) => {
          versioned(r);
          expect(r.json).toEqual({ campaign: "urn:li:sponsoredCampaign:222", content: { reference: "urn:li:share:9" }, intendedStatus: "ACTIVE", name: "B-4-v1" });
        },
        status: 201,
        headers: { "x-restli-id": "urn%3Ali%3AsponsoredCreative%3A333" },
      },
      {
        method: "POST",
        url: "/rest/adAccounts/5001/adCampaignGroups/111",
        check: (r) => {
          partial(r);
          expect(r.json).toEqual({ patch: { $set: { status: "ACTIVE" } } });
        },
      },
      {
        method: "POST",
        url: "/rest/adAccounts/5001/adCampaigns/222",
        check: (r) => {
          partial(r);
          expect(r.json).toEqual({ patch: { $set: { status: "ACTIVE" } } });
        },
      },
    ]);
    const out = await p.launch(spec);
    expect(f.done()).toBe(true);
    expect(out).toEqual({
      platform: "linkedin",
      campaignId: "222",
      refs: { account: "5001", campaignGroup: "111", startDate: "2026-10-28", posts: "urn:li:share:9", optimizeFor: "clicks" },
      ads: { "B-4-v1": "urn:li:sponsoredCreative:333" },
    });
  });

  test("launch: video, optimised for sign-ups, in a EUR account", async () => {
    const video = testAsset({ ratio: "9:16", bytes: 20 });
    const spec = testSpec({
      currency: "EUR",
      dailyBudget: 25,
      optimizeFor: "signups",
      conversion: { platform: "linkedin", refs: { account: "5001", signup: "urn:lla:llaPartnerConversion:701", activated: "urn:lla:llaPartnerConversion:702" } },
      identity: { platform: "linkedin", ref: "urn:li:organization:777", displayName: "Buddy" },
      targeting: { countries: ["US", "AT"], languages: ["en", "de"], ageMin: 18, audience: "consumer", interests: ["Engineering"], keywords: [] },
      creatives: [{ key: "B-4-v1", copy: { headline: "Split a dinner bill", body: "Done in 10 seconds.", cta: "get_started" }, asset: video }],
    });
    const { p, f } = platform(
      [
        tokenCall,
        accountCall({ currency: "EUR" }),
        { method: "GET", url: "query=Austria", json: { elements: [{ urn: "urn:li:geo:103883259", name: "Austria" }] } },
        {
          method: "POST",
          url: "/rest/videos?action=initializeUpload",
          check: (r) => {
            versioned(r);
            expect(r.json).toEqual({ initializeUploadRequest: { owner: "urn:li:organization:777", fileSizeBytes: 20, uploadCaptions: false, uploadThumbnail: true } });
          },
          json: {
            value: {
              video: "urn:li:video:V1",
              uploadToken: "",
              thumbnailUploadUrl: "https://www.linkedin.com/dms-uploads/V1/thumb",
              uploadInstructions: [
                { uploadUrl: "https://www.linkedin.com/dms-uploads/V1/part0", firstByte: 0, lastByte: 11 },
                { uploadUrl: "https://www.linkedin.com/dms-uploads/V1/part1", firstByte: 12, lastByte: 19 },
              ],
            },
          },
        },
        {
          method: "PUT",
          url: "/dms-uploads/V1/part0",
          check: (r) => {
            expect(r.headers["content-type"]).toBe("application/octet-stream");
            expect(r.headers.authorization).toBeUndefined();
            expect(Array.from(r.body as Uint8Array)).toEqual(Array.from(bytes(20).subarray(0, 12)));
          },
          headers: { etag: "etag-0" },
        },
        {
          method: "PUT",
          url: "/dms-uploads/V1/part1",
          check: (r) => expect(Array.from(r.body as Uint8Array)).toEqual(Array.from(bytes(20).subarray(12, 20))),
          headers: { etag: "etag-1" },
        },
        { method: "PUT", url: "/dms-uploads/V1/thumb", check: (r) => expect(r.headers["content-type"]).toBe("image/jpeg") },
        {
          method: "POST",
          url: "/rest/videos?action=finalizeUpload",
          check: (r) => {
            versioned(r);
            expect(r.json).toEqual({ finalizeUploadRequest: { video: "urn:li:video:V1", uploadToken: "", uploadedPartIds: ["etag-0", "etag-1"] } });
          },
        },
        { method: "GET", url: "/rest/videos/urn%3Ali%3Avideo%3AV1", json: { status: "PROCESSING" } },
        { method: "GET", url: "/rest/videos/urn%3Ali%3Avideo%3AV1", json: { status: "AVAILABLE" } },
        {
          method: "POST",
          url: "/rest/posts",
          check: (r) => {
            const j = r.json as Record<string, unknown>;
            expect(j.content).toEqual({ media: { title: "Split a dinner bill", id: "urn:li:video:V1" } });
            expect(j.contentCallToActionLabel).toBe("SIGN_UP");
            expect(j.distribution).toEqual({ feedDistribution: "NONE", targetEntities: [], thirdPartyDistributionChannels: [] });
          },
          status: 201,
          headers: { "x-restli-id": "urn:li:ugcPost:10" },
        },
        { method: "POST", url: "/rest/adAccounts/5001/adCampaignGroups", status: 201, headers: { "x-restli-id": "111" } },
        {
          method: "POST",
          url: "/rest/adAccounts/5001/adCampaigns",
          check: (r) => {
            const j = r.json as Record<string, unknown>;
            expect(j.status).toBe("DRAFT");
            expect(j.objectiveType).toBe("WEBSITE_CONVERSION");
            expect(j.optimizationTargetType).toBe("MAX_CONVERSION");
            expect(j.costType).toBe("CPM");
            expect(j.dailyBudget).toEqual({ amount: "25.00", currencyCode: "EUR" });
            expect(j.unitCost).toEqual({ amount: "0.00", currencyCode: "EUR" });
            expect(j.locale).toEqual({ country: "US", language: "en" });
            expect(j.targetingCriteria).toEqual({
              include: {
                and: [
                  { or: { "urn:li:adTargetingFacet:locations": ["urn:li:geo:103644278", "urn:li:geo:103883259"] } },
                  { or: { "urn:li:adTargetingFacet:interfaceLocales": ["urn:li:locale:en_US", "urn:li:locale:de_DE"] } },
                ],
              },
            });
          },
          status: 201,
          headers: { "x-restli-id": "222" },
        },
        {
          method: "PUT",
          url: "/rest/campaignConversions/(campaign:urn%3Ali%3AsponsoredCampaign%3A222,conversion:urn%3Alla%3AllaPartnerConversion%3A701)",
          check: (r) => {
            versioned(r);
            expect(r.json).toEqual({ campaign: "urn:li:sponsoredCampaign:222", conversion: "urn:lla:llaPartnerConversion:701" });
          },
        },
        { method: "PUT", url: "/rest/campaignConversions/(campaign:urn%3Ali%3AsponsoredCampaign%3A222,conversion:urn%3Alla%3AllaPartnerConversion%3A702)" },
        {
          method: "POST",
          url: "/rest/adAccounts/5001/creatives",
          check: (r) => expect((r.json as { content: unknown }).content).toEqual({ reference: "urn:li:ugcPost:10" }),
          status: 201,
          headers: { "x-restli-id": "urn:li:sponsoredCreative:333" },
        },
        { method: "POST", url: "/rest/adAccounts/5001/adCampaignGroups/111", check: partial },
        { method: "POST", url: "/rest/adAccounts/5001/adCampaigns/222", check: (r) => expect(r.json).toEqual({ patch: { $set: { status: "ACTIVE" } } }) },
      ],
      async (a) => (a.id === "as_thumb1" ? bytes(5) : bytes(20)),
    );
    const out = await p.launch(spec);
    expect(f.done()).toBe(true);
    expect(out.ads).toEqual({ "B-4-v1": "urn:li:sponsoredCreative:333" });
    expect(out.refs.posts).toBe("urn:li:ugcPost:10");
  });

  test("launch failure cleans up drafts and posts, then rethrows", async () => {
    const spec = testSpec({
      identity: { platform: "linkedin", ref: "777", displayName: "Buddy" },
      targeting: { countries: ["US"], languages: ["en"], ageMin: 18, audience: "consumer", interests: [], keywords: [] },
      creatives: [{ key: "B-4-v1", copy: { headline: "H", body: "B", cta: "learn_more" }, asset: testImage() }],
    });
    const del = (url: string): Expect => ({ method: "DELETE", url, check: (r) => expect(r.headers["x-restli-method"]).toBe("DELETE") });
    const { p, f } = platform([
      tokenCall,
      accountCall(),
      { method: "POST", url: "/rest/images?action=initializeUpload", json: { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/IMG1", image: "urn:li:image:IMG1" } } },
      { method: "PUT", url: "/dms-uploads/IMG1" },
      { method: "GET", url: "/rest/images/", json: { status: "AVAILABLE" } },
      { method: "POST", url: "/rest/posts", status: 201, headers: { "x-restli-id": "urn:li:share:9" } },
      { method: "POST", url: "/rest/adAccounts/5001/adCampaignGroups", status: 201, headers: { "x-restli-id": "111" } },
      { method: "POST", url: "/rest/adAccounts/5001/adCampaigns", status: 201, headers: { "x-restli-id": "222" } },
      { method: "POST", url: "/rest/adAccounts/5001/creatives", status: 422, json: { message: "Invalid content reference", status: 422 } },
      del("/rest/adAccounts/5001/adCampaigns/222"),
      del("/rest/adAccounts/5001/adCampaignGroups/111"),
      del("/rest/posts/urn%3Ali%3Ashare%3A9"),
    ]);
    const err = await p.launch(spec).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect((err as PlatformError).status).toBe(422);
    expect(f.done()).toBe(true);
  });

  test("launch rejects mixed image/video and missing identity before any call", async () => {
    const { p, f } = platform([]);
    const mixed = testSpec({
      identity: { platform: "linkedin", ref: "urn:li:organization:777", displayName: "Buddy" },
      creatives: [
        { key: "a", copy: { headline: "h", body: "b", cta: "learn_more" }, asset: testImage() },
        { key: "b", copy: { headline: "h", body: "b", cta: "learn_more" }, asset: testAsset() },
      ],
    });
    await expect(p.launch(mixed)).rejects.toBeInstanceOf(PlatformError);
    await expect(p.launch(testSpec())).rejects.toBeInstanceOf(PlatformError);
    expect(f.calls.length).toBe(0);
  });

  test("stats via adAnalytics (campaign + creative pivots) with a rejection", async () => {
    const analytics = (pivot: string): Expect => ({
      method: "GET",
      url: `/rest/adAnalytics?q=analytics&timeGranularity=ALL&dateRange=(start:(year:2026,month:10,day:28))&campaigns=List(urn%3Ali%3AsponsoredCampaign%3A222)&fields=costInLocalCurrency,impressions,clicks,pivotValues&pivot=${pivot}`,
      check: versioned,
      json:
        pivot === "CAMPAIGN"
          ? { elements: [{ costInLocalCurrency: "12.345", impressions: 3000, clicks: 40, pivotValues: ["urn:li:sponsoredCampaign:222"] }] }
          : {
              elements: [
                { costInLocalCurrency: "10.0", impressions: 2500, clicks: 35, pivotValues: ["urn:li:sponsoredCreative:333"] },
                { costInLocalCurrency: "2.345", impressions: 500, clicks: 5, pivotValues: ["urn:li:sponsoredCreative:334"] },
              ],
            },
    });
    const { p, f } = platform([
      tokenCall,
      accountCall(),
      analytics("CAMPAIGN"),
      analytics("CREATIVE"),
      { method: "GET", url: "/rest/adAccounts/5001/adCampaigns/222", json: { status: "ACTIVE", servingStatuses: ["RUNNABLE"] } },
      {
        method: "GET",
        url: "/rest/adAccounts/5001/creatives?q=criteria&campaigns=List(urn%3Ali%3AsponsoredCampaign%3A222)&pageSize=100",
        check: (r) => expect(r.headers["x-restli-method"]).toBe("FINDER"),
        json: {
          elements: [
            { id: "urn:li:sponsoredCreative:333", intendedStatus: "ACTIVE", isServing: true, review: { status: "APPROVED" } },
            { id: "urn:li:sponsoredCreative:334", intendedStatus: "ACTIVE", isServing: false, servingHoldReasons: ["REJECTED"], review: { status: "REJECTED", rejectionReasons: ["CLICKBAIT"] } },
          ],
        },
      },
    ]);
    const s = await p.stats(launched);
    expect(f.done()).toBe(true);
    expect(s).toEqual({
      spend: 12.35,
      currency: "USD",
      impressions: 3000,
      clicks: 40,
      status: "active",
      rejection: "B-4-v2: CLICKBAIT",
      byCreative: {
        "B-4-v1": { spend: 10, impressions: 2500, clicks: 35, status: "active" },
        "B-4-v2": { spend: 2.35, impressions: 500, clicks: 5, status: "rejected" },
      },
    });
  });

  test("stats: all creatives in review", async () => {
    const { p } = platform([
      tokenCall,
      accountCall(),
      { method: "GET", url: "pivot=CAMPAIGN", json: { elements: [] } },
      { method: "GET", url: "pivot=CREATIVE", json: { elements: [] } },
      { method: "GET", url: "/adCampaigns/222", json: { status: "ACTIVE", servingStatuses: ["RUNNABLE"] } },
      {
        method: "GET",
        url: "/creatives?q=criteria",
        json: { elements: [{ id: "urn:li:sponsoredCreative:333", intendedStatus: "ACTIVE", isServing: false, review: { status: "PENDING" } }] },
      },
    ]);
    const s = await p.stats(launched);
    expect(s.status).toBe("in_review");
    expect(s.spend).toBe(0);
  });

  test("pause / resume", async () => {
    const { p, f } = platform([
      tokenCall,
      { method: "POST", url: "/rest/adAccounts/5001/adCampaigns/222", check: (r) => (partial(r), expect(r.json).toEqual({ patch: { $set: { status: "PAUSED" } } })) },
      { method: "POST", url: "/rest/adAccounts/5001/adCampaigns/222", check: (r) => (partial(r), expect(r.json).toEqual({ patch: { $set: { status: "ACTIVE" } } })) },
    ]);
    await p.pause(launched);
    await p.resume(launched);
    expect(f.done()).toBe(true);
  });

  test("setDailyBudget", async () => {
    const { p, f } = platform([
      tokenCall,
      accountCall(),
      {
        method: "POST",
        url: "/rest/adAccounts/5001/adCampaigns/222",
        check: (r) => (partial(r), expect(r.json).toEqual({ patch: { $set: { dailyBudget: { amount: "35.50", currencyCode: "USD" } } } })),
      },
    ]);
    await p.setDailyBudget(launched, 35.5);
    await expect(p.setDailyBudget(launched, 5)).rejects.toBeInstanceOf(PlatformError);
    expect(f.done()).toBe(true);
  });

  test("retries a 429 (Retry-After) then succeeds", async () => {
    const slept: number[] = [];
    const f = scriptedFetch([
      tokenCall,
      { method: "POST", url: "/adCampaigns/222", status: 429, text: "Too Many Requests", headers: { "retry-after": "2" } },
      { method: "POST", url: "/adCampaigns/222", check: partial },
    ]);
    const p = create(creds, { fetch: f.fetch, sleep: async (ms) => void slept.push(ms), now: () => NOW });
    await p.pause(launched);
    expect(f.done()).toBe(true);
    expect(slept).toEqual([2000]);
  });

  test("non-retryable error surfaces as PlatformError without the token", async () => {
    const { p } = platform([tokenCall, { method: "POST", url: "/adCampaigns/222", status: 403, json: { message: "Not enough permissions" } }]);
    const err = (await p.pause(launched).catch((e) => e)) as PlatformError;
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain("at_1");
  });

  test("info.clickIdParam is li_fat_id", () => {
    expect(info.clickIdParam).toBe("li_fat_id");
  });

  test("launch refuses a budget in another currency than the account's, before creating anything", async () => {
    const { p, f } = platform([tokenCall, accountCall({ currency: "EUR" })]);
    const spec = testSpec({ identity: { platform: "linkedin", ref: "urn:li:organization:777", displayName: "Buddy" }, currency: "USD" });
    await expect(p.launch(spec)).rejects.toThrow(/bills in EUR/);
    expect(f.done()).toBe(true);
  });

  test("launch refuses when the ad account can't spend", async () => {
    const { p } = platform([tokenCall, accountCall({ servingStatuses: ["BILLING_HOLD"] })]);
    const spec = testSpec({ identity: { platform: "linkedin", ref: "urn:li:organization:777", displayName: "Buddy" } });
    await expect(p.launch(spec)).rejects.toThrow(/BILLING_HOLD/);
  });

  test("accountInfo", async () => {
    const { p } = platform([tokenCall, accountCall({ currency: "GBP" }), accountCall({ status: "CANCELED" })]);
    expect(await p.accountInfo()).toEqual({ id: "5001", name: "day2 ads", currency: "GBP", canSpend: true });
    expect(await p.accountInfo()).toEqual({ id: "5001", name: "day2 ads", currency: "USD", canSpend: false, problem: "ad account status is CANCELED" });
  });

  test("setAdActive pauses / re-activates one creative", async () => {
    const { p, f } = platform([
      tokenCall,
      {
        method: "POST",
        url: "/rest/adAccounts/5001/creatives/urn%3Ali%3AsponsoredCreative%3A334",
        check: (r) => (partial(r), expect(r.json).toEqual({ patch: { $set: { intendedStatus: "PAUSED" } } })),
      },
      {
        method: "POST",
        url: "/rest/adAccounts/5001/creatives/urn%3Ali%3AsponsoredCreative%3A334",
        check: (r) => expect(r.json).toEqual({ patch: { $set: { intendedStatus: "ACTIVE" } } }),
      },
    ]);
    await p.setAdActive(launched, "B-4-v2", false);
    await p.setAdActive(launched, "B-4-v2", true);
    await expect(p.setAdActive(launched, "nope", true)).rejects.toBeInstanceOf(PlatformError);
    expect(f.done()).toBe(true);
  });

  test("checkIdentity reads day2's Page roles", async () => {
    const id = { platform: "linkedin" as const, ref: "urn:li:organization:777", displayName: "Buddy" };
    const acls = (elements: unknown[]): Expect => ({
      method: "GET",
      url: "/rest/organizationAcls?q=roleAssignee&start=0&count=100",
      check: versioned,
      json: { elements },
    });
    const { p } = platform([
      tokenCall,
      acls([
        { role: "ANALYST", organization: "urn:li:organization:777", roleAssignee: "urn:li:person:d2", state: "APPROVED" },
        { role: "DIRECT_SPONSORED_CONTENT_POSTER", organization: "urn:li:organization:777", roleAssignee: "urn:li:person:d2", state: "APPROVED" },
      ]),
      acls([{ role: "DIRECT_SPONSORED_CONTENT_POSTER", organizationTarget: "urn:li:organization:777", roleAssignee: "urn:li:person:d2", state: "REQUESTED" }]),
      acls([{ role: "ADMINISTRATOR", organization: "urn:li:organization:888", roleAssignee: "urn:li:person:d2", state: "APPROVED" }]),
      { method: "GET", url: "/rest/organizationAcls?q=roleAssignee", status: 403, json: { message: "Not enough permissions" } },
    ]);
    expect(await p.checkIdentity!(id)).toEqual({ ok: true });
    const pending = await p.checkIdentity!(id);
    expect(pending.ok).toBe(false);
    expect(!pending.ok && pending.problem).toMatch(/waiting for a Page super admin/);
    const none = await p.checkIdentity!(id);
    expect(!none.ok && none.problem).toMatch(/no Sponsored Content Poster/);
    const denied = await p.checkIdentity!(id);
    expect(!denied.ok && denied.problem).toMatch(/403/);
  });

  test("ensureConversions finds by name (re-enabling) and creates what's missing", async () => {
    const { p, f } = platform([
      tokenCall,
      {
        method: "GET",
        url: "/rest/conversions?q=account&account=urn%3Ali%3AsponsoredAccount%3A5001&start=0&count=100",
        check: versioned,
        json: {
          elements: [
            { id: 701, name: "day2 sign-up (Conversions API)", conversionMethod: "CONVERSIONS_API", enabled: false, type: "SIGN_UP" },
            { id: 699, name: "day2 activation (Conversions API)", conversionMethod: "INSIGHT_TAG", enabled: true },
          ],
        },
      },
      { method: "POST", url: "/rest/conversions/701", check: (r) => (partial(r), expect(r.json).toEqual({ patch: { $set: { enabled: true } } })) },
      {
        method: "POST",
        url: "/rest/conversions",
        check: (r) => {
          versioned(r);
          expect(r.json).toEqual({
            name: "day2 activation (Conversions API)",
            account: "urn:li:sponsoredAccount:5001",
            conversionMethod: "CONVERSIONS_API",
            type: "OTHER",
            attributionType: "LAST_TOUCH_BY_CAMPAIGN",
            postClickAttributionWindowSize: 30,
            viewThroughAttributionWindowSize: 7,
          });
        },
        status: 201,
        headers: { "x-restli-id": "702" },
        json: { id: 702 },
      },
    ]);
    expect(await p.ensureConversions!()).toEqual({
      platform: "linkedin",
      refs: { account: "5001", signup: "urn:lla:llaPartnerConversion:701", activated: "urn:lla:llaPartnerConversion:702" },
    });
    expect(f.done()).toBe(true);
  });

  const setup = { platform: "linkedin" as const, refs: { account: "5001", signup: "urn:lla:llaPartnerConversion:701", activated: "urn:lla:llaPartnerConversion:702" } };
  const conv = (eventId: string, over: Record<string, unknown> = {}) => ({
    eventId,
    name: "signup" as const,
    at: "2026-10-28T11:00:00Z",
    click: { param: "li_fat_id", value: `fat-${eventId}` },
    pageUrl: "https://buddy.example/go/split",
    ...over,
  });

  test("sendConversions batches valid events and rejects the rest locally", async () => {
    const { p, f } = platform([
      tokenCall,
      {
        method: "POST",
        url: "/rest/conversionEvents",
        check: (r) => {
          versioned(r);
          expect(r.headers["x-restli-method"]).toBe("BATCH_CREATE");
          expect(r.json).toEqual({
            elements: [
              {
                conversion: "urn:lla:llaPartnerConversion:701",
                conversionHappenedAt: Date.parse("2026-10-28T11:00:00Z"),
                user: {
                  userIds: [
                    { idType: "LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID", idValue: "fat-e1" },
                    { idType: "PLAINTEXT_IP_ADDRESS", idValue: "203.0.113.7" },
                  ],
                  externalIds: ["hash-u1"],
                },
                eventId: "e1",
              },
              {
                conversion: "urn:lla:llaPartnerConversion:702",
                conversionHappenedAt: Date.parse("2026-10-28T11:00:00Z"),
                user: { userIds: [{ idType: "LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID", idValue: "fat-e2" }] },
                eventId: "e2",
              },
            ],
          });
        },
        status: 201,
      },
    ]);
    const out = await p.sendConversions!(setup, [
      conv("e1", { externalId: "hash-u1", clientIp: "203.0.113.7", userAgent: "Mozilla/5.0" }),
      conv("e2", { name: "activated", clientIp: "2001:db8::1" }),
      conv("e3", { click: { param: "gclid", value: "x" } }),
      conv("e4", { at: "2026-06-01T00:00:00Z" }),
    ]);
    expect(f.done()).toBe(true);
    expect(out.sent).toBe(2);
    expect(out.rejected.map((r) => r.eventId)).toEqual(["e3", "e4"]);
  });

  test("sendConversions isolates a bad event when the batch is refused", async () => {
    const { p, f } = platform([
      tokenCall,
      { method: "POST", url: "/rest/conversionEvents", status: 400, json: { message: "batchIndex 1: invalid idValue" } },
      { method: "POST", url: "/rest/conversionEvents", check: (r) => expect(r.headers["x-restli-method"]).toBeUndefined(), status: 201 },
      { method: "POST", url: "/rest/conversionEvents", status: 400, json: { message: "invalid idValue" } },
    ]);
    const out = await p.sendConversions!(setup, [conv("e1"), conv("e2")]);
    expect(f.done()).toBe(true);
    expect(out.sent).toBe(1);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]!.eventId).toBe("e2");
  });
});
