import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { noSleep, scriptedFetch, type Expect, type Recorded } from "../ads/test-helpers";
import type { AscCredential, PlayCredential } from "../mobile-release/credentials";
import { createAscSetup } from "./setup-asc";
import { createPlaySetup } from "./setup-play";
import { createPlayListing } from "./play-listing";
import { md5 } from "./asc";

/**
 * Store setup's App Store Connect and Google Play calls against recorded
 * responses: each request's method, URL and body as Apple's and Google's
 * API references describe them.
 */

const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const asc: AscCredential = { issuerId: "69a6de7e-1111-47e3-e053-5b8c7c11a4d1", keyId: "2X9R4HXF34", privateKey: ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const play: PlayCredential = { clientEmail: "day2@dotty.iam.gserviceaccount.com", privateKey: rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
const NOW = new Date("2026-11-03T10:00:00Z");
const B = "https://api.appstoreconnect.apple.com";
const G = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/de.dotty.app";
const U = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/de.dotty.app";

const sent = (method: string, url: string, body: unknown, json?: unknown, extra: Partial<Expect> = {}): Expect => ({ method, url, json, check: (r: Recorded) => expect(r.json).toEqual(body), ...extra });
const get = (url: string, json: unknown, extra: Partial<Expect> = {}): Expect => ({ method: "GET", url, json, ...extra });

function apple(script: Expect[], files: Record<string, Uint8Array> = {}) {
  const f = scriptedFetch(script);
  return { c: createAscSetup(asc, { fetch: f.fetch, now: () => NOW, sleep: noSleep, readFile: async (p) => files[p]! }), f };
}
function google(script: Expect[], files: Record<string, Uint8Array> = {}) {
  const f = scriptedFetch([{ method: "POST", url: "https://oauth2.googleapis.com/token", json: { access_token: "tok", expires_in: 3600 } }, ...script]);
  return { c: createPlaySetup(play, { fetch: f.fetch, now: () => NOW, sleep: noSleep, readFile: async (p) => files[p]! }), f };
}
const rel = (type: string, id: string) => ({ data: { type, id } });

describe("App Store Connect: app info", () => {
  test("the app info being prepared wins over the live one; categories read and written as appCategories relationships", async () => {
    const { c, f } = apple([
      get(`${B}/v1/apps/app1/appInfos`, { data: [{ type: "appInfos", id: "i-live", attributes: { state: "READY_FOR_DISTRIBUTION" } }, { type: "appInfos", id: "i-next", attributes: { state: "PREPARE_FOR_SUBMISSION" } }] }),
      get(`${B}/v1/appInfos/i-next?include=primaryCategory,secondaryCategory`, { data: { type: "appInfos", id: "i-next", relationships: { primaryCategory: rel("appCategories", "UTILITIES"), secondaryCategory: { data: null } } } }),
      sent("PATCH", `${B}/v1/appInfos/i-next`, { data: { type: "appInfos", id: "i-next", relationships: { primaryCategory: rel("appCategories", "FINANCE"), secondaryCategory: rel("appCategories", "PRODUCTIVITY") } } }, {}),
    ]);
    expect(await c.appInfo("app1")).toEqual({ id: "i-next", editable: true });
    expect(await c.categories("i-next")).toEqual({ primary: "UTILITIES", secondary: null });
    await c.setCategories("i-next", "FINANCE", "PRODUCTIVITY");
    expect(f.done()).toBe(true);
  });

  test("content rights on the app; privacy links on each app info localization", async () => {
    const { c, f } = apple([
      get(`${B}/v1/apps/app1?fields[apps]=contentRightsDeclaration`, { data: { type: "apps", id: "app1", attributes: { contentRightsDeclaration: null } } }),
      sent("PATCH", `${B}/v1/apps/app1`, { data: { type: "apps", id: "app1", attributes: { contentRightsDeclaration: "DOES_NOT_USE_THIRD_PARTY_CONTENT" } } }, {}),
      get(`${B}/v1/appInfos/i1/appInfoLocalizations?limit=200`, { data: [{ type: "appInfoLocalizations", id: "il-de", attributes: { locale: "de-DE", privacyPolicyUrl: null } }] }),
      sent("PATCH", `${B}/v1/appInfoLocalizations/il-de`, { data: { type: "appInfoLocalizations", id: "il-de", attributes: { privacyPolicyUrl: "https://dotty.app/privacy", privacyChoicesUrl: null } } }, {}),
    ]);
    expect(await c.contentRights("app1")).toBeNull();
    await c.setContentRights("app1", "DOES_NOT_USE_THIRD_PARTY_CONTENT");
    expect(await c.infoLocalizations("i1")).toEqual([{ id: "il-de", locale: "de-DE", privacyPolicyUrl: null, privacyChoicesUrl: null }]);
    await c.setInfoLocalization("il-de", { privacyPolicyUrl: "https://dotty.app/privacy", privacyChoicesUrl: null });
    expect(f.done()).toBe(true);
  });

  test("age rating: read through the app info, changed with PATCH on ageRatingDeclarations", async () => {
    const { c, f } = apple([
      get(`${B}/v1/appInfos/i1/ageRatingDeclaration`, { data: { type: "ageRatingDeclarations", id: "ar1", attributes: { violenceCartoonOrFantasy: "NONE", messagingAndChat: null } } }),
      sent("PATCH", `${B}/v1/ageRatingDeclarations/ar1`, { data: { type: "ageRatingDeclarations", id: "ar1", attributes: { messagingAndChat: true, ageRatingOverrideV2: "NONE" } } }, {}),
    ]);
    expect(await c.ageRating("i1")).toEqual({ id: "ar1", attributes: { violenceCartoonOrFantasy: "NONE", messagingAndChat: null } });
    await c.setAgeRating("ar1", { messagingAndChat: true, ageRatingOverrideV2: "NONE" });
    expect(f.done()).toBe(true);
  });
});

describe("App Store Connect: version", () => {
  test("copyright and the build on the version; support and marketing links on its localizations", async () => {
    const { c, f } = apple([
      get(`${B}/v1/appStoreVersions/v1?include=build`, { data: { type: "appStoreVersions", id: "v1", attributes: { copyright: null }, relationships: { build: rel("builds", "b7") } } }),
      sent("PATCH", `${B}/v1/appStoreVersions/v1`, { data: { type: "appStoreVersions", id: "v1", attributes: { copyright: "2026 Dotty GmbH" } } }, {}),
      get(`${B}/v1/appStoreVersions/v1/appStoreVersionLocalizations?limit=200`, { data: [{ type: "appStoreVersionLocalizations", id: "l-de", attributes: { locale: "de-DE", supportUrl: null } }] }),
      sent("PATCH", `${B}/v1/appStoreVersionLocalizations/l-de`, { data: { type: "appStoreVersionLocalizations", id: "l-de", attributes: { supportUrl: "https://dotty.app/help", marketingUrl: null } } }, {}),
    ]);
    expect(await c.version("v1")).toEqual({ copyright: null, buildId: "b7" });
    await c.setCopyright("v1", "2026 Dotty GmbH");
    expect((await c.versionLocalizations("v1"))[0]).toEqual({ id: "l-de", locale: "de-DE", supportUrl: null, marketingUrl: null });
    await c.setVersionLocalization("l-de", { supportUrl: "https://dotty.app/help", marketingUrl: null });
    expect(f.done()).toBe(true);
  });

  test("App Review information: none yet (404) → created on the version; then changed in place", async () => {
    const attrs = { contactFirstName: "Pia", contactLastName: "Lang", contactPhone: "+49 30 123", contactEmail: "pia@dotty.app", notes: "Sign in with the demo account.", demoAccountRequired: true, demoAccountName: "demo@dotty.app", demoAccountPassword: "s3cret" };
    const { c, f } = apple([
      { method: "GET", url: `${B}/v1/appStoreVersions/v1/appStoreReviewDetail`, status: 404, json: { errors: [{ status: "404", code: "NOT_FOUND" }] } },
      sent("POST", `${B}/v1/appStoreReviewDetails`, { data: { type: "appStoreReviewDetails", attributes: attrs, relationships: { appStoreVersion: rel("appStoreVersions", "v1") } } }, { data: { type: "appStoreReviewDetails", id: "rd1" } }),
      sent("PATCH", `${B}/v1/appStoreReviewDetails/rd1`, { data: { type: "appStoreReviewDetails", id: "rd1", attributes: { ...attrs, notes: "Neu" } } }, {}),
    ]);
    expect(await c.reviewDetail("v1")).toBeNull();
    expect(await c.saveReviewDetail("v1", null, attrs)).toBe("rd1");
    await c.saveReviewDetail("v1", "rd1", { ...attrs, notes: "Neu" });
    expect(f.done()).toBe(true);
  });

  test("screenshot display types that have screenshots", async () => {
    const { c, f } = apple([
      get(`${B}/v1/appStoreVersionLocalizations/l-de/appScreenshotSets?include=appScreenshots&limit=50`, {
        data: [
          { type: "appScreenshotSets", id: "s1", attributes: { screenshotDisplayType: "APP_IPHONE_67" }, relationships: { appScreenshots: { data: [{ type: "appScreenshots", id: "x" }] } } },
          { type: "appScreenshotSets", id: "s2", attributes: { screenshotDisplayType: "APP_IPAD_PRO_3GEN_129" }, relationships: { appScreenshots: { data: [] } } },
        ],
      }),
    ]);
    expect(await c.screenshotTypes("l-de")).toEqual(["APP_IPHONE_67"]);
    expect(f.done()).toBe(true);
  });

  test("app preview: set created, preview reserved with its type and poster frame, uploaded in Apple's parts, committed with MD5", async () => {
    const bytes = new Uint8Array(Array.from({ length: 12 }, (_, i) => i));
    const { c, f } = apple(
      [
        get(`${B}/v1/appStoreVersionLocalizations/l-de/appPreviewSets?filter[previewType]=IPHONE_67&limit=10`, { data: [] }),
        sent("POST", `${B}/v1/appPreviewSets`, { data: { type: "appPreviewSets", attributes: { previewType: "IPHONE_67" }, relationships: { appStoreVersionLocalization: rel("appStoreVersionLocalizations", "l-de") } } }, { data: { type: "appPreviewSets", id: "ps1" } }),
        sent(
          "POST",
          `${B}/v1/appPreviews`,
          { data: { type: "appPreviews", attributes: { fileName: "preview-de.mp4", fileSize: 12, mimeType: "video/mp4", previewFrameTimeCode: "00:00:05:00" }, relationships: { appPreviewSet: rel("appPreviewSets", "ps1") } } },
          { data: { type: "appPreviews", id: "p1", attributes: { uploadOperations: [{ method: "PUT", url: "https://upload.apple.test/a", offset: 0, length: 8, requestHeaders: [{ name: "Content-Type", value: "video/mp4" }] }, { method: "PUT", url: "https://upload.apple.test/b", offset: 8, length: 4, requestHeaders: [] }] } } },
        ),
        { method: "PUT", url: "https://upload.apple.test/a", status: 200, check: (r) => expect((r.body as Uint8Array).length).toBe(8) },
        { method: "PUT", url: "https://upload.apple.test/b", status: 200, check: (r) => expect((r.body as Uint8Array).length).toBe(4) },
        sent("PATCH", `${B}/v1/appPreviews/p1`, { data: { type: "appPreviews", id: "p1", attributes: { uploaded: true, sourceFileChecksum: md5(bytes) } } }, {}),
      ],
      { "/x/preview-de.mp4": bytes },
    );
    expect(await c.replacePreview("l-de", "IPHONE_67", "/x/preview-de.mp4")).toBe("p1");
    expect(f.done()).toBe(true);
  });

  test("an existing preview set: old previews deleted first", async () => {
    const { c, f } = apple(
      [
        get(`${B}/v1/appStoreVersionLocalizations/l-de/appPreviewSets?filter[previewType]=IPHONE_65&limit=10`, { data: [{ type: "appPreviewSets", id: "ps2", attributes: { previewType: "IPHONE_65" } }] }),
        get(`${B}/v1/appPreviewSets/ps2/appPreviews?limit=10`, { data: [{ type: "appPreviews", id: "old" }] }),
        { method: "DELETE", url: `${B}/v1/appPreviews/old`, status: 204 },
        { method: "POST", url: `${B}/v1/appPreviews`, json: { data: { type: "appPreviews", id: "p2", attributes: { uploadOperations: [] } } } },
        { method: "PATCH", url: `${B}/v1/appPreviews/p2`, json: {} },
      ],
      { "/x/p.mp4": new Uint8Array([1]) },
    );
    await c.replacePreview("l-de", "IPHONE_65", "/x/p.mp4");
    expect(f.done()).toBe(true);
  });
});

describe("App Store Connect: price and availability", () => {
  test("no price yet → the free price point in the base territory → a price schedule from today", async () => {
    const { c, f } = apple([
      { method: "GET", url: `${B}/v1/apps/app1/appPriceSchedule`, status: 404, json: { errors: [{ status: "404" }] } },
      get(`${B}/v1/apps/app1/appPricePoints?filter[territory]=USA&limit=200`, { data: [{ type: "appPricePoints", id: "pp-free", attributes: { customerPrice: "0.0" } }, { type: "appPricePoints", id: "pp-099", attributes: { customerPrice: "0.99" } }] }),
      sent(
        "POST",
        `${B}/v1/appPriceSchedules`,
        {
          data: { type: "appPriceSchedules", relationships: { app: rel("apps", "app1"), baseTerritory: rel("territories", "USA"), manualPrices: { data: [{ type: "appPrices", id: "${price-0}" }] } } },
          included: [{ type: "appPrices", id: "${price-0}", attributes: { startDate: null }, relationships: { appPricePoint: rel("appPricePoints", "pp-free") } }],
        },
        { data: { type: "appPriceSchedules", id: "app1" } },
      ),
    ]);
    expect(await c.currentPrice("app1", "USA")).toBeNull();
    expect(await c.pricePoint("app1", "USA", "0")).toBe("pp-free");
    await c.setPrice("app1", "USA", "pp-free");
    expect(f.done()).toBe(true);
  });

  test("the current price: the manual price in force today, with its price point's customer price", async () => {
    const { c, f } = apple([
      get(`${B}/v1/apps/app1/appPriceSchedule`, { data: { type: "appPriceSchedules", id: "sch1" } }),
      get(`${B}/v1/appPriceSchedules/sch1/manualPrices?include=appPricePoint&filter[territory]=USA&limit=50`, {
        data: [
          { type: "appPrices", id: "a", attributes: { startDate: null, endDate: "2020-01-01" }, relationships: { appPricePoint: rel("appPricePoints", "old") } },
          { type: "appPrices", id: "b", attributes: { startDate: "2020-01-01", endDate: null }, relationships: { appPricePoint: rel("appPricePoints", "now") } },
        ],
        included: [{ type: "appPricePoints", id: "old", attributes: { customerPrice: "0.99" } }, { type: "appPricePoints", id: "now", attributes: { customerPrice: "2.99" } }],
      }),
    ]);
    expect(await c.currentPrice("app1", "USA")).toBe("2.99");
    expect(f.done()).toBe(true);
  });

  test("a price Apple doesn't offer is refused in plain words", async () => {
    const { c } = apple([get(`${B}/v1/apps/app1/appPricePoints?filter[territory]=USA&limit=200`, { data: [{ type: "appPricePoints", id: "pp", attributes: { customerPrice: "0.99" } }] })]);
    await expect(c.pricePoint("app1", "USA", "1.23")).rejects.toThrow(/no App Store price of 1.23 in USA/);
  });

  test("availability: none yet → v2 appAvailabilities with every territory inline; changes per territory with PATCH", async () => {
    const { c, f } = apple([
      { method: "GET", url: `${B}/v1/apps/app1/appAvailabilityV2`, status: 404, json: { errors: [{ status: "404" }] } },
      get(`${B}/v1/territories?limit=200`, { data: [{ type: "territories", id: "DEU" }, { type: "territories", id: "USA" }] }),
      sent(
        "POST",
        `${B}/v2/appAvailabilities`,
        {
          data: { type: "appAvailabilities", attributes: { availableInNewTerritories: true }, relationships: { app: rel("apps", "app1"), territoryAvailabilities: { data: [{ type: "territoryAvailabilities", id: "${t-DEU}" }, { type: "territoryAvailabilities", id: "${t-USA}" }] } } },
          included: [
            { type: "territoryAvailabilities", id: "${t-DEU}", attributes: { available: true }, relationships: { territory: rel("territories", "DEU") } },
            { type: "territoryAvailabilities", id: "${t-USA}", attributes: { available: true }, relationships: { territory: rel("territories", "USA") } },
          ],
        },
        { data: { type: "appAvailabilities", id: "av1" } },
      ),
      get(`${B}/v1/apps/app1/appAvailabilityV2`, { data: { type: "appAvailabilities", id: "av1" } }),
      get(`${B}/v2/appAvailabilities/av1/territoryAvailabilities?include=territory&limit=200`, { data: [{ type: "territoryAvailabilities", id: "ta-usa", attributes: { available: false }, relationships: { territory: rel("territories", "USA") } }] }),
      sent("PATCH", `${B}/v1/territoryAvailabilities/ta-usa`, { data: { type: "territoryAvailabilities", id: "ta-usa", attributes: { available: true } } }, {}),
    ]);
    expect(await c.availability("app1")).toBeNull();
    await c.createAvailability("app1", await c.territories());
    expect(await c.availability("app1")).toEqual({ id: "av1", territories: [{ id: "ta-usa", territory: "USA", available: false }] });
    await c.setTerritory("ta-usa", true);
    expect(f.done()).toBe(true);
  });
});

describe("Google Play: setup", () => {
  test("app details: read in an edit that's thrown away; changed fields patched in a committed edit", async () => {
    const { c, f } = google([
      sent("POST", `${G}/edits`, {}, { id: "e1" }),
      get(`${G}/edits/e1/details`, { defaultLanguage: "de-DE", contactEmail: "" }),
      { method: "DELETE", url: `${G}/edits/e1`, status: 204 },
      sent("POST", `${G}/edits`, {}, { id: "e2" }),
      sent("PATCH", `${G}/edits/e2/details`, { contactEmail: "hi@dotty.app", contactWebsite: "https://dotty.app" }, {}),
      { method: "POST", url: `${G}/edits/e2:validate`, json: {} },
      { method: "POST", url: `${G}/edits/e2:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`, json: {} },
    ]);
    expect(await c.details("de.dotty.app")).toEqual({ defaultLanguage: "de-DE", contactEmail: "" });
    await c.setDetails("de.dotty.app", { contactEmail: "hi@dotty.app", contactWebsite: "https://dotty.app" });
    expect(f.done()).toBe(true);
  });

  test("hi-res icon and feature graphic: deleteall then upload (media), committed", async () => {
    const { c, f } = google(
      [
        sent("POST", `${G}/edits`, {}, { id: "e3" }),
        { method: "DELETE", url: `${G}/edits/e3/listings/de-DE/featureGraphic`, json: {} },
        { method: "POST", url: `${U}/edits/e3/listings/de-DE/featureGraphic?uploadType=media`, json: { image: { id: "img1" } }, check: (r) => expect(r.headers["content-type"]).toBe("image/jpeg") },
        { method: "POST", url: `${G}/edits/e3:validate`, json: {} },
        { method: "POST", url: `${G}/edits/e3:commit`, json: {} },
      ],
      { "/x/feature.jpg": new Uint8Array([1, 2]) },
    );
    expect(await c.replaceImages("de.dotty.app", "de-DE", "featureGraphic", ["/x/feature.jpg", "/x/second.jpg"])).toBe(1);
    expect(f.done()).toBe(true);
  });

  test("image counts per type (a type Google has no images for counts 0)", async () => {
    const { c, f } = google([
      sent("POST", `${G}/edits`, {}, { id: "e4" }),
      get(`${G}/edits/e4/listings/de-DE/phoneScreenshots`, { images: [{ id: "a" }, { id: "b" }] }),
      get(`${G}/edits/e4/listings/de-DE/tenInchScreenshots`, {}),
      { method: "DELETE", url: `${G}/edits/e4`, status: 204 },
    ]);
    expect(await c.imageCounts("de.dotty.app", "de-DE", ["phoneScreenshots", "tenInchScreenshots"])).toEqual({ phoneScreenshots: 2, tenInchScreenshots: 0 });
    expect(f.done()).toBe(true);
  });

  test("promo video: read from the listings, set with listings.patch per language", async () => {
    const { c, f } = google([
      sent("POST", `${G}/edits`, {}, { id: "e5" }),
      get(`${G}/edits/e5/listings`, { listings: [{ language: "de-DE", title: "Dotty" }, { language: "en-US", video: "https://youtu.be/x" }] }),
      { method: "DELETE", url: `${G}/edits/e5`, status: 204 },
      sent("POST", `${G}/edits`, {}, { id: "e6" }),
      sent("PATCH", `${G}/edits/e6/listings/de-DE`, { language: "de-DE", video: "https://youtu.be/x" }, {}),
      { method: "POST", url: `${G}/edits/e6:validate`, json: {} },
      { method: "POST", url: `${G}/edits/e6:commit`, json: {} },
    ]);
    expect(await c.videos("de.dotty.app")).toEqual({ "de-DE": "", "en-US": "https://youtu.be/x" });
    await c.setVideo("de.dotty.app", ["de-DE"], "https://youtu.be/x");
    expect(f.done()).toBe(true);
  });

  test("release notes per track: the newest release's languages", async () => {
    const { c, f } = google([
      sent("POST", `${G}/edits`, {}, { id: "e7" }),
      get(`${G}/edits/e7/tracks`, { tracks: [{ track: "production", releases: [{ name: "1.0", status: "completed", releaseNotes: [{ language: "de-DE", text: "Neu" }] }] }, { track: "internal", releases: [{ name: "1.1", status: "completed" }] }] }),
      { method: "DELETE", url: `${G}/edits/e7`, status: 204 },
    ]);
    expect(await c.trackNotes("de.dotty.app")).toEqual([
      { track: "production", release: "1.0", languages: ["de-DE"] },
      { track: "internal", release: "1.1", languages: [] },
    ]);
    expect(f.done()).toBe(true);
  });

  test("tablet screenshots go to their own image type", async () => {
    const f = scriptedFetch([
      { method: "POST", url: "https://oauth2.googleapis.com/token", json: { access_token: "tok", expires_in: 3600 } },
      sent("POST", `${G}/edits`, {}, { id: "e8" }),
      { method: "DELETE", url: `${G}/edits/e8/listings/de-DE/sevenInchScreenshots`, json: {} },
      { method: "POST", url: `${U}/edits/e8/listings/de-DE/sevenInchScreenshots?uploadType=media`, json: {} },
      { method: "POST", url: `${G}/edits/e8:validate`, json: {} },
      { method: "POST", url: `${G}/edits/e8:commit`, json: {} },
    ]);
    const c = createPlayListing(play, { fetch: f.fetch, now: () => NOW, sleep: noSleep, readFile: async () => new Uint8Array([1]) });
    expect(await c.replacePhoneScreenshots("de.dotty.app", "de-DE", ["/x/1.png"], "sevenInchScreenshots")).toBe(1);
    expect(f.done()).toBe(true);
  });
});
