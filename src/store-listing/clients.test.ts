import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { noSleep, scriptedFetch, type Expect, type Recorded } from "../ads/test-helpers";
import { createAppStore } from "../mobile-release/app-store";
import type { AscCredential, PlayCredential } from "../mobile-release/credentials";
import { createAscListing, md5 } from "./asc";
import { createItunes, keywordStat, research, subtitleFromPage } from "./itunes";
import { createPlayListing } from "./play-listing";

const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const asc: AscCredential = { issuerId: "69a6de7e-1111-47e3-e053-5b8c7c11a4d1", keyId: "2X9R4HXF34", privateKey: ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const play: PlayCredential = { clientEmail: "day2@dotty.iam.gserviceaccount.com", privateKey: rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
const NOW = new Date("2026-11-03T10:00:00Z");
const B = "https://api.appstoreconnect.apple.com";
const G = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/de.dotty.app";

const sent = (method: string, url: string, body: unknown, json?: unknown, extra: Partial<Expect> = {}): Expect => ({ method, url, json, check: (r: Recorded) => expect(r.json).toEqual(body), ...extra });
const get = (url: string, json: unknown): Expect => ({ method: "GET", url, json });

function ascClient(script: Expect[], files: Record<string, Uint8Array> = {}) {
  const f = scriptedFetch(script);
  return { c: createAscListing(asc, { fetch: f.fetch, now: () => NOW, sleep: noSleep, readFile: async (p) => files[p]! }), f };
}
const versionsList = (data: unknown[]) => get(`${B}/v1/apps/app1/appStoreVersions?filter[platform]=IOS&limit=10`, { data });
const live = { type: "appStoreVersions", id: "v-live", attributes: { versionString: "1.0.0", appVersionState: "READY_FOR_DISTRIBUTION" } };
const editable = { type: "appStoreVersions", id: "v-next", attributes: { versionString: "1.1.0", appVersionState: "PREPARE_FOR_SUBMISSION" } };

describe("App Store Connect listing", () => {
  test("reads version texts (prepared version first) and name/subtitle from the app info", async () => {
    const { c, f } = ascClient([
      versionsList([live, editable]),
      get(`${B}/v1/appStoreVersions/v-next/appStoreVersionLocalizations?limit=200`, {
        data: [{ type: "appStoreVersionLocalizations", id: "l-de", attributes: { locale: "de-DE", description: "Punkte sammeln.", keywords: "punkte,spiel", promotionalText: "Neu!", whatsNew: null } }],
      }),
      get(`${B}/v1/apps/app1/appInfos`, { data: [{ type: "appInfos", id: "i-live", attributes: { state: "READY_FOR_DISTRIBUTION" } }, { type: "appInfos", id: "i-next", attributes: { state: "PREPARE_FOR_SUBMISSION" } }] }),
      get(`${B}/v1/appInfos/i-next/appInfoLocalizations?limit=200`, { data: [{ type: "appInfoLocalizations", id: "il-de", attributes: { locale: "de-DE", name: "Dotty", subtitle: "Punkte verbinden" } }] }),
    ]);
    const r = await c.readListing("app1");
    expect(r).toEqual({ locales: { "de-DE": { description: "Punkte sammeln.", keywords: "punkte,spiel", promotionalText: "Neu!", name: "Dotty", subtitle: "Punkte verbinden" } }, versionId: "v-next", version: "1.1.0", editable: true });
    expect(f.done()).toBe(true);
  });

  test("promotional text goes on the live version (and the prepared one), creating the localization when missing", async () => {
    const { c, f } = ascClient([
      versionsList([live, editable]),
      get(`${B}/v1/appStoreVersions/v-live/appStoreVersionLocalizations?limit=200`, { data: [{ type: "appStoreVersionLocalizations", id: "l1", attributes: { locale: "de-DE" } }] }),
      sent("PATCH", `${B}/v1/appStoreVersionLocalizations/l1`, { data: { type: "appStoreVersionLocalizations", id: "l1", attributes: { promotionalText: "Jetzt mit Rätseln" } } }, {}),
      get(`${B}/v1/appStoreVersions/v-next/appStoreVersionLocalizations?limit=200`, { data: [] }),
      sent("POST", `${B}/v1/appStoreVersionLocalizations`, { data: { type: "appStoreVersionLocalizations", attributes: { locale: "de-DE" }, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "v-next" } } } } }, { data: { type: "appStoreVersionLocalizations", id: "l2" } }),
      sent("PATCH", `${B}/v1/appStoreVersionLocalizations/l2`, { data: { type: "appStoreVersionLocalizations", id: "l2", attributes: { promotionalText: "Jetzt mit Rätseln" } } }, {}),
    ]);
    await c.setPromotionalText("app1", "de-DE", "Jetzt mit Rätseln");
    expect(f.done()).toBe(true);
  });

  test("version texts on the version, name/subtitle on the app info being prepared", async () => {
    const { c, f } = ascClient([
      get(`${B}/v1/apps/app1/appInfos`, { data: [{ type: "appInfos", id: "i-next", attributes: { appStoreState: "PREPARE_FOR_SUBMISSION" } }] }),
      get(`${B}/v1/appStoreVersions/v-next/appStoreVersionLocalizations?limit=200`, { data: [{ type: "appStoreVersionLocalizations", id: "l-de", attributes: { locale: "de-DE" } }] }),
      sent("PATCH", `${B}/v1/appStoreVersionLocalizations/l-de`, { data: { type: "appStoreVersionLocalizations", id: "l-de", attributes: { keywords: "punkte,rätsel" } } }, {}),
      get(`${B}/v1/appInfos/i-next/appInfoLocalizations?limit=200`, { data: [] }),
      sent("POST", `${B}/v1/appInfoLocalizations`, { data: { type: "appInfoLocalizations", attributes: { locale: "de-DE", subtitle: "Punkte & Rätsel" }, relationships: { appInfo: { data: { type: "appInfos", id: "i-next" } } } } }, { data: { type: "appInfoLocalizations", id: "x" } }),
    ]);
    await c.writeVersionTexts("app1", "v-next", { "de-DE": { keywords: "punkte,rätsel", subtitle: "Punkte & Rätsel" } });
    expect(f.done()).toBe(true);
  });

  test("name/subtitle without a version being prepared: a plain-language refusal", async () => {
    const { c } = ascClient([get(`${B}/v1/apps/app1/appInfos`, { data: [{ type: "appInfos", id: "i-live", attributes: { state: "READY_FOR_DISTRIBUTION" } }] })]);
    await expect(c.writeVersionTexts("app1", "v-next", { "de-DE": { name: "Dotty" } })).rejects.toThrow(/only change while a new version is being prepared/);
  });

  test("screenshots: old ones deleted, each reserved, uploaded in Apple's parts, committed with its MD5", async () => {
    const bytes = new Uint8Array(Array.from({ length: 10 }, (_, i) => i));
    const { c, f } = ascClient(
      [
        get(`${B}/v1/appStoreVersionLocalizations/l-de/appScreenshotSets?filter[screenshotDisplayType]=APP_IPHONE_67&limit=10`, { data: [{ type: "appScreenshotSets", id: "set1", attributes: { screenshotDisplayType: "APP_IPHONE_67" } }] }),
        get(`${B}/v1/appScreenshotSets/set1/appScreenshots?limit=50`, { data: [{ type: "appScreenshots", id: "old1" }] }),
        { method: "DELETE", url: `${B}/v1/appScreenshots/old1`, status: 204 },
        sent("POST", `${B}/v1/appScreenshots`, { data: { type: "appScreenshots", attributes: { fileName: "01-home.png", fileSize: 10 }, relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: "set1" } } } } }, {
          data: {
            type: "appScreenshots",
            id: "s1",
            attributes: {
              uploadOperations: [
                { method: "PUT", url: "https://upload.example/1", offset: 0, length: 6, requestHeaders: [{ name: "Content-Type", value: "image/png" }] },
                { method: "PUT", url: "https://upload.example/2", offset: 6, length: 4, requestHeaders: [] },
              ],
            },
          },
        }),
        { method: "PUT", url: "https://upload.example/1", check: (r) => expect([...(r.body as Uint8Array)]).toEqual([0, 1, 2, 3, 4, 5]) },
        { method: "PUT", url: "https://upload.example/2", check: (r) => expect([...(r.body as Uint8Array)]).toEqual([6, 7, 8, 9]) },
        sent("PATCH", `${B}/v1/appScreenshots/s1`, { data: { type: "appScreenshots", id: "s1", attributes: { uploaded: true, sourceFileChecksum: md5(bytes) } } }, {}),
      ],
      { "/x/01-home.png": bytes },
    );
    expect(await c.replaceScreenshots({ kind: "appStoreVersionLocalizations", id: "l-de" }, "APP_IPHONE_67", ["/x/01-home.png"])).toEqual({ setId: "set1", ids: ["s1"] });
    expect(f.done()).toBe(true);
    expect(md5(bytes)).toBe("c56bd5480f6e5413cb62a0ad9666613a");
  });

  test("a new screenshot set is created on the target's relationship", async () => {
    const { c, f } = ascClient([
      get(`${B}/v1/appCustomProductPageLocalizations/cpl1/appScreenshotSets`, { data: [] }),
      sent("POST", `${B}/v1/appScreenshotSets`, { data: { type: "appScreenshotSets", attributes: { screenshotDisplayType: "APP_IPHONE_65" }, relationships: { appCustomProductPageLocalization: { data: { type: "appCustomProductPageLocalizations", id: "cpl1" } } } } }, { data: { type: "appScreenshotSets", id: "set9" } }),
    ]);
    expect((await c.replaceScreenshots({ kind: "appCustomProductPageLocalizations", id: "cpl1" }, "APP_IPHONE_65", [])).setId).toBe("set9");
    expect(f.done()).toBe(true);
  });

  test("product page optimization: v2 experiment, treatment on appStoreVersionExperimentV2, its localization, started", async () => {
    const { c, f } = ascClient([
      sent("POST", `${B}/v2/appStoreVersionExperiments`, { data: { type: "appStoreVersionExperiments", attributes: { platform: "IOS", name: "Rätsel zuerst", trafficProportion: 50 }, relationships: { app: { data: { type: "apps", id: "app1" } } } } }, { data: { type: "appStoreVersionExperiments", id: "e1" } }),
      sent("POST", `${B}/v1/appStoreVersionExperimentTreatments`, { data: { type: "appStoreVersionExperimentTreatments", attributes: { name: "B" }, relationships: { appStoreVersionExperimentV2: { data: { type: "appStoreVersionExperiments", id: "e1" } } } } }, { data: { type: "appStoreVersionExperimentTreatments", id: "t1" } }),
      sent("POST", `${B}/v1/appStoreVersionExperimentTreatmentLocalizations`, { data: { type: "appStoreVersionExperimentTreatmentLocalizations", attributes: { locale: "de-DE" }, relationships: { appStoreVersionExperimentTreatment: { data: { type: "appStoreVersionExperimentTreatments", id: "t1" } } } } }, { data: { type: "appStoreVersionExperimentTreatmentLocalizations", id: "tl1" } }),
      sent("PATCH", `${B}/v2/appStoreVersionExperiments/e1`, { data: { type: "appStoreVersionExperiments", id: "e1", attributes: { started: true } } }, {}),
      get(`${B}/v2/appStoreVersionExperiments/e1`, { data: { type: "appStoreVersionExperiments", id: "e1", attributes: { state: "IN_REVIEW", reviewRequired: true, startDate: null, endDate: null } } }),
    ]);
    expect(await c.createExperiment({ appId: "app1", name: "Rätsel zuerst", trafficProportion: 50 })).toBe("e1");
    expect(await c.createTreatment({ experimentId: "e1", name: "B", locale: "de-DE" })).toEqual({ treatmentId: "t1", localizationId: "tl1" });
    await c.startExperiment("e1");
    expect(await c.experimentState("e1")).toEqual({ state: "IN_REVIEW", reviewRequired: true, startDate: null, endDate: null });
    expect(f.done()).toBe(true);
  });

  test("custom product page in one request; its address carries the ppid", async () => {
    const { c, f } = ascClient([
      {
        method: "POST",
        url: `${B}/v1/appCustomProductPages`,
        check: (r) => {
          const j = r.json as { data: { relationships: Record<string, unknown> }; included: Array<{ type: string; attributes?: unknown }> };
          expect(j.data.relationships.appStoreVersionTemplate).toEqual({ data: { type: "appStoreVersions", id: "v-live" } });
          expect(j.included.map((i) => i.type)).toEqual(["appCustomProductPageVersions", "appCustomProductPageLocalizations"]);
          expect(j.included[1]!.attributes).toEqual({ locale: "de-DE", promotionalText: "Für Rätselfans" });
        },
        json: {
          data: { type: "appCustomProductPages", id: "cp1", attributes: { url: "https://apps.apple.com/de/app/dotty/id123?ppid=cp1" } },
          included: [
            { type: "appCustomProductPageVersions", id: "cpv1" },
            { type: "appCustomProductPageLocalizations", id: "cpl1" },
          ],
        },
      },
    ]);
    expect(await c.createCustomPage({ appId: "app1", name: "Rätsel", locale: "de-DE", promotionalText: "Für Rätselfans", templateVersionId: "v-live" })).toEqual({ id: "cp1", url: "https://apps.apple.com/de/app/dotty/id123?ppid=cp1", versionId: "cpv1", localizationId: "cpl1" });
    expect(f.done()).toBe(true);
  });

  test("reviews with Apple's responses, newest first, stopping at what day2 already has; replies", async () => {
    const { c, f } = ascClient([
      {
        method: "GET",
        url: `${B}/v1/apps/app1/customerReviews?sort=-createdDate&limit=100&include=response`,
        json: {
          data: [
            { type: "customerReviews", id: "r2", attributes: { rating: 5, title: "Super", body: "Tolle App", reviewerNickname: "anna", createdDate: "2026-11-02T08:00:00Z", territory: "DEU" }, relationships: { response: { data: { type: "customerReviewResponses", id: "resp1" } } } },
            { type: "customerReviews", id: "r1", attributes: { rating: 1, title: "Absturz", body: "Stürzt ab", reviewerNickname: "ben", createdDate: "2026-10-01T08:00:00Z", territory: "DEU" } },
          ],
          included: [{ type: "customerReviewResponses", id: "resp1", attributes: { responseBody: "Danke!" } }],
          links: { next: `${B}/v1/apps/app1/customerReviews?cursor=abc` },
        },
      },
      sent("POST", `${B}/v1/customerReviewResponses`, { data: { type: "customerReviewResponses", attributes: { responseBody: "Danke, Anna!" }, relationships: { review: { data: { type: "customerReviews", id: "r2" } } } } }, { data: { type: "customerReviewResponses", id: "x" } }),
    ]);
    const r = await c.reviews("app1", { since: "2026-10-01T08:00:00Z" });
    expect(r).toEqual([{ id: "r2", rating: 5, title: "Super", body: "Tolle App", author: "anna", territory: "DEU", createdAt: "2026-11-02T08:00:00Z", reply: "Danke!" }]);
    await c.reply("r2", "Danke, Anna!");
    expect(f.done()).toBe(true);
  });

  test("Apple's errors come back in plain words", async () => {
    const { c } = ascClient([{ method: "GET", url: "/v1/apps", status: 403, json: { errors: [{ status: "403", code: "FORBIDDEN_ERROR", detail: "This account has no access to the app." }] } }]);
    await expect(c.appIdFor("de.dotty.app")).rejects.toThrow(/App Store Connect: 403 This account has no access to the app/);
  });
});

describe("release flow hook", () => {
  test("submitForReview runs prepare after the version is ready and before the review submission", async () => {
    const order: string[] = [];
    const f = scriptedFetch([
      { method: "GET", url: "/appStoreVersions?filter[platform]=IOS&filter[appVersionState]", json: { data: [{ type: "appStoreVersions", id: "v9", attributes: { versionString: "1.1.0" } }] } },
      { method: "PATCH", url: "/relationships/build", status: 204 },
      { method: "GET", url: "/appStoreVersionLocalizations", json: { data: [{ type: "appStoreVersionLocalizations", id: "l-de", attributes: { locale: "de-DE" } }] } },
      { method: "PATCH", url: "/appStoreVersionLocalizations/l-de", json: {}, check: () => order.push("whatsNew") },
      { method: "GET", url: "/appStoreVersionPhasedRelease", json: { data: { type: "appStoreVersionPhasedReleases", id: "p1" } } },
      { method: "GET", url: "/v1/reviewSubmissions?", json: { data: [] }, check: () => order.push("submission") },
      { method: "POST", url: "/v1/reviewSubmissions", json: { data: { type: "reviewSubmissions", id: "rs1" } } },
      { method: "POST", url: "/v1/reviewSubmissionItems", json: {} },
      { method: "PATCH", url: "/v1/reviewSubmissions/rs1", json: {} },
    ]);
    const s = createAppStore(asc, { fetch: f.fetch, now: () => NOW, sleep: noSleep });
    await s.submitForReview({ appId: "app1", version: "1.1.0", buildId: "b1", notes: "Neu", phased: true, prepare: async (v) => void order.push(`prepare:${v}`) });
    expect(order).toEqual(["whatsNew", "prepare:v9", "submission"]);
    expect(f.done()).toBe(true);
  });
});

function playClient(script: Expect[], files: Record<string, Uint8Array> = {}) {
  const f = scriptedFetch([{ method: "POST", url: "https://oauth2.googleapis.com/token", json: { access_token: "tok", expires_in: 3600 } }, ...script]);
  return { c: createPlayListing(play, { fetch: f.fetch, now: () => NOW, sleep: noSleep, readFile: async (p) => files[p]! }), f };
}

describe("Google Play listing", () => {
  test("reads listings in a throwaway edit", async () => {
    const { c, f } = playClient([
      { method: "POST", url: `${G}/edits`, json: { id: "e1" } },
      get(`${G}/edits/e1/listings`, { listings: [{ language: "de-DE", title: "Dotty", shortDescription: "Punkte", fullDescription: "Lang" }] }),
      { method: "DELETE", url: `${G}/edits/e1`, status: 204 },
    ]);
    expect(await c.readListings("de.dotty.app")).toEqual({ "de-DE": { title: "Dotty", shortDescription: "Punkte", fullDescription: "Lang" } });
    expect(f.done()).toBe(true);
  });

  test("writes all changes in one edit: merged over the current listing, validated, committed", async () => {
    const { c, f } = playClient([
      { method: "POST", url: `${G}/edits`, json: { id: "e2" } },
      get(`${G}/edits/e2/listings/de-DE`, { language: "de-DE", title: "Dotty", shortDescription: "Alt", fullDescription: "Lang", video: "https://youtu.be/x" }),
      sent("PUT", `${G}/edits/e2/listings/de-DE`, { language: "de-DE", title: "Dotty", shortDescription: "Neu", fullDescription: "Lang", video: "https://youtu.be/x" }, {}),
      { method: "GET", url: `${G}/edits/e2/listings/en-US`, status: 404, json: { error: { message: "Not found" } } },
      sent("PUT", `${G}/edits/e2/listings/en-US`, { language: "en-US", title: "Dotty", shortDescription: "", fullDescription: "" }, {}),
      { method: "POST", url: `${G}/edits/e2:validate`, json: {} },
      { method: "POST", url: `${G}/edits/e2:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`, json: {} },
    ]);
    await c.writeListings("de.dotty.app", { "de-DE": { shortDescription: "Neu" }, "en-US": { title: "Dotty" } });
    expect(f.done()).toBe(true);
  });

  test("a failed commit throws away the edit", async () => {
    const { c, f } = playClient([
      { method: "POST", url: `${G}/edits`, json: { id: "e3" } },
      get(`${G}/edits/e3/listings/de-DE`, {}),
      { method: "PUT", url: `${G}/edits/e3/listings/de-DE`, json: {} },
      { method: "POST", url: `${G}/edits/e3:validate`, status: 400, json: { error: { message: "Short description too long" } } },
      { method: "DELETE", url: `${G}/edits/e3`, status: 204 },
    ]);
    await expect(c.writeListings("de.dotty.app", { "de-DE": { shortDescription: "x" } })).rejects.toThrow(/Short description too long/);
    expect(f.done()).toBe(true);
  });

  test("phone screenshots: delete all, upload each as media, commit", async () => {
    const { c, f } = playClient(
      [
        { method: "POST", url: `${G}/edits`, json: { id: "e4" } },
        { method: "DELETE", url: `${G}/edits/e4/listings/de-DE/phoneScreenshots`, json: {} },
        { method: "POST", url: "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/de.dotty.app/edits/e4/listings/de-DE/phoneScreenshots?uploadType=media", check: (r) => expect(r.headers["content-type"]).toBe("image/png"), json: { image: { id: "i1" } } },
        { method: "POST", url: `${G}/edits/e4:validate`, json: {} },
        { method: "POST", url: `${G}/edits/e4:commit`, json: {} },
      ],
      { "/x/a.png": new Uint8Array([1]) },
    );
    expect(await c.replacePhoneScreenshots("de.dotty.app", "de-DE", ["/x/a.png"])).toBe(1);
    expect(f.done()).toBe(true);
  });

  test("reviews with version and existing reply; replies are capped at 350 characters", async () => {
    const { c, f } = playClient([
      get(`${G}/reviews?maxResults=100`, {
        reviews: [
          { reviewId: "g1", authorName: "Carla", comments: [{ userComment: { text: " Hängt beim Start ", starRating: 2, lastModified: { seconds: "1793700000" }, appVersionName: "1.0.0", reviewerLanguage: "de" } }, { developerComment: { text: "Wir schauen es uns an." } }] },
        ],
      }),
      { method: "POST", url: `${G}/reviews/g1:reply`, check: (r) => expect((r.json as { replyText: string }).replyText.length).toBe(350), json: {} },
    ]);
    expect(await c.reviews("de.dotty.app")).toEqual([{ id: "g1", rating: 2, body: "Hängt beim Start", author: "Carla", language: "de", version: "1.0.0", createdAt: new Date(1793700000 * 1000).toISOString(), reply: "Wir schauen es uns an." }]);
    await c.reply("de.dotty.app", "g1", "x".repeat(400));
    expect(f.done()).toBe(true);
  });
});

describe("iTunes Search API", () => {
  test("search and lookup calls; keyword numbers; competitors with subtitles from their pages", async () => {
    const f = scriptedFetch([
      { method: "GET", url: "https://itunes.apple.com/search?term=punkte+verbinden&country=de&entity=software&limit=50", json: { results: [{ trackId: 9, trackName: "Dots Pro", userRatingCount: 1200, averageUserRating: 4.6, sellerName: "X", trackViewUrl: "https://apps.apple.com/de/app/dots-pro/id9" }, { trackId: 123, trackName: "Dotty", userRatingCount: 3 }] } },
      { method: "GET", url: "https://apps.apple.com/de/app/dots-pro/id9", text: '<h2 class="product-header__subtitle app-header__subtitle">Verbinde &amp; gewinne</h2>' },
    ]);
    const r = await research(createItunes(f.fetch), { terms: ["punkte verbinden"], countries: ["de"], ownId: "123" });
    expect(r.keywords).toEqual([{ term: "punkte verbinden", country: "de", results: 2, rank: 2, topRatings: [1200, 3], topApps: ["Dots Pro", "Dotty"] }]);
    expect(r.competitors).toEqual([{ id: "9", name: "Dots Pro", subtitle: "Verbinde & gewinne", seller: "X", rating: 4.6, ratings: 1200, genre: null, country: "de" }]);
    expect(f.done()).toBe(true);
  });

  test("keywordStat without our app; subtitle parsing tolerates pages without one", () => {
    expect(keywordStat("x", "us", [], null)).toEqual({ term: "x", country: "us", results: 0, rank: null, topRatings: [], topApps: [] });
    expect(subtitleFromPage("<html><h1>App</h1></html>")).toBeNull();
  });
});
