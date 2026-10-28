import { describe, expect, test } from "bun:test";
import { noSleep, scriptedFetch, testImage, testSpec, type Expect, type Recorded } from "../test-helpers";
import { PlatformError, type Launched } from "../types";
import { create, credentialsFromEnv, info, type GoogleCreds } from "./google";

const creds: GoogleCreds = {
  developerToken: "dev-tok-123",
  clientId: "cid.apps.googleusercontent.com",
  clientSecret: "csecret",
  refreshToken: "1//refresh",
  customerId: "1234567890",
  loginCustomerId: "9876543210",
  apiVersion: "v26",
};

const C = "customers/1234567890";
const API = `https://googleads.googleapis.com/v26/${C}`;
const NOW = new Date("2026-10-28T10:00:00.000Z");

const tokenCall: Expect = {
  method: "POST",
  url: "https://oauth2.googleapis.com/token",
  check: (r) => {
    expect(r.json).toEqual({ grant_type: "refresh_token", client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: creds.refreshToken });
    expect(r.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  },
  json: { access_token: "ya29.access", expires_in: 3599, token_type: "Bearer" },
};

const authed = (r: Recorded) => {
  expect(r.headers.authorization).toBe("Bearer ya29.access");
  expect(r.headers["developer-token"]).toBe("dev-tok-123");
  expect(r.headers["login-customer-id"]).toBe("9876543210");
};

const searchCall = (match: (q: string) => void, results: unknown[]): Expect => ({
  method: "POST",
  url: `${API}/googleAds:search`,
  check: (r) => {
    authed(r);
    match((r.json as { query: string }).query);
  },
  json: { results, fieldMask: "x" },
});

const currencyCall = searchCall((q) => expect(q).toBe("SELECT customer.currency_code FROM customer"), [{ customer: { currencyCode: "USD", resourceName: C } }]);
const geoCall = searchCall(
  (q) => {
    expect(q).toContain("FROM geo_target_constant");
    expect(q).toContain("geo_target_constant.target_type = 'Country'");
    expect(q).toContain("geo_target_constant.country_code IN ('DE')");
  },
  [{ geoTargetConstant: { resourceName: "geoTargetConstants/2276", countryCode: "DE" } }],
);
const langCall = searchCall(
  (q) => {
    expect(q).toContain("FROM language_constant");
    expect(q).toContain("language_constant.code IN ('de')");
  },
  [{ languageConstant: { resourceName: "languageConstants/1001", code: "de" } }],
);

const enableCall: Expect = {
  method: "POST",
  url: `${API}/campaigns:mutate`,
  check: (r) => {
    authed(r);
    expect(r.json).toEqual({ operations: [{ update: { resourceName: `${C}/campaigns/555`, status: "ENABLED" }, updateMask: "status" }] });
  },
  json: { results: [{ resourceName: `${C}/campaigns/555` }] },
};

const textSpec = () =>
  testSpec({
    creatives: [
      { key: "B-4-v1", copy: { headline: "Split a dinner bill in 10 seconds", body: "Add the bill, pick who was there, done.", description: "Free for groups", cta: "sign_up" }, asset: null },
    ],
  });

function platform(script: Expect[]) {
  const f = scriptedFetch(script);
  const p = create(creds, { fetch: f.fetch, sleep: noSleep, now: () => NOW, readAsset: async (a) => new TextEncoder().encode(`bytes-of-${a.id}`) });
  return { p, f };
}

const launched: Launched = {
  platform: "google",
  campaignId: "555",
  refs: { customerId: "1234567890", budget: `${C}/campaignBudgets/111`, campaign: `${C}/campaigns/555`, adGroup: `${C}/adGroups/777`, channel: "SEARCH" },
  ads: { "B-4-v1": "9001", "B-4-v2": "9002" },
};

describe("google info", () => {
  test("declares images only, text-only search, limits and env", () => {
    expect(info.id).toBe("google");
    expect(info.textOnly).toBe(true);
    expect(info.identity).toBe("none");
    expect(info.formats.every((f) => f.kind === "image")).toBe(true);
    expect(info.formats.map((f) => f.ratio)).toEqual(["1.91:1", "1:1", "4:5"]);
    expect(info.copyLimits).toEqual({ headline: 30, body: 90, description: 90 });
    expect(info.audiences).toEqual(["consumer", "business"]);
    expect(info.apiVersion).toBe("v26");
    expect(info.env).toContain("GOOGLE_ADS_DEVELOPER_TOKEN");
  });
});

describe("google credentialsFromEnv", () => {
  const env = {
    GOOGLE_ADS_DEVELOPER_TOKEN: "d",
    GOOGLE_ADS_CLIENT_ID: "c",
    GOOGLE_ADS_CLIENT_SECRET: "s",
    GOOGLE_ADS_REFRESH_TOKEN: "r",
    GOOGLE_ADS_CUSTOMER_ID: "123-456-7890",
  };
  test("reads and normalizes", () => {
    expect(credentialsFromEnv(env)).toEqual({ developerToken: "d", clientId: "c", clientSecret: "s", refreshToken: "r", customerId: "1234567890", loginCustomerId: undefined, apiVersion: "v26" });
    expect(credentialsFromEnv({ ...env, GOOGLE_ADS_LOGIN_CUSTOMER_ID: "987-654-3210", GOOGLE_ADS_API_VERSION: "v25" })).toMatchObject({ loginCustomerId: "9876543210", apiVersion: "v25" });
  });
  test("null when anything required is missing or malformed", () => {
    for (const k of Object.keys(env)) expect(credentialsFromEnv({ ...env, [k]: undefined })).toBeNull();
    expect(credentialsFromEnv({})).toBeNull();
    expect(credentialsFromEnv({ ...env, GOOGLE_ADS_CUSTOMER_ID: "12345" })).toBeNull();
  });
});

describe("google oauth", () => {
  test("refreshes once, reuses the token, refreshes again after expiry", async () => {
    let t = NOW.getTime();
    const pauseCall: Expect = { method: "POST", url: `${API}/campaigns:mutate`, check: authed, json: { results: [{}] } };
    const f = scriptedFetch([tokenCall, pauseCall, pauseCall, tokenCall, pauseCall]);
    const p = create(creds, { fetch: f.fetch, sleep: noSleep, now: () => new Date(t) });
    await p.pause(launched);
    await p.pause(launched);
    t += 3600_000;
    await p.pause(launched);
    expect(f.done()).toBe(true);
  });

  test("OAuth failure is a PlatformError without the secret", async () => {
    const { p } = platform([{ method: "POST", url: "oauth2.googleapis.com/token", status: 400, json: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }]);
    const err = (await p.pause(launched).catch((e) => e)) as PlatformError;
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.status).toBe(400);
    expect(err.message).not.toContain("csecret");
    expect(err.message).not.toContain("1//refresh");
  });
});

describe("google launch: Search (text-only)", () => {
  test("creates budget → campaign PAUSED → criteria → ad group → keywords → RSA in one mutate, then enables", async () => {
    const { p, f } = platform([
      tokenCall,
      currencyCall,
      geoCall,
      langCall,
      {
        method: "POST",
        url: `${API}/googleAds:mutate`,
        check: (r) => {
          authed(r);
          const ops = (r.json as { mutateOperations: Array<Record<string, any>> }).mutateOperations;
          expect(ops).toEqual([
            {
              campaignBudgetOperation: {
                create: { resourceName: `${C}/campaignBudgets/-1`, name: "day2 Buddy B-4 budget 2026-10-28T10:00:00.000Z", amountMicros: "20000000", deliveryMethod: "STANDARD", explicitlyShared: false },
              },
            },
            {
              campaignOperation: {
                create: {
                  resourceName: `${C}/campaigns/-2`,
                  name: "day2 Buddy B-4",
                  status: "PAUSED",
                  advertisingChannelType: "SEARCH",
                  campaignBudget: `${C}/campaignBudgets/-1`,
                  targetSpend: {},
                  containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
                  geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" },
                  networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false, targetPartnerSearchNetwork: false },
                },
              },
            },
            { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/-2`, location: { geoTargetConstant: "geoTargetConstants/2276" } } } },
            { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/-2`, language: { languageConstant: "languageConstants/1001" } } } },
            { adGroupOperation: { create: { resourceName: `${C}/adGroups/-3`, name: "day2 Buddy B-4 ad group", campaign: `${C}/campaigns/-2`, status: "ENABLED", type: "SEARCH_STANDARD" } } },
            { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/-3`, status: "ENABLED", keyword: { text: "split bills app", matchType: "PHRASE" } } } },
            {
              adGroupAdOperation: {
                create: {
                  adGroup: `${C}/adGroups/-3`,
                  status: "ENABLED",
                  ad: {
                    finalUrls: ["https://buddy.example/go/split?d2=B-4.x"],
                    responsiveSearchAd: {
                      headlines: [{ text: "Split a dinner bill in 10…" }, { text: "Buddy" }, { text: "Sign Up" }, { text: "Buddy – Sign Up" }, { text: "Try Buddy" }],
                      descriptions: [
                        { text: "Add the bill, pick who was there, done." },
                        { text: "Free for groups" },
                        { text: "Split a dinner bill in 10 seconds. Sign Up." },
                        { text: "Buddy. Sign Up." },
                      ],
                    },
                  },
                },
              },
            },
          ]);
          const rsa = ops[6]!.adGroupAdOperation.create.ad.responsiveSearchAd;
          expect(rsa.headlines.length).toBeGreaterThanOrEqual(3);
          expect(rsa.headlines.every((h: { text: string }) => h.text.length <= 30)).toBe(true);
          expect(rsa.descriptions.length).toBeGreaterThanOrEqual(2);
          expect(rsa.descriptions.every((d: { text: string }) => d.text.length <= 90)).toBe(true);
        },
        json: {
          mutateOperationResponses: [
            { campaignBudgetResult: { resourceName: `${C}/campaignBudgets/111` } },
            { campaignResult: { resourceName: `${C}/campaigns/555` } },
            { campaignCriterionResult: { resourceName: `${C}/campaignCriteria/555~2276` } },
            { campaignCriterionResult: { resourceName: `${C}/campaignCriteria/555~1001` } },
            { adGroupResult: { resourceName: `${C}/adGroups/777` } },
            { adGroupCriterionResult: { resourceName: `${C}/adGroupCriteria/777~888` } },
            { adGroupAdResult: { resourceName: `${C}/adGroupAds/777~9001` } },
          ],
        },
      },
      enableCall,
    ]);
    const out = await p.launch(textSpec());
    expect(out).toEqual({
      platform: "google",
      campaignId: "555",
      refs: { customerId: "1234567890", budget: `${C}/campaignBudgets/111`, campaign: `${C}/campaigns/555`, adGroup: `${C}/adGroups/777`, channel: "SEARCH" },
      ads: { "B-4-v1": "9001" },
    });
    expect(f.done()).toBe(true);
  });

  test("removes the campaign and budget when enabling fails, and rethrows", async () => {
    const { p, f } = platform([
      tokenCall,
      currencyCall,
      geoCall,
      langCall,
      {
        method: "POST",
        url: `${API}/googleAds:mutate`,
        json: {
          mutateOperationResponses: [
            { campaignBudgetResult: { resourceName: `${C}/campaignBudgets/111` } },
            { campaignResult: { resourceName: `${C}/campaigns/555` } },
            {},
            {},
            { adGroupResult: { resourceName: `${C}/adGroups/777` } },
            {},
            { adGroupAdResult: { resourceName: `${C}/adGroupAds/777~9001` } },
          ],
        },
      },
      { method: "POST", url: `${API}/campaigns:mutate`, status: 400, json: { error: { code: 400, status: "INVALID_ARGUMENT", message: "Request contains an invalid argument." } } },
      {
        method: "POST",
        url: `${API}/googleAds:mutate`,
        check: (r) => expect(r.json).toEqual({ mutateOperations: [{ campaignOperation: { remove: `${C}/campaigns/555` } }, { campaignBudgetOperation: { remove: `${C}/campaignBudgets/111` } }] }),
        json: { mutateOperationResponses: [{}, {}] },
      },
    ]);
    const err = await p.launch(textSpec()).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect((err as PlatformError).status).toBe(400);
    expect(f.done()).toBe(true);
  });

  test("refuses a non-USD account before creating anything", async () => {
    const { p, f } = platform([tokenCall, searchCall(() => {}, [{ customer: { currencyCode: "EUR" } }])]);
    const err = await p.launch(textSpec()).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(String(err.message)).toContain("EUR");
    expect(f.done()).toBe(true);
  });

  test("needs keywords for Search", async () => {
    const { p, f } = platform([]);
    const spec = textSpec();
    spec.targeting.keywords = [];
    await expect(p.launch(spec)).rejects.toBeInstanceOf(PlatformError);
    expect(f.calls.length).toBe(0);
  });
});

describe("google launch: Demand Gen (images)", () => {
  test("uploads images via AssetService, builds a multi-asset ad per image, then enables", async () => {
    const wide = testImage({ id: "as_wide", ratio: "1.91:1", width: 1200, height: 628, mime: "image/jpeg" });
    const square = testImage({ id: "as_sq" });
    const logo = testImage({ id: "as_logo", width: 512, height: 512 });
    const copy = { headline: "Split a dinner bill in 10 seconds", body: "Add the bill, pick who was there, done.", cta: "download" as const };
    const spec = testSpec({
      creatives: [
        { key: "B-4-wide", copy, asset: wide },
        { key: "B-4-sq", copy, asset: square },
      ],
      identity: { platform: "google", ref: "", displayName: "Buddy", logo },
    });
    const b64 = (id: string) => Buffer.from(`bytes-of-${id}`).toString("base64");
    const { p, f } = platform([
      tokenCall,
      currencyCall,
      geoCall,
      langCall,
      {
        method: "POST",
        url: `${API}/assets:mutate`,
        check: (r) => {
          authed(r);
          expect(r.json).toEqual({
            operations: [
              { create: { name: "day2 Buddy B-4 2026-10-28T10:00:00.000Z as_wide", type: "IMAGE", imageAsset: { data: b64("as_wide") } } },
              { create: { name: "day2 Buddy B-4 2026-10-28T10:00:00.000Z as_sq", type: "IMAGE", imageAsset: { data: b64("as_sq") } } },
              { create: { name: "day2 Buddy B-4 2026-10-28T10:00:00.000Z as_logo", type: "IMAGE", imageAsset: { data: b64("as_logo") } } },
            ],
          });
        },
        json: { results: [{ resourceName: `${C}/assets/1` }, { resourceName: `${C}/assets/2` }, { resourceName: `${C}/assets/3` }] },
      },
      {
        method: "POST",
        url: `${API}/googleAds:mutate`,
        check: (r) => {
          const ops = (r.json as { mutateOperations: Array<Record<string, any>> }).mutateOperations;
          expect(ops.map((o) => Object.keys(o)[0])).toEqual([
            "campaignBudgetOperation",
            "campaignOperation",
            "adGroupOperation",
            "adGroupCriterionOperation",
            "adGroupCriterionOperation",
            "adGroupAdOperation",
            "adGroupAdOperation",
          ]);
          expect(ops[0]!.campaignBudgetOperation.create.explicitlyShared).toBe(false);
          const camp = ops[1]!.campaignOperation.create;
          expect(camp).toMatchObject({ status: "PAUSED", advertisingChannelType: "DEMAND_GEN", targetSpend: {}, containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING" });
          expect(camp.networkSettings).toBeUndefined();
          expect(camp.advertisingChannelSubType).toBeUndefined();
          expect(ops[2]!.adGroupOperation.create).toEqual({ resourceName: `${C}/adGroups/-3`, name: "day2 Buddy B-4 ad group", campaign: `${C}/campaigns/-2`, status: "ENABLED" });
          expect(ops[3]!.adGroupCriterionOperation.create).toEqual({ adGroup: `${C}/adGroups/-3`, location: { geoTargetConstant: "geoTargetConstants/2276" } });
          expect(ops[4]!.adGroupCriterionOperation.create).toEqual({ adGroup: `${C}/adGroups/-3`, language: { languageConstant: "languageConstants/1001" } });
          expect(ops[5]!.adGroupAdOperation.create).toEqual({
            adGroup: `${C}/adGroups/-3`,
            status: "ENABLED",
            ad: {
              name: "day2 Buddy B-4 B-4-wide",
              finalUrls: ["https://buddy.example/go/split?d2=B-4.x"],
              demandGenMultiAssetAd: {
                marketingImages: [{ asset: `${C}/assets/1` }],
                logoImages: [{ asset: `${C}/assets/3` }],
                headlines: [{ text: "Split a dinner bill in 10 seconds" }, { text: "Buddy" }, { text: "Download Now" }, { text: "Buddy – Download Now" }, { text: "Try Buddy" }],
                descriptions: [{ text: "Add the bill, pick who was there, done." }, { text: "Split a dinner bill in 10 seconds. Download Now." }, { text: "Buddy. Download Now." }],
                businessName: "Buddy",
              },
            },
          });
          const sq = ops[6]!.adGroupAdOperation.create.ad.demandGenMultiAssetAd;
          expect(sq.squareMarketingImages).toEqual([{ asset: `${C}/assets/2` }]);
          expect(sq.marketingImages).toBeUndefined();
          expect(sq.logoImages).toEqual([{ asset: `${C}/assets/3` }]);
        },
        json: {
          mutateOperationResponses: [
            { campaignBudgetResult: { resourceName: `${C}/campaignBudgets/111` } },
            { campaignResult: { resourceName: `${C}/campaigns/555` } },
            { adGroupResult: { resourceName: `${C}/adGroups/777` } },
            { adGroupCriterionResult: { resourceName: `${C}/adGroupCriteria/777~2276` } },
            { adGroupCriterionResult: { resourceName: `${C}/adGroupCriteria/777~1001` } },
            { adGroupAdResult: { resourceName: `${C}/adGroupAds/777~9101` } },
            { adGroupAdResult: { resourceName: `${C}/adGroupAds/777~9102` } },
          ],
        },
      },
      enableCall,
    ]);
    const out = await p.launch(spec);
    expect(out.refs).toMatchObject({ campaign: `${C}/campaigns/555`, budget: `${C}/campaignBudgets/111`, adGroup: `${C}/adGroups/777`, channel: "DEMAND_GEN" });
    expect(out.ads).toEqual({ "B-4-wide": "9101", "B-4-sq": "9102" });
    expect(f.done()).toBe(true);
  });

  test("without Identity.logo the square creative doubles as logo (uploaded once)", async () => {
    const square = testImage({ id: "as_sq" });
    const spec = testSpec({ creatives: [{ key: "k", copy: { headline: "Split bills fast", body: "Add the bill, done.", cta: "learn_more" }, asset: square }] });
    const { p, f } = platform([
      tokenCall,
      currencyCall,
      geoCall,
      langCall,
      { method: "POST", url: `${API}/assets:mutate`, check: (r) => expect((r.json as any).operations.length).toBe(1), json: { results: [{ resourceName: `${C}/assets/2` }] } },
      {
        method: "POST",
        url: `${API}/googleAds:mutate`,
        check: (r) => {
          const ad = (r.json as any).mutateOperations.at(-1).adGroupAdOperation.create.ad.demandGenMultiAssetAd;
          expect(ad.squareMarketingImages).toEqual([{ asset: `${C}/assets/2` }]);
          expect(ad.logoImages).toEqual([{ asset: `${C}/assets/2` }]);
        },
        json: {
          mutateOperationResponses: [
            { campaignBudgetResult: { resourceName: `${C}/campaignBudgets/111` } },
            { campaignResult: { resourceName: `${C}/campaigns/555` } },
            { adGroupResult: { resourceName: `${C}/adGroups/777` } },
            {},
            {},
            { adGroupAdResult: { resourceName: `${C}/adGroupAds/777~9101` } },
          ],
        },
      },
      enableCall,
    ]);
    expect((await p.launch(spec)).ads).toEqual({ k: "9101" });
    expect(f.done()).toBe(true);
  });

  test("a 5xx on the create mutate looks up and removes anything it created, then rethrows retryable", async () => {
    const wide = testImage({ id: "as_wide", ratio: "1.91:1", width: 1200, height: 628 });
    const spec = testSpec({ creatives: [{ key: "k", copy: { headline: "Split bills fast", body: "Add the bill, done.", cta: "learn_more" }, asset: wide }], identity: { platform: "google", ref: "", displayName: "Buddy", logo: testImage({ id: "as_logo" }) } });
    const { p, f } = platform([
      tokenCall,
      currencyCall,
      geoCall,
      langCall,
      { method: "POST", url: `${API}/assets:mutate`, json: { results: [{ resourceName: `${C}/assets/1` }, { resourceName: `${C}/assets/3` }] } },
      { method: "POST", url: `${API}/googleAds:mutate`, status: 503, json: { error: { code: 503, status: "UNAVAILABLE" } } },
      searchCall((q) => expect(q).toContain("campaign_budget.name = 'day2 Buddy B-4 budget 2026-10-28T10:00:00.000Z'"), [
        { campaign: { resourceName: `${C}/campaigns/555` }, campaignBudget: { resourceName: `${C}/campaignBudgets/111` } },
      ]),
      {
        method: "POST",
        url: `${API}/googleAds:mutate`,
        check: (r) => expect(r.json).toEqual({ mutateOperations: [{ campaignOperation: { remove: `${C}/campaigns/555` } }, { campaignBudgetOperation: { remove: `${C}/campaignBudgets/111` } }] }),
        json: {},
      },
    ]);
    const err = (await p.launch(spec).catch((e) => e)) as PlatformError;
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.retryable).toBe(true);
    expect(f.done()).toBe(true);
  });
});

describe("google stats", () => {
  test("GAQL for campaign metrics and ad policy; disapproval surfaces as rejection", async () => {
    const { p, f } = platform([
      tokenCall,
      searchCall(
        (q) => {
          expect(q).toContain("metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign");
          expect(q).toContain(`WHERE campaign.resource_name = '${C}/campaigns/555'`);
        },
        [{ campaign: { resourceName: `${C}/campaigns/555`, status: "ENABLED", primaryStatus: "NOT_ELIGIBLE", servingStatus: "SERVING" }, metrics: { costMicros: "12345678", impressions: "1000", clicks: "42" } }],
      ),
      searchCall(
        (q) => {
          expect(q).toContain("ad_group_ad.policy_summary.approval_status");
          expect(q).toContain("ad_group_ad.policy_summary.policy_topic_entries");
          expect(q).toContain("FROM ad_group_ad WHERE campaign.resource_name");
        },
        [
          {
            adGroupAd: { ad: { id: "9001" }, status: "ENABLED", policySummary: { approvalStatus: "DISAPPROVED", reviewStatus: "REVIEWED", policyTopicEntries: [{ topic: "DESTINATION_NOT_WORKING", type: "PROHIBITED" }] } },
            metrics: { costMicros: "12345678", impressions: "1000", clicks: "42" },
          },
          {
            adGroupAd: { ad: { id: "9002" }, status: "ENABLED", policySummary: { approvalStatus: "DISAPPROVED", reviewStatus: "REVIEWED", policyTopicEntries: [{ topic: "MISLEADING_CONTENT", type: "PROHIBITED" }, { topic: "TRADEMARKS_IN_AD_TEXT", type: "LIMITED" }] } },
            metrics: { costMicros: "0", impressions: "0", clicks: "0" },
          },
        ],
      ),
    ]);
    expect(await p.stats(launched)).toEqual({
      spendUsd: 12.345678,
      impressions: 1000,
      clicks: 42,
      status: "rejected",
      rejection: "Ad disapproved: DESTINATION_NOT_WORKING, MISLEADING_CONTENT",
      byCreative: {
        "B-4-v1": { spendUsd: 12.345678, impressions: 1000, clicks: 42, status: "rejected" },
        "B-4-v2": { spendUsd: 0, impressions: 0, clicks: 0, status: "rejected" },
      },
    });
    expect(f.done()).toBe(true);
  });

  test("active, in review, paused, removed", async () => {
    const run = async (campaign: object, ads: object[]) => {
      const { p } = platform([tokenCall, searchCall(() => {}, [{ campaign, metrics: {} }]), searchCall(() => {}, ads)]);
      return (await p.stats(launched)).status;
    };
    const ok = { adGroupAd: { ad: { id: "9001" }, status: "ENABLED", policySummary: { approvalStatus: "APPROVED", reviewStatus: "REVIEWED" } } };
    const review = { adGroupAd: { ad: { id: "9002" }, status: "ENABLED", policySummary: { approvalStatus: "UNKNOWN", reviewStatus: "REVIEW_IN_PROGRESS" } } };
    expect(await run({ status: "ENABLED", primaryStatus: "ELIGIBLE" }, [ok, review])).toBe("active");
    expect(await run({ status: "ENABLED", primaryStatus: "PENDING" }, [review])).toBe("in_review");
    expect(await run({ status: "PAUSED" }, [ok])).toBe("paused");
    expect(await run({ status: "REMOVED" }, [ok])).toBe("ended");
  });
});

describe("google pause/resume/budget", () => {
  test("pause and resume update campaign status", async () => {
    const statusCall = (status: string): Expect => ({
      method: "POST",
      url: `${API}/campaigns:mutate`,
      check: (r) => {
        authed(r);
        expect(r.json).toEqual({ operations: [{ update: { resourceName: `${C}/campaigns/555`, status }, updateMask: "status" }] });
      },
      json: { results: [{ resourceName: `${C}/campaigns/555` }] },
    });
    const { p, f } = platform([tokenCall, statusCall("PAUSED"), statusCall("ENABLED")]);
    await p.pause(launched);
    await p.resume(launched);
    expect(f.done()).toBe(true);
  });

  test("setDailyBudget writes micros on the CampaignBudget", async () => {
    const { p, f } = platform([
      tokenCall,
      currencyCall,
      {
        method: "POST",
        url: `${API}/campaignBudgets:mutate`,
        check: (r) => {
          authed(r);
          expect(r.json).toEqual({ operations: [{ update: { resourceName: `${C}/campaignBudgets/111`, amountMicros: "35500000" }, updateMask: "amountMicros" }] });
        },
        json: { results: [{ resourceName: `${C}/campaignBudgets/111` }] },
      },
    ]);
    await p.setDailyBudget(launched, 35.5);
    expect(f.done()).toBe(true);
  });

  test("setDailyBudget rejects nonsense amounts without calling", async () => {
    const { p, f } = platform([]);
    await expect(p.setDailyBudget(launched, 0)).rejects.toBeInstanceOf(PlatformError);
    await expect(p.setDailyBudget(launched, Number.NaN)).rejects.toBeInstanceOf(PlatformError);
    expect(f.calls.length).toBe(0);
  });
});

describe("google rate limits", () => {
  const exhausted: Expect = {
    method: "POST",
    url: `${API}/campaigns:mutate`,
    status: 429,
    json: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Too many requests." } },
  };
  test("429 RESOURCE_EXHAUSTED is retried", async () => {
    const { p, f } = platform([tokenCall, exhausted, { method: "POST", url: `${API}/campaigns:mutate`, json: { results: [{}] } }]);
    await p.pause(launched);
    expect(f.done()).toBe(true);
  });
  test("persistent 429 becomes a retryable PlatformError", async () => {
    const { p, f } = platform([tokenCall, exhausted, exhausted, exhausted]);
    const err = (await p.pause(launched).catch((e) => e)) as PlatformError;
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(429);
    expect(f.done()).toBe(true);
  });
  test("the create mutate retries 429 (nothing was created)", async () => {
    const { p, f } = platform([
      tokenCall,
      currencyCall,
      geoCall,
      langCall,
      { method: "POST", url: `${API}/googleAds:mutate`, status: 429, json: { error: { code: 429, status: "RESOURCE_EXHAUSTED" } } },
      {
        method: "POST",
        url: `${API}/googleAds:mutate`,
        json: {
          mutateOperationResponses: [
            { campaignBudgetResult: { resourceName: `${C}/campaignBudgets/111` } },
            { campaignResult: { resourceName: `${C}/campaigns/555` } },
            {},
            {},
            { adGroupResult: { resourceName: `${C}/adGroups/777` } },
            {},
            { adGroupAdResult: { resourceName: `${C}/adGroupAds/777~9001` } },
          ],
        },
      },
      enableCall,
    ]);
    expect((await p.launch(textSpec())).campaignId).toBe("555");
    expect(f.done()).toBe(true);
  });
});
