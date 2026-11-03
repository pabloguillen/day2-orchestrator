import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyBacklog, ingest, type IncomingItem, type Ticket } from "../backlog";
import type { AppProfile } from "../onboarding";
import type { AscListingClient } from "./asc";
import type { Itunes } from "./itunes";
import { addProposals, appLocales, checkField, countryFor, decideProposal, measure, normalizeKeywords } from "./listing";
import { addCustomPage, addTest, customPageFor, mapExperimentState, playExperimentWalkthrough, recordResult, startAppleTest } from "./page-tests";
import { researchDue, storePass, type StorePassDeps } from "./pass";
import type { PlayListingClient } from "./play-listing";
import { parseTerms, parseWrite } from "./research";
import { mergeReviews, parseReplies, parseReviewPrompt, parseTriage, problemItem, problemKey, ratingTrend, versionAt } from "./reviews";
import { captureRaw, frameAll, frameHtml, frameStyle, parseCaptions } from "./screenshots";
import { applyApproved, customPageUrl, prepareVersion, reviewsPass, runResearch, type StoreDeps } from "./service";
import { fileStoreListing, normalize, STORE_FILENAME } from "./store";
import { emptyStoreFile, type StoreFile, type StoreReview } from "./types";

const NOW = new Date("2026-11-03T10:00:00Z");
const profile: AppProfile = {
  purpose: "Ein Punkte-Rätsel für zwischendurch",
  targetUsers: "Erwachsene, die kurze Denkspiele mögen",
  featureMap: ["Tägliche Rätsel", "Levels", "Bestenliste"],
  styleGuide: null,
  toneOfVoice: "freundlich, knapp",
  businessModel: null,
  caveats: [],
  competitors: null,
  currentState: null,
  currentStateCaveat: "",
  scannedAt: NOW.toISOString(),
};
const withListing = (): StoreFile => ({
  ...emptyStoreFile(),
  settings: { ...emptyStoreFile().settings, locales: ["de-DE", "en-US"] },
  listings: { ios: { "de-DE": { name: "Dotty", subtitle: "Punkte verbinden", keywords: "punkte,rätsel" } }, android: { "de-DE": { title: "Dotty", shortDescription: "Punkte verbinden" } }, readAt: NOW.toISOString(), errors: {} },
});

describe("listing rules", () => {
  test("Apple keywords count bytes (umlauts are two), everything else characters", () => {
    expect(measure("keywords", "rätsel")).toBe(7);
    expect(measure("subtitle", "rätsel")).toBe(6);
    expect(checkField("keywords", `${"ä".repeat(50)},x`)).toMatch(/102 bytes — the limit is 100/);
    expect(checkField("subtitle", "x".repeat(31))).toMatch(/31 characters — the limit is 30/);
    expect(checkField("name", "Dotty – #1 Puzzle")).toMatch(/rankings/);
    expect(checkField("keywords", "dotty,punkte", { appName: "Dotty" })).toMatch(/already searched/);
    expect(checkField("keywords", "a, b")).toMatch(/without spaces/);
    expect(checkField("promotionalText", "")).toBeNull();
  });

  test("keywords normalized: trimmed, no duplicates, no empty items", () => {
    expect(normalizeKeywords(" Punkte , rätsel,,punkte, Logik ")).toBe("Punkte,rätsel,Logik");
  });

  test("proposals: before/after with counts, how they go out; too long ones dropped; a newer one replaces one waiting", () => {
    const f = withListing();
    const r = addProposals(
      f,
      [
        { store: "ios", locale: "de-DE", field: "subtitle", text: "Tägliche Punkte-Rätsel", reason: "targets 'rätsel'" },
        { store: "ios", locale: "de-DE", field: "promotionalText", text: "Jeden Tag ein neues Rätsel.", reason: "fresh" },
        { store: "android", locale: "de-DE", field: "shortDescription", text: "x".repeat(81), reason: "too long" },
        { store: "ios", locale: "de-DE", field: "name", text: "Dotty", reason: "same" },
      ],
      { now: NOW, researchId: "SR-1", auto: false },
    );
    expect(r.added.map((p) => [p.id, p.field, p.applyHow, p.status, p.chars])).toEqual([
      ["SP-1", "subtitle", "next_version", "pending", { before: 16, after: 22, limit: 30 }],
      ["SP-2", "promotionalText", "now", "pending", { before: 0, after: 27, limit: 170 }],
    ]);
    expect(r.dropped).toEqual([{ what: "android de-DE Short description", why: "81 characters — the limit is 80" }]);
    const again = addProposals(r.file, [{ store: "ios", locale: "de-DE", field: "subtitle", text: "Rätsel mit Punkten", reason: "better" }], { now: NOW, researchId: null, auto: true });
    expect(again.file.proposals.map((p) => [p.id, p.status])).toEqual([
      ["SP-2", "pending"],
      ["SP-3", "approved"],
    ]);
  });

  test("approving with an edit checks the edit; rejecting; deciding twice is refused", () => {
    const f = addProposals(withListing(), [{ store: "ios", locale: "de-DE", field: "keywords", text: "punkte,logik", reason: "r" }], { now: NOW, researchId: null, auto: false }).file;
    expect(() => decideProposal(f, "SP-1", { approve: true, text: "x".repeat(101), by: "Pablo", now: NOW })).toThrow(/Keywords: 101 bytes/);
    const ok = decideProposal(f, "SP-1", { approve: true, text: "punkte, logik,  denken", by: "Pablo", now: NOW });
    expect(ok.proposals[0]).toMatchObject({ status: "approved", after: "punkte,logik,denken", decidedBy: "Pablo", chars: { after: 19 } });
    expect(() => decideProposal(ok, "SP-1", { approve: false, by: null, now: NOW })).toThrow(/already approved/);
  });

  test("the app's languages from app.json locales and i18n folders; countries for search", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-locales-"));
    writeFileSync(join(dir, "app.json"), JSON.stringify({ expo: { locales: { de: "./de.json" } } }));
    mkdirSync(join(dir, "src", "locales"), { recursive: true });
    writeFileSync(join(dir, "src", "locales", "fr.json"), "{}");
    expect(appLocales(dir)).toEqual(["de-DE", "fr-FR", "en-US"]);
    expect([countryFor("de-DE"), countryFor("en-US"), countryFor("ja")]).toEqual(["de", "us", "jp"]);
  });
});

describe("agent answers", () => {
  test("listing suggestions: only connected stores, set locales and real fields; What's New is left to releases", () => {
    const text = `thinking…\nSTORE_LISTING_JSON:\n${JSON.stringify({
      summary: "Rätsel betonen",
      suggestions: [
        { store: "ios", locale: "de-DE", field: "subtitle", text: "Tägliche Rätsel", reason: "r1" },
        { store: "ios", locale: "fr-FR", field: "subtitle", text: "x", reason: "wrong locale" },
        { store: "android", locale: "de-DE", field: "keywords", text: "x", reason: "not a Play field" },
        { store: "ios", locale: "de-DE", field: "whatsNew", text: "x", reason: "release owns it" },
        { store: "web", locale: "de-DE", field: "title", text: "x" },
      ],
    })}`;
    expect(parseWrite(text, { locales: ["de-DE"], stores: ["ios", "android"] })).toEqual({ summary: "Rätsel betonen", suggestions: [{ store: "ios", locale: "de-DE", field: "subtitle", text: "Tägliche Rätsel", reason: "r1" }] });
    expect(parseWrite("no marker", { locales: ["de-DE"], stores: ["ios"] })).toBeNull();
  });

  test("terms per locale, lower-cased and deduplicated", () => {
    expect(parseTerms(`STORE_TERMS_JSON: {"terms":{"de-DE":["Rätsel","rätsel","Punkte"],"xx":["a"]}}`, ["de-DE", "en-US"])).toEqual({ "de-DE": ["rätsel", "punkte"], "en-US": [] });
  });

  test("replies within each store's limit, for reviews that exist only", () => {
    const rs = [review({ id: "a", store: "android" }), review({ id: "b" })];
    const m = parseReplies(`STORE_REPLIES_JSON: {"replies":[{"id":"a","text":"${"x".repeat(400)}"},{"id":"b","text":"Danke!"},{"id":"zz","text":"?"}]}`, rs);
    expect([m.get("a")!.length, m.get("b"), m.has("zz")]).toEqual([350, "Danke!", false]);
  });

  test("triage keeps existing keys only when they exist", () => {
    const rs = [review({ id: "a", rating: 1 })];
    expect(parseTriage(`STORE_TRIAGE_JSON: {"problems":[{"key":"store:review:nope","title":"Crash on start","description":"d","reviewIds":["a","ghost"]}]}`, rs, ["store:review:abc"])).toEqual([{ key: null, title: "Crash on start", description: "d", reviewIds: ["a"] }]);
  });

  test("captions per locale and screen, capped", () => {
    expect(parseCaptions(`STORE_CAPTIONS_JSON: {"captions":{"de-DE":{"01-home":"Jeden Tag ein Rätsel","02-x":"${"y".repeat(60)}"}}}`, ["de-DE", "en-US"], ["01-home", "02-x"])).toEqual({ "de-DE": { "01-home": "Jeden Tag ein Rätsel", "02-x": "y".repeat(40) }, "en-US": {} });
  });
});

function review(o: Partial<StoreReview> = {}): StoreReview {
  return { store: "ios", id: "r1", rating: 5, title: "", body: "Schön", author: "anna", territory: "DEU", language: null, version: "1.0.0", createdAt: "2026-11-01T00:00:00Z", existingReply: null, reply: null, problemKey: null, ticketId: null, triaged: false, ...o };
}

describe("reviews", () => {
  test("merge keeps day2's state and the newest first; versions from the release timeline", () => {
    const old = review({ id: "r1", reply: { text: "Danke", state: "draft", by: "day2", at: "x", sentAt: null, error: null } });
    const { reviews, added } = mergeReviews([old], [review({ id: "r1", body: "Schön!!" }), review({ id: "r2", createdAt: "2026-11-02T00:00:00Z" })]);
    expect(added.map((r) => r.id)).toEqual(["r2"]);
    expect(reviews.map((r) => [r.id, r.body, r.reply?.state ?? null])).toEqual([
      ["r2", "Schön", null],
      ["r1", "Schön!!", "draft"],
    ]);
    expect(versionAt([{ version: "1.0.0", from: "2026-10-01T00:00:00Z" }, { version: "1.1.0", from: "2026-11-01T00:00:00Z" }], "2026-10-15T00:00:00Z")).toBe("1.0.0");
    expect(versionAt([], "2026-10-15T00:00:00Z")).toBeNull();
  });

  test("a problem's ticket quotes the reviews without names and counts them as its signal", () => {
    const rs = [review({ id: "a", rating: 1, body: "Stürzt beim Start ab", author: "Max Mustermann" }), review({ id: "b", rating: 2, store: "android", version: "1.0.1", body: "Crash", problemKey: "store:review:k" })];
    const item = problemItem({ key: "store:review:k", title: "Crash on start", description: "Users say it crashes.", reviewIds: ["a"] }, rs, "store:review:k");
    expect(item.signals).toEqual({ users: 2, usageNote: "2 store reviews with 1–2 stars describe this (App Store 1.0.0, Google Play 1.0.1)." });
    expect(item.description).toContain('> 1★ App Store 1.0.0: "Stürzt beim Start ab"');
    expect(item.description).not.toContain("Mustermann");
    expect(problemKey("Crash on start!")).toBe(problemKey("crash on start"));
  });

  test("rating per version, newest version first", () => {
    const t = ratingTrend([review({ id: "1", rating: 5, version: "1.0.0" }), review({ id: "2", rating: 1, version: "1.0.0" }), review({ id: "3", rating: 4, version: "1.10.0" }), review({ id: "4", rating: 3, version: null })]);
    expect(t).toEqual([
      { store: "ios", version: "1.10.0", reviews: 1, average: 4, low: 0 },
      { store: "ios", version: "1.0.0", reviews: 2, average: 3, low: 1 },
    ]);
  });

  test("rating prompt settings: checked, unknown events dropped, Apple's yearly cap respected", () => {
    expect(parseReviewPrompt({ afterEvents: { level_done: 3, "Bad Key": 1 }, minDaysBetween: 5, minDaysSinceInstall: 2, notAfterProblem: false })).toEqual({ afterEvents: { level_done: 3 }, minDaysSinceInstall: 2, minDaysBetween: 120, notAfterProblem: false });
  });
});

describe("tests and custom pages", () => {
  test("Apple tests need screenshots per variant; traffic between 10 and 100%", () => {
    const f = emptyStoreFile();
    expect(() => addTest(f, { kind: "apple_ppo", name: "A", hypothesis: "", locale: "de-DE", trafficPercent: 50, treatments: [{ name: "B", screenshotSetId: null, note: "" }] }, { now: NOW, auto: false })).toThrow(/needs its screenshots/);
    expect(() => addTest(f, { kind: "play_experiment", name: "A", hypothesis: "", locale: "de-DE", trafficPercent: 5, treatments: [{ name: "B", screenshotSetId: null, note: "" }] }, { now: NOW, auto: false })).toThrow(/between 10% and 100%/);
    const { test: t } = addTest(f, { kind: "apple_ppo", name: "Rätsel zuerst", hypothesis: "h", locale: "de-DE", trafficPercent: 50, treatments: [{ name: "B", screenshotSetId: "SS-1", note: "" }] }, { now: NOW, auto: false });
    expect([t.id, t.status]).toEqual(["ST-1", "waiting_approval"]);
  });

  test("starting an Apple test: experiment, treatment, its screenshots, started", async () => {
    const calls: string[] = [];
    const asc = {
      createExperiment: async () => (calls.push("experiment"), "e1"),
      createTreatment: async (o: { name: string }) => (calls.push(`treatment:${o.name}`), { treatmentId: "t1", localizationId: "tl1" }),
      replaceScreenshots: async (target: { id: string }, type: string, files: string[]) => (calls.push(`shots:${target.id}:${type}:${files.length}`), { setId: "s", ids: [] }),
      startExperiment: async () => void calls.push("start"),
    } as unknown as AscListingClient;
    const t = addTest(emptyStoreFile(), { kind: "apple_ppo", name: "X", hypothesis: "", locale: "de-DE", trafficPercent: 30, treatments: [{ name: "B", screenshotSetId: "SS-1", note: "" }] }, { now: NOW, auto: true }).test;
    const out = await startAppleTest(asc, "app1", t, () => [{ displayType: "APP_IPHONE_67", files: ["a", "b"] }]);
    expect(calls).toEqual(["experiment", "treatment:B", "shots:tl1:APP_IPHONE_67:2", "start"]);
    expect([out.status, out.ascId, out.treatments[0]!.ascId]).toEqual(["submitted", "e1", "t1"]);
    expect(mapExperimentState("RUNNING")).toBe("running");
  });

  test("results entered by the owner; Play walkthrough names the variants", () => {
    const { file, test: t } = addTest(emptyStoreFile(), { kind: "play_experiment", name: "Kurzbeschreibung", hypothesis: "", locale: "de-DE", trafficPercent: 50, treatments: [{ name: "Rätsel", screenshotSetId: null, note: "Kurzbeschreibung: Tägliche Rätsel" }] }, { now: NOW, auto: false });
    expect(t.status).toBe("draft");
    const steps = playExperimentWalkthrough(t, { appName: "Dotty" });
    expect(steps.map((s) => s.title)).toEqual(["Open store listing experiments", "Name and audience", "Goals", "Variant 1: Rätsel", "Start it"]);
    expect(() => recordResult(file, t.id, { winner: "nobody", note: "", by: null, now: NOW })).toThrow(/current, Rätsel/);
    expect(recordResult(file, t.id, { winner: "Rätsel", note: "+8% installs", by: "Pablo", now: NOW }).tests[0]).toMatchObject({ status: "finished", result: { winner: "Rätsel", by: "Pablo" } });
  });

  test("an ad's tag finds its live custom product page by campaign", async () => {
    let f = addCustomPage(emptyStoreFile(), { name: "Rätsel", purpose: "B-4 ads", locale: "de-DE", promotionalText: "Für Rätselfans", screenshotSetId: null, campaigns: ["B-4", "bad id!"] }, { now: NOW, auto: false }).file;
    expect(f.customPages[0]!.campaigns).toEqual(["B-4"]);
    expect(customPageFor(f.customPages, "B-4.tiktok.v1")).toBeNull(); // not live yet
    f = { ...f, customPages: [{ ...f.customPages[0]!, status: "live", ppid: "cp1" }] };
    expect(customPageFor(f.customPages, "B-4.tiktok.v1")?.ppid).toBe("cp1");
    expect(customPageFor(f.customPages, "B-5.meta.v1")).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "day2-store-"));
    const store = fileStoreListing(() => dir);
    await store.update("a1", () => ({ file: f, result: null }));
    expect(await customPageUrl(store, "a1", "B-4")).toBe("cp1");
  });
});

describe("screenshots", () => {
  test("framed page has the exact store size, the caption escaped, brand colors", () => {
    const style = frameStyle({ visual: { palette: [{ hex: "#FFD84D", role: "primary" }, { hex: "#1B1B3A", role: "ink" }], typography: "Nunito, rounded", imagery: null, designLanguage: null } } as never);
    expect(style).toEqual({ background: "#FFD84D", accent: "#1B1B3A", font: '"Nunito", -apple-system, "Helvetica Neue", Arial, sans-serif' });
    const html = frameHtml({ width: 1320, height: 2868 }, "Rätsel <jeden> Tag", style, "data:image/png;base64,AA==");
    expect(html).toContain("width:1320px;height:2868px");
    expect(html).toContain("Rätsel &lt;jeden&gt; Tag");
    expect(html).toContain("color:#111111"); // dark text on yellow
  });

  test("capture builds once per platform and runs the flow per locale with its variables; frames every size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-shots-"));
    const runs: Array<Record<string, string>> = [];
    const target = {
      platform: "ios",
      device: "iPhone 16 Pro Max",
      id: "SIM1",
      build: async () => ({ app: "/x/Dotty.app" }),
      install: async () => {},
      uninstall: async () => {},
    };
    const r = await captureRaw(
      { cwd: dir, appId: "a1", bundleId: "de.dotty.app", packageName: "de.dotty.android", locales: ["de-DE", "en-US"], outDir: dir },
      {
        target: async (p) => (p === "ios" ? (target as never) : { skip: "Android Studio's emulator isn't installed" }),
        runFlow: async (o) => {
          runs.push(o.env);
          mkdirSync(o.outDir, { recursive: true });
          writeFileSync(join(o.outDir, "01-home.png"), new Uint8Array([137, 80, 78, 71]));
          return { ok: true, why: null };
        },
      },
    );
    expect(runs).toEqual([
      { APP_ID: "de.dotty.app", DAY2_LOCALE: "de-DE", DAY2_LOCALE_LANG: "de" },
      { APP_ID: "de.dotty.app", DAY2_LOCALE: "en-US", DAY2_LOCALE_LANG: "en" },
    ]);
    expect(Object.keys(r.shots.ios ?? {})).toEqual(["de-DE", "en-US"]);
    expect(r.notes).toEqual(["Android: Android Studio's emulator isn't installed"]);
    const rendered: string[] = [];
    const shots = await frameAll({
      shots: [{ name: "01-home", caption: "Jeden Tag", raw: r.shots.ios!["de-DE"]![0]! }],
      sizes: [
        { id: "iphone-6.9", store: "ios", label: "", width: 1320, height: 2868, displayType: "APP_IPHONE_67" },
        { id: "iphone-6.5", store: "ios", label: "", width: 1284, height: 2778, displayType: "APP_IPHONE_65" },
      ],
      style: frameStyle(null),
      outDir: join(dir, "out"),
      render: async (_html, size, out) => (rendered.push(`${size.width}x${size.height}`), out),
    });
    expect(rendered).toEqual(["1320x2868", "1284x2778"]);
    expect(shots[0]!.framed).toEqual({ "iphone-6.9": "01-home-iphone-6.9.png", "iphone-6.5": "01-home-iphone-6.5.png" });
  });
});

// ---------------------------------------------------------------------------
// The steps with fake stores and agents
// ---------------------------------------------------------------------------

function fakeDeps(over: Partial<StorePassDeps> = {}, seed?: StoreFile) {
  const dir = mkdtempSync(join(tmpdir(), "day2-store-"));
  const store = fileStoreListing(() => dir);
  const calls: string[] = [];
  let backlog = emptyBacklog();
  const asc = {
    appIdFor: async () => "app1",
    readListing: async () => ({ locales: { "de-DE": { name: "Dotty", subtitle: "Punkte verbinden", keywords: "punkte" } }, versionId: "v1", version: "1.0.0", editable: false }),
    setPromotionalText: async (_a: string, l: string, t: string) => void calls.push(`promo:${l}:${t}`),
    versions: async () => ({ live: { id: "v1", version: "1.0.0" }, editable: null }),
    writeVersionTexts: async (_a: string, v: string, by: Record<string, unknown>) => void calls.push(`version:${v}:${JSON.stringify(by)}`),
    versionLocalizationId: async () => "loc1",
    replaceScreenshots: async (_t: unknown, type: string, files: string[]) => (calls.push(`shots:${type}:${files.length}`), { setId: "s", ids: [] }),
    reviews: async () => [
      { id: "a1", rating: 5, title: "Toll", body: "Macht Spaß", author: "anna", territory: "DEU", createdAt: "2026-11-02T00:00:00Z", reply: null },
      { id: "a2", rating: 1, title: "Absturz", body: "Stürzt nach Level 3 ab", author: "ben", territory: "DEU", createdAt: "2026-11-01T00:00:00Z", reply: null },
    ],
    reply: async (id: string, t: string) => void calls.push(`reply:ios:${id}:${t}`),
  } as unknown as AscListingClient;
  const play = {
    readListings: async () => ({ "de-DE": { title: "Dotty", shortDescription: "Punkte", fullDescription: "" } }),
    writeListings: async (_p: string, by: Record<string, unknown>) => void calls.push(`play:${JSON.stringify(by)}`),
    replacePhoneScreenshots: async () => 1,
    reviews: async () => [{ id: "g1", rating: 2, body: "Crasht nach Level 3", author: "carla", language: "de", version: "1.0.0", createdAt: "2026-11-02T05:00:00Z", reply: null }],
    reply: async (_p: string, id: string, t: string) => void calls.push(`reply:android:${id}:${t}`),
  } as unknown as PlayListingClient;
  const itunes: Itunes = {
    search: async (term) => [{ trackId: 9, trackName: `Top ${term}`, userRatingCount: 500 }],
    lookup: async () => null,
    lookupBundle: async () => ({ trackId: 123, averageUserRating: 4.5, userRatingCount: 12, version: "1.0.0" }),
    subtitle: async () => null,
  };
  const d: StorePassDeps = {
    now: NOW,
    appId: "a1",
    appName: "Dotty",
    store,
    asc,
    play,
    itunes,
    ids: { bundleId: "de.dotty.app", packageName: "de.dotty.app", appStoreId: "123" },
    profile,
    agents: {
      terms: async (i) => (calls.push(`terms:${i.locales.join(",")}`), Object.fromEntries(i.locales.map((l) => [l, ["punkte rätsel"]]))),
      write: async (i) => (calls.push(`write:${i.keywords.length}:${i.competitors.length}`), { summary: "s", suggestions: [{ store: "ios", locale: "de-DE", field: "subtitle", text: "Tägliche Punkte-Rätsel", reason: "r" }] }),
      replies: async (_n, _p, rs) => new Map(rs.map((r) => [r.id, `Danke ${r.id}`])),
      triage: async (_n, rs, existing) => (calls.push(`triage:${rs.map((r) => r.id).join(",")}:${existing.length}`), [{ key: existing[0]?.key ?? null, title: "Crash after level 3", description: "d", reviewIds: rs.map((r) => r.id) }]),
    },
    paid: async (_s, label, _m, fn) => (calls.push(`paid:${label}`), { result: await fn(), credits: 2 }),
    ticket: async () => ({ id: "EXP-9", state: "todo", created: true }),
    ingest: async (items: IncomingItem[]) => {
      backlog = ingest(backlog, items, NOW).backlog;
    },
    tickets: async () => backlog.tickets as Ticket[],
    timeline: async () => [{ version: "1.0.0", from: "2026-10-20T00:00:00Z" }],
    screenshotFiles: () => ["/x/a.png"],
    log: () => {},
    shippedVersion: async () => "1.0.0",
    ...over,
  };
  if (seed) writeFileSync(join(dir, STORE_FILENAME), JSON.stringify(seed));
  return { d, calls, store, backlog: () => backlog };
}

describe("applying changes", () => {
  test("promotional text now, other App Store texts staged, Google Play in one edit", async () => {
    const seed = addProposals(
      withListing(),
      [
        { store: "ios", locale: "de-DE", field: "promotionalText", text: "Neu: Rätsel", reason: "" },
        { store: "ios", locale: "de-DE", field: "subtitle", text: "Tägliche Rätsel", reason: "" },
        { store: "android", locale: "de-DE", field: "shortDescription", text: "Tägliche Punkte-Rätsel", reason: "" },
        { store: "android", locale: "en-US", field: "title", text: "Dotty: Dot Puzzle", reason: "" },
      ],
      { now: NOW, researchId: null, auto: true },
    ).file;
    const { d, calls, store } = fakeDeps({}, seed);
    const r = await applyApproved(d);
    expect(r).toEqual({ applied: ["SP-1", "SP-3", "SP-4"], staged: ["SP-2"], failed: [] });
    expect(calls).toEqual(["promo:de-DE:Neu: Rätsel", `play:${JSON.stringify({ "de-DE": { shortDescription: "Tägliche Punkte-Rätsel" }, "en-US": { title: "Dotty: Dot Puzzle" } })}`]);
    // The next App Store version day2 prepares takes the staged ones (and approved screenshots).
    await store.update("a1", (f) => {
      f.screenshots.push({ id: "SS-1", at: "", locale: "de-DE", status: "approved", shots: [], sizes: ["iphone-6.9", "android-phone"], uploaded: {}, error: null });
      return { file: f, result: null };
    });
    const done = await prepareVersion(d, d.asc!, "app1", "v2", "1.1.0");
    expect(done).toEqual(["SP-2", "SS-1"]);
    expect(calls.slice(2)).toEqual([`version:v2:${JSON.stringify({ "de-DE": { subtitle: "Tägliche Rätsel" } })}`, "shots:APP_IPHONE_67:1"]);
    const f = await store.load("a1");
    expect(f.proposals.find((p) => p.id === "SP-2")).toMatchObject({ status: "applied", appliedTo: "1.1.0" });
    expect(f.screenshots[0]).toMatchObject({ status: "approved", uploaded: { ios: "1.1.0" } });
  });

  test("a store refusing a change keeps it approved with the reason (tried again next pass)", async () => {
    const seed = addProposals(withListing(), [{ store: "android", locale: "de-DE", field: "title", text: "Dotty Rätsel", reason: "" }], { now: NOW, researchId: null, auto: true }).file;
    const { d, store } = fakeDeps({ play: { writeListings: async () => Promise.reject(new Error("Google Play: 403 The caller does not have permission")) } as unknown as PlayListingClient }, seed);
    expect((await applyApproved(d)).failed).toEqual(["SP-1"]);
    expect((await store.load("a1")).proposals[0]).toMatchObject({ status: "approved", error: "403 The caller does not have permission" });
  });
});

describe("research", () => {
  test("terms → App Store search per locale → texts; proposals wait for the owner by default", async () => {
    const { d, calls, store } = fakeDeps({}, withListing());
    const r = await runResearch(d, "owner", "1.0.0");
    expect(r.run?.proposals).toEqual(["SP-1"]);
    expect(calls).toEqual(["paid:Store search terms", "terms:de-DE,en-US", "paid:Store listing texts", "write:2:1"]);
    const f = await store.load("a1");
    expect(f.proposals[0]).toMatchObject({ status: "pending", before: "Punkte verbinden", after: "Tägliche Punkte-Rätsel" });
    expect(f.research[0]).toMatchObject({ why: "owner", version: "1.0.0", credits: 4, keywords: [{ term: "punkte rätsel", country: "de" }, { term: "punkte rätsel", country: "us" }] });
    expect(f.log.at(-1)!.text).toMatch(/1 listing change waiting for your approval/);
  });

  test("without an app scan there's nothing to ground it in", async () => {
    const { d } = fakeDeps({ profile: null });
    expect(await runResearch(d, "schedule", null)).toEqual({ run: null, skipped: "day2 needs the app scan (App profile) before researching the store listing." });
  });

  test("due: never ran, every 30 days, or a new version in the store", () => {
    const f = emptyStoreFile();
    expect(researchDue(f, NOW, null)).toBe("schedule");
    const ran = { ...f, researchedVersion: "1.0.0", research: [{ id: "x", at: "2026-10-20T00:00:00Z", why: "schedule" as const, version: "1.0.0", locales: [], keywords: [], competitors: [], summary: "", proposals: [], credits: 0 }] };
    expect(researchDue(ran, NOW, "1.0.0")).toBeNull();
    expect(researchDue(ran, NOW, "1.1.0")).toBe("release");
    expect(researchDue(ran, new Date("2026-11-20T00:00:00Z"), "1.0.0")).toBe("schedule");
  });
});

describe("reviews pass", () => {
  test("drafts replies, sends 4–5 star ones when allowed, low stars become one deduplicated ticket", async () => {
    const seed = withListing();
    seed.settings.autonomy.replies = "auto_positive";
    const { d, calls, store, backlog } = fakeDeps({}, seed);
    const r = await reviewsPass(d);
    expect(r).toMatchObject({ added: 3, drafted: 3, sent: 1, tickets: 1, skipped: [] });
    expect(calls.filter((c) => c.startsWith("reply:"))).toEqual(["reply:ios:a1:Danke a1"]);
    const reviews = await store.reviews("a1");
    expect(reviews.map((x) => [x.id, x.reply?.state, x.version, x.triaged])).toEqual([
      ["g1", "draft", "1.0.0", true],
      ["a1", "sent", "1.0.0", false],
      ["a2", "draft", "1.0.0", true],
    ]);
    const tickets = backlog().tickets;
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ title: "Crash after level 3", type: "bug", signals: { users: 2 } });
    expect(reviews.find((x) => x.id === "a2")!.ticketId).toBe(tickets[0]!.id);
    const f = await store.load("a1");
    expect(f.ratings).toEqual([{ at: NOW.toISOString(), store: "ios", average: 4.5, count: 12, version: "1.0.0" }]);

    // A new low-star review of the same problem raises the same ticket's count.
    const later = fakeDeps(
      {
        store,
        tickets: async () => backlog().tickets,
        asc: { ...d.asc!, reviews: async () => [{ id: "a3", rating: 1, title: "", body: "Wieder Absturz bei Level 3", author: "dora", territory: "DEU", createdAt: "2026-11-03T00:00:00Z", reply: null }] } as unknown as AscListingClient,
        play: { ...d.play!, reviews: async () => [] } as unknown as PlayListingClient,
      },
    );
    let b = backlog();
    later.d.ingest = async (items) => void (b = ingest(b, items, NOW).backlog);
    later.d.tickets = async () => b.tickets;
    await reviewsPass(later.d);
    expect(later.calls).toContain("triage:a3:1");
    expect(b.tickets).toHaveLength(1);
    expect(b.tickets[0]!.signals.users).toBe(3);
  });

  test("ask-first: every reply is a draft; nothing is sent", async () => {
    const { d, calls } = fakeDeps({}, withListing());
    const r = await reviewsPass(d);
    expect(r.sent).toBe(0);
    expect(calls.some((c) => c.startsWith("reply:"))).toBe(false);
  });
});

describe("the pass", () => {
  test("a store app: languages from the app, listings, reviews, research, apply; the screenshot flow as a ticket", async () => {
    const repo = mkdtempSync(join(tmpdir(), "day2-dotty-"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { expo: "54.0.0" } }));
    writeFileSync(join(repo, "app.json"), JSON.stringify({ expo: { locales: { de: "./de.json" } } }));
    const { d, store } = fakeDeps();
    const r = await storePass({ id: "a1", name: "Dotty", repoPath: repo } as never, d);
    expect(r).toMatchObject({ listingsRead: true, researched: true, reviews: { added: 3 }, tickets: ["EXP-9"], skipped: [] });
    const f = await store.load("a1");
    expect(f.settings.locales).toEqual(["de-DE", "en-US"]);
    expect(f.listings.android).toEqual({ "de-DE": { title: "Dotty", shortDescription: "Punkte", fullDescription: "" } });
    // Second pass right after: nothing is due.
    const again = await storePass({ id: "a1", name: "Dotty", repoPath: repo } as never, d);
    expect(again).toMatchObject({ listingsRead: false, researched: false, reviews: null });
  });

  test("a web app: nothing", async () => {
    const repo = mkdtempSync(join(tmpdir(), "day2-web-"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { next: "15" } }));
    const { d } = fakeDeps();
    expect((await storePass({ id: "a1", name: "Web", repoPath: repo } as never, d)).listingsRead).toBe(false);
  });
});

describe("file store", () => {
  test("older files load with defaults filled in", () => {
    const f = normalize({ settings: { locales: ["de-DE"], autonomy: { replies: "auto_positive" } }, proposals: [] });
    expect(f.settings).toMatchObject({ locales: ["de-DE"], autonomy: { listing: "ask", tests: "ask", replies: "auto_positive" }, researchEveryDays: 30, reviewsEveryHours: 6 });
    expect(normalize(null).nextProposal).toBe(1);
  });

  test("updates run one at a time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-store-"));
    const s = fileStoreListing(() => dir);
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        s.update("a", (f) => {
          f.log.push({ at: String(i), text: "x" });
          return { file: f, result: null };
        }),
      ),
    );
    expect((await s.load("a")).log).toHaveLength(5);
  });
});
