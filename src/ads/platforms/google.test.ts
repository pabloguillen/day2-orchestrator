import { beforeEach, describe, expect, test } from "bun:test";
import { noSleep, scriptedFetch, testImage, testSpec, type Expect, type Recorded } from "../test-helpers";
import { PlatformError, type Launched } from "../types";
import { conversionDateTime, create, credentialsFromEnv, info, resetConversionRouteMemory, toMicros, type GoogleCreds } from "./google";

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

const CUSTOMER_Q = "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.status, customer.manager, customer.test_account FROM customer";
const customerRow = { id: "1234567890", descriptiveName: "day2 ads", currencyCode: "USD", status: "ENABLED", manager: false, testAccount: false };
const currencyCall = searchCall((q) => expect(q).toBe(CUSTOMER_Q), [{ customer: customerRow }]);
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
      {
        key: "B-4-v1",
        copy: { headline: "Split a dinner bill in 10 seconds", body: "Add the bill, pick who was there, done.", description: "Free for groups", cta: "sign_up" },
        asset: null,
        link: "https://buddy.example/go/split?d2=B-4.google.v1",
      },
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
    expect(info.env).toContain("GOOGLE_ADS_REFRESH_TOKEN");
    expect(info.clickIdParam).toBe("gclid");
  });

  test("micros in the account currency, rounded to its minimum unit", () => {
    expect(toMicros(20, "USD")).toBe("20000000");
    expect(toMicros(12.345, "EUR")).toBe("12350000");
    expect(toMicros(1500.4, "JPY")).toBe("1500000000");
    expect(() => toMicros(0, "USD")).toThrow(PlatformError);
    expect(() => toMicros(10, "usd")).toThrow(PlatformError);
  });

  test("conversion_date_time format", () => {
    expect(conversionDateTime("2026-10-28T12:34:56.789+02:00")).toBe("2026-10-28 10:34:56+00:00");
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
  test("developer token is optional (sunset 2026-09-09)", () => {
    expect(credentialsFromEnv({ ...env, GOOGLE_ADS_DEVELOPER_TOKEN: undefined })).toMatchObject({ developerToken: undefined, customerId: "1234567890" });
  });
  test("null when anything required is missing or malformed", () => {
    for (const k of Object.keys(env).filter((k) => k !== "GOOGLE_ADS_DEVELOPER_TOKEN")) expect(credentialsFromEnv({ ...env, [k]: undefined })).toBeNull();
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
            { adGroupOperation: { create: { resourceName: `${C}/adGroups/-3`, name: "day2 Buddy B-4 ad group", campaign: `${C}/campaigns/-2`, status: "ENABLED", type: "SEARCH_STANDARD" } } },
            { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/-3`, status: "ENABLED", keyword: { text: "split bills app", matchType: "PHRASE" } } } },
            {
              adGroupAdOperation: {
                create: {
                  adGroup: `${C}/adGroups/-3`,
                  status: "ENABLED",
                  ad: {
                    finalUrls: ["https://buddy.example/go/split?d2=B-4.google.v1"],
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
          const rsa = ops[5]!.adGroupAdOperation.create.ad.responsiveSearchAd;
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
      refs: { customerId: "1234567890", budget: `${C}/campaignBudgets/111`, campaign: `${C}/campaigns/555`, adGroup: `${C}/adGroups/777`, channel: "SEARCH", optimizeFor: "clicks" },
      ads: { "B-4-v1": "9001" },
    });
    expect(f.done()).toBe(true);
  });

  test("removes the campaign and budget when enabling fails, and rethrows", async () => {
    const { p, f } = platform([
      tokenCall,
      currencyCall,
      geoCall,
      {
        method: "POST",
        url: `${API}/googleAds:mutate`,
        json: {
          mutateOperationResponses: [
            { campaignBudgetResult: { resourceName: `${C}/campaignBudgets/111` } },
            { campaignResult: { resourceName: `${C}/campaigns/555` } },
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

  test("budget in the account currency: refuses a currency mismatch before creating anything", async () => {
    const { p, f } = platform([tokenCall, searchCall(() => {}, [{ customer: { ...customerRow, currencyCode: "USD" } }])]);
    const err = await p.launch({ ...textSpec(), currency: "EUR" }).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(String(err.message)).toContain("EUR");
    expect(f.done()).toBe(true);
  });

  test("EUR account: budget micros in EUR", async () => {
    const { p, f } = platform([
      tokenCall,
      searchCall(() => {}, [{ customer: { ...customerRow, currencyCode: "EUR" } }]),
      geoCall,
      {
        method: "POST",
        url: `${API}/googleAds:mutate`,
        check: (r) => expect((r.json as any).mutateOperations[0].campaignBudgetOperation.create.amountMicros).toBe("15500000"),
        json: {
          mutateOperationResponses: [
            { campaignBudgetResult: { resourceName: `${C}/campaignBudgets/111` } },
            { campaignResult: { resourceName: `${C}/campaigns/555` } },
            {},
            { adGroupResult: { resourceName: `${C}/adGroups/777` } },
            {},
            { adGroupAdResult: { resourceName: `${C}/adGroupAds/777~9001` } },
          ],
        },
      },
      enableCall,
    ]);
    await p.launch({ ...textSpec(), currency: "EUR", dailyBudget: 15.5 });
    expect(f.done()).toBe(true);
  });

  test("optimizeFor signups: Maximize conversions on day2's custom sign-up goal only, set before enabling", async () => {
    const goal = `${C}/customConversionGoals/42`;
    const { p, f } = platform([
      tokenCall,
      currencyCall,
      geoCall,
      {
        method: "POST",
        url: `${API}/googleAds:mutate`,
        check: (r) => {
          const camp = (r.json as any).mutateOperations[1].campaignOperation.create;
          expect(camp.maximizeConversions).toEqual({});
          expect(camp.targetSpend).toBeUndefined();
          expect(camp.status).toBe("PAUSED");
        },
        json: {
          mutateOperationResponses: [
            { campaignBudgetResult: { resourceName: `${C}/campaignBudgets/111` } },
            { campaignResult: { resourceName: `${C}/campaigns/555` } },
            {},
            { adGroupResult: { resourceName: `${C}/adGroups/777` } },
            {},
            { adGroupAdResult: { resourceName: `${C}/adGroupAds/777~9001` } },
          ],
        },
      },
      searchCall(
        (q) => expect(q).toBe(`SELECT campaign_conversion_goal.resource_name, campaign_conversion_goal.biddable FROM campaign_conversion_goal WHERE campaign.resource_name = '${C}/campaigns/555'`),
        [
          { campaignConversionGoal: { resourceName: `${C}/campaignConversionGoals/555~SIGNUP~WEBSITE`, biddable: true } },
          { campaignConversionGoal: { resourceName: `${C}/campaignConversionGoals/555~PURCHASE~WEBSITE`, biddable: false } },
        ],
      ),
      {
        method: "POST",
        url: `${API}/googleAds:mutate`,
        check: (r) =>
          expect(r.json).toEqual({
            mutateOperations: [
              { conversionGoalCampaignConfigOperation: { update: { resourceName: `${C}/conversionGoalCampaignConfigs/555`, customConversionGoal: goal }, updateMask: "customConversionGoal" } },
              { campaignConversionGoalOperation: { update: { resourceName: `${C}/campaignConversionGoals/555~SIGNUP~WEBSITE`, biddable: false }, updateMask: "biddable" } },
            ],
          }),
        json: { mutateOperationResponses: [{}, {}] },
      },
      enableCall,
    ]);
    const out = await p.launch({ ...textSpec(), optimizeFor: "signups", conversion: { platform: "google", refs: { signup: `${C}/conversionActions/1`, activated: `${C}/conversionActions/2`, goal } } });
    expect(out.refs.optimizeFor).toBe("signups");
    expect(f.done()).toBe(true);
  });

  test("optimizeFor signups without a conversion setup fails before any call", async () => {
    const { p, f } = platform([]);
    await expect(p.launch({ ...textSpec(), optimizeFor: "signups" })).rejects.toBeInstanceOf(PlatformError);
    expect(f.calls.length).toBe(0);
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
        { key: "B-4-wide", copy, asset: wide, link: "https://buddy.example/go/split?d2=B-4.google.wide" },
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
              finalUrls: ["https://buddy.example/go/split?d2=B-4.google.wide"],
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
          expect(ops[6]!.adGroupAdOperation.create.ad.finalUrls).toEqual(["https://buddy.example/go/split?d2=B-4.x"]);
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
          expect(q).toContain("customer.currency_code, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign");
          expect(q).toContain(`WHERE campaign.resource_name = '${C}/campaigns/555'`);
        },
        [{ campaign: { resourceName: `${C}/campaigns/555`, status: "ENABLED", primaryStatus: "NOT_ELIGIBLE", servingStatus: "SERVING" }, customer: { currencyCode: "EUR" }, metrics: { costMicros: "12345678", impressions: "1000", clicks: "42" } }],
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
      spend: 12.345678,
      currency: "EUR",
      impressions: 1000,
      clicks: 42,
      status: "rejected",
      rejection: "Ad disapproved: DESTINATION_NOT_WORKING, MISLEADING_CONTENT",
      byCreative: {
        "B-4-v1": { spend: 12.345678, impressions: 1000, clicks: 42, status: "rejected" },
        "B-4-v2": { spend: 0, impressions: 0, clicks: 0, status: "rejected" },
      },
    });
    expect(f.done()).toBe(true);
  });

  test("active, in review, paused, removed", async () => {
    const run = async (campaign: object, ads: object[]) => {
      const { p } = platform([tokenCall, searchCall(() => {}, [{ campaign, customer: { currencyCode: "USD" }, metrics: {} }]), searchCall(() => {}, ads)]);
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
      { method: "POST", url: `${API}/googleAds:mutate`, status: 429, json: { error: { code: 429, status: "RESOURCE_EXHAUSTED" } } },
      {
        method: "POST",
        url: `${API}/googleAds:mutate`,
        json: {
          mutateOperationResponses: [
            { campaignBudgetResult: { resourceName: `${C}/campaignBudgets/111` } },
            { campaignResult: { resourceName: `${C}/campaigns/555` } },
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

describe("google setAdActive", () => {
  test("updates the ad group ad status by creative key", async () => {
    const adCall = (status: string): Expect => ({
      method: "POST",
      url: `${API}/adGroupAds:mutate`,
      check: (r) => {
        authed(r);
        expect(r.json).toEqual({ operations: [{ update: { resourceName: `${C}/adGroupAds/777~9002`, status }, updateMask: "status" }] });
      },
      json: { results: [{ resourceName: `${C}/adGroupAds/777~9002` }] },
    });
    const { p, f } = platform([tokenCall, adCall("PAUSED"), adCall("ENABLED")]);
    await p.setAdActive(launched, "B-4-v2", false);
    await p.setAdActive(launched, "B-4-v2", true);
    await expect(p.setAdActive(launched, "nope", true)).rejects.toBeInstanceOf(PlatformError);
    expect(f.done()).toBe(true);
  });
});

describe("google accountInfo", () => {
  const billing = (status: string) => searchCall((q) => expect(q).toBe("SELECT billing_setup.status FROM billing_setup"), [{ billingSetup: { status } }]);
  test("enabled account with approved billing can spend", async () => {
    const { p, f } = platform([tokenCall, currencyCall, billing("APPROVED")]);
    expect(await p.accountInfo()).toEqual({ id: "1234567890", name: "day2 ads", currency: "USD", canSpend: true });
    expect(f.done()).toBe(true);
  });
  test("problems: no billing, manager, suspended, test account", async () => {
    const run = async (over: object, extra: Expect[] = []) => {
      const { p } = platform([tokenCall, searchCall(() => {}, [{ customer: { ...customerRow, ...over } }]), ...extra]);
      return p.accountInfo();
    };
    expect(await run({}, [billing("PENDING")])).toMatchObject({ canSpend: false, problem: expect.stringContaining("billing") });
    expect(await run({ manager: true })).toMatchObject({ canSpend: false, problem: expect.stringContaining("manager") });
    expect(await run({ status: "SUSPENDED" })).toMatchObject({ canSpend: false, problem: expect.stringContaining("SUSPENDED") });
    expect(await run({ testAccount: true })).toMatchObject({ canSpend: false, problem: expect.stringContaining("test account") });
  });
});

describe("google conversions", () => {
  const SIGNUP = `${C}/conversionActions/1`;
  const ACT = `${C}/conversionActions/2`;
  const GOAL = `${C}/customConversionGoals/42`;
  const actionsQuery = (results: unknown[]) =>
    searchCall((q) => {
      expect(q).toContain("FROM conversion_action WHERE conversion_action.name IN ('day2 sign-up', 'day2 activation')");
      expect(q).toContain("conversion_action.status != 'REMOVED'");
    }, results);
  const goalQuery = (results: unknown[]) => searchCall((q) => expect(q).toContain("FROM custom_conversion_goal WHERE custom_conversion_goal.name = 'day2 sign-up goal'"), results);

  test("ensureConversions creates missing UPLOAD_CLICKS actions and the custom sign-up goal", async () => {
    const { p, f } = platform([
      tokenCall,
      actionsQuery([{ conversionAction: { resourceName: ACT, name: "day2 activation", type: "UPLOAD_CLICKS", status: "ENABLED" } }]),
      {
        method: "POST",
        url: `${API}/conversionActions:mutate`,
        check: (r) => {
          authed(r);
          expect(r.json).toEqual({
            operations: [
              {
                create: {
                  name: "day2 sign-up",
                  type: "UPLOAD_CLICKS",
                  category: "SIGNUP",
                  status: "ENABLED",
                  primaryForGoal: true,
                  countingType: "ONE_PER_CLICK",
                  clickThroughLookbackWindowDays: 30,
                  valueSettings: { defaultValue: 1, alwaysUseDefaultValue: true },
                },
              },
            ],
          });
        },
        json: { results: [{ resourceName: SIGNUP }] },
      },
      goalQuery([]),
      {
        method: "POST",
        url: `${API}/customConversionGoals:mutate`,
        check: (r) => expect(r.json).toEqual({ operations: [{ create: { name: "day2 sign-up goal", conversionActions: [SIGNUP], status: "ENABLED" } }] }),
        json: { results: [{ resourceName: GOAL }] },
      },
    ]);
    expect(await p.ensureConversions!()).toEqual({ platform: "google", refs: { customerId: "1234567890", signup: SIGNUP, activated: ACT, goal: GOAL } });
    expect(f.done()).toBe(true);
  });

  test("ensureConversions is idempotent when everything exists", async () => {
    const { p, f } = platform([
      tokenCall,
      actionsQuery([
        { conversionAction: { resourceName: SIGNUP, name: "day2 sign-up", type: "UPLOAD_CLICKS", status: "ENABLED" } },
        { conversionAction: { resourceName: ACT, name: "day2 activation", type: "UPLOAD_CLICKS", status: "ENABLED" } },
      ]),
      goalQuery([{ customConversionGoal: { resourceName: GOAL, conversionActions: [SIGNUP], status: "ENABLED" } }]),
    ]);
    expect((await p.ensureConversions!()).refs).toMatchObject({ signup: SIGNUP, activated: ACT, goal: GOAL });
    expect(f.done()).toBe(true);
  });

  test("ensureConversions refuses a same-named action of another type", async () => {
    const { p } = platform([tokenCall, actionsQuery([{ conversionAction: { resourceName: SIGNUP, name: "day2 sign-up", type: "WEBPAGE", status: "ENABLED" } }])]);
    await expect(p.ensureConversions!()).rejects.toBeInstanceOf(PlatformError);
  });

  const setup = { platform: "google" as const, refs: { customerId: "1234567890", signup: SIGNUP, activated: ACT, goal: GOAL } };
  const ev = (eventId: string, name: "signup" | "activated", param: string, value = `click-${eventId}`) => ({
    eventId,
    name,
    at: "2026-10-28T12:00:00.000Z",
    click: { param, value },
    pageUrl: "https://buddy.example/go/split",
  });

  const DM = "https://datamanager.googleapis.com/v1/events:ingest";
  const dest = (action: string) => ({
    operatingAccount: { accountType: "GOOGLE_ADS", accountId: "1234567890" },
    loginAccount: { accountType: "GOOGLE_ADS", accountId: "9876543210" },
    productDestinationId: action,
  });
  const dmEvent = (id: string, param: string, extra: object = {}) => ({
    transactionId: id,
    eventTimestamp: "2026-10-28T12:00:00.000Z",
    eventSource: "WEB",
    adIdentifiers: { [param]: `click-${id}` },
    ...extra,
  });
  const dmOnlyBearer = (r: Recorded) => {
    expect(r.headers.authorization).toBe("Bearer ya29.access");
    expect(r.headers["developer-token"]).toBeUndefined();
    expect(r.headers["login-customer-id"]).toBeUndefined();
  };
  const dmDenied: Expect = {
    method: "POST",
    url: DM,
    status: 403,
    json: { error: { code: 403, status: "PERMISSION_DENIED", message: "Request had insufficient authentication scopes.", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } },
  };
  const events = () => [ev("e1", "signup", "gclid"), ev("e2", "activated", "gbraid"), ev("e3", "signup", "wbraid"), ev("e4", "signup", "gclid"), ev("e5", "signup", "fbclid")];

  beforeEach(() => resetConversionRouteMemory());

  test("sendConversions goes through the Data Manager API, one request per conversion action, eventId as transactionId", async () => {
    const { p, f } = platform([
      tokenCall,
      {
        method: "POST",
        url: DM,
        check: (r) => {
          dmOnlyBearer(r);
          expect(r.json).toEqual({ destinations: [dest("1")], events: [dmEvent("e1", "gclid"), dmEvent("e3", "wbraid"), dmEvent("e4", "gclid")] });
        },
        json: { requestId: "req-1" },
      },
      { method: "POST", url: DM, check: (r) => expect(r.json).toEqual({ destinations: [dest("2")], events: [dmEvent("e2", "gbraid")] }), json: { requestId: "req-2" } },
    ]);
    const out = await p.sendConversions!(setup, events());
    expect(out).toEqual({ sent: 4, rejected: [{ eventId: "e5", why: "not a Google click id (fbclid)" }] });
    expect(f.done()).toBe(true);
  });

  test("consent is sent only when the event carries it; otherwise omitted (never claimed)", async () => {
    const withConsent = { ...ev("e1", "signup", "gclid"), consent: { adUserData: true, adPersonalization: false } };
    const { p, f } = platform([
      tokenCall,
      {
        method: "POST",
        url: DM,
        check: (r) => {
          const evs = (r.json as any).events;
          expect(evs[0].consent).toEqual({ adUserData: "CONSENT_GRANTED", adPersonalization: "CONSENT_DENIED" });
          expect(evs[1].consent).toBeUndefined();
          expect((r.json as any).consent).toBeUndefined();
        },
        json: { requestId: "req-1" },
      },
    ]);
    await p.sendConversions!(setup, [withConsent, ev("e3", "signup", "gclid")]);
    expect(f.done()).toBe(true);
  });

  test("a Data Manager validation error naming events[N] rejects that event and resends the rest", async () => {
    const { p, f } = platform([
      tokenCall,
      {
        method: "POST",
        url: DM,
        status: 400,
        json: {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "Invalid argument",
            details: [{ "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ field: "events[1].ad_identifiers.wbraid", description: "Malformed wbraid." }] }],
          },
        },
      },
      { method: "POST", url: DM, check: (r) => expect((r.json as any).events.map((e: any) => e.transactionId)).toEqual(["e1", "e4"]), json: { requestId: "req-2" } },
      { method: "POST", url: DM, json: { requestId: "req-3" } },
    ]);
    const out = await p.sendConversions!(setup, events());
    expect(out.sent).toBe(3);
    expect(out.rejected).toEqual([
      { eventId: "e5", why: "not a Google click id (fbclid)" },
      { eventId: "e3", why: "events[1].ad_identifiers.wbraid: Malformed wbraid." },
    ]);
    expect(f.done()).toBe(true);
  });

  test("falls back to uploadClickConversions when Data Manager is not usable (allowlisted project)", async () => {
    const { p, f } = platform([
      tokenCall,
      dmDenied,
      {
        method: "POST",
        url: `https://googleads.googleapis.com/v26/${C}:uploadClickConversions`,
        check: (r) => {
          authed(r);
          expect(r.json).toEqual({
            conversions: [
              { conversionAction: SIGNUP, conversionDateTime: "2026-10-28 12:00:00+00:00", gclid: "click-e1", orderId: "e1" },
              { conversionAction: SIGNUP, conversionDateTime: "2026-10-28 12:00:00+00:00", wbraid: "click-e3", orderId: "e3" },
              { conversionAction: SIGNUP, conversionDateTime: "2026-10-28 12:00:00+00:00", gclid: "click-e4", orderId: "e4" },
            ],
            partialFailure: true,
          });
        },
        json: {
          partialFailureError: {
            code: 3,
            message: "multiple errors",
            details: [
              {
                "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure",
                errors: [
                  { errorCode: { conversionUploadError: "CLICK_NOT_FOUND" }, message: "The click wasn't found.", location: { fieldPathElements: [{ fieldName: "conversions", index: 1 }, { fieldName: "wbraid" }] } },
                  { errorCode: { conversionUploadError: "CLICK_CONVERSION_ALREADY_EXISTS" }, message: "Already exists.", location: { fieldPathElements: [{ fieldName: "conversions", index: 2 }] } },
                ],
              },
            ],
          },
          results: [{ gclid: "click-e1" }, {}, {}],
        },
      },
      {
        method: "POST",
        url: `${C}:uploadClickConversions`,
        check: (r) => expect((r.json as any).conversions).toEqual([{ conversionAction: ACT, conversionDateTime: "2026-10-28 12:00:00+00:00", gbraid: "click-e2", orderId: "e2" }]),
        json: { results: [{ gbraid: "click-e2" }] },
      },
    ]);
    const out = await p.sendConversions!(setup, events());
    expect(out.sent).toBe(3);
    expect(out.rejected).toEqual([
      { eventId: "e5", why: "not a Google click id (fbclid)" },
      { eventId: "e3", why: "CLICK_NOT_FOUND: The click wasn't found." },
    ]);
    expect(f.done()).toBe(true);
  });

  test("not allowlisted for the fallback: clear error, remembered per process (no second legacy call)", async () => {
    const notAllowlisted: Expect = {
      method: "POST",
      url: `${C}:uploadClickConversions`,
      status: 403,
      json: { error: { code: 403, status: "PERMISSION_DENIED", details: [{ errors: [{ errorCode: { authorizationError: "CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE" } }] }] } },
    };
    const { p, f } = platform([tokenCall, dmDenied, notAllowlisted, dmDenied]);
    for (let i = 0; i < 2; i++) {
      const err = (await p.sendConversions!(setup, [ev("e1", "signup", "gclid")]).catch((e) => e)) as PlatformError;
      expect(err).toBeInstanceOf(PlatformError);
      expect(err.message).toContain("Data Manager API");
      expect(err.message).toContain("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    }
    expect(f.done()).toBe(true);
  });

  test("other Data Manager failures are thrown, not silently routed elsewhere", async () => {
    const { p } = platform([tokenCall, { method: "POST", url: DM, status: 400, json: { error: { code: 400, status: "INVALID_ARGUMENT", message: "Destination not found" } } }]);
    const err = (await p.sendConversions!(setup, [ev("e1", "signup", "gclid")]).catch((e) => e)) as PlatformError;
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.message).toContain("Destination not found");
  });
});
