import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AscListingClient } from "./asc";
import { applyVersionSetup, checkFact, decideFact, proposeFacts, setupDue, setupItems, setupPass, type ChecklistContext, type SetupDeps } from "./setup";
import { answersVersion, contentRatingAnswers, guidedPlay, normalizeAgeRating, parseAnswers } from "./setup-answers";
import type { AscSetupClient } from "./setup-asc";
import { checkAppIcon, featureGraphicHtml, ffmpegArgs, pngInfo, recordPreview, trimWindow } from "./setup-assets";
import type { PlaySetupClient } from "./setup-play";
import { normalize, type StoreListingStore } from "./store";
import type { ContentAnswers } from "./setup-types";
import { emptyStoreFile, type StoreFile } from "./types";

const NOW = new Date("2026-11-03T10:00:00Z");
const ids = { bundleId: "de.dotty.app", packageName: "de.dotty.app", appStoreId: "123" };

const ANSWERS: ContentAnswers = {
  facts: { privacyPolicyUrl: "https://dotty.app/privacy", privacyChoicesUrl: "", supportUrl: "https://dotty.app/help", marketingUrl: "https://dotty.app", contactEmail: "hi@dotty.app", contactPhone: "+49 30 123", copyrightHolder: "Dotty GmbH", primaryCategory: "FINANCE", secondaryCategory: "PRODUCTIVITY", playCategory: "Finance", playTags: ["Budget", "Bill splitting"], usesThirdPartyContent: false, signInRequired: true, reviewNotes: "Sign in, then open a group.", free: true },
  ageRating: normalizeAgeRating({ messagingAndChat: true, userGeneratedContent: true }),
  play: { targetAges: ["18+"], appealsToChildren: false, containsAds: false, news: false, health: false, financial: true, government: false, contentNotes: "Users chat in groups. No violence." },
  why: { "ios.categories": "It splits bills between friends." },
};

// 1×1 PNGs: RGB (colour type 2) and RGBA (6), with the size patched in.
const png = (w: number, h: number, colorType: number) => {
  const b = new Uint8Array(45);
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  b[24] = 8;
  b[25] = colorType;
  v.setUint32(33, 0);
  b.set([73, 69, 78, 68], 37); // IEND
  return b;
};

function memoryStore(init?: StoreFile): StoreListingStore & { file: () => StoreFile } {
  let f = init ?? emptyStoreFile();
  f.settings.locales = ["de-DE"];
  return {
    file: () => f,
    async load() {
      return normalize(structuredClone(f));
    },
    async update(_id, fn) {
      const out = await fn(normalize(structuredClone(f)));
      f = out.file;
      return out.result;
    },
    async reviews() {
      return [];
    },
    async saveReviews() {},
  };
}

/** An App Store Connect in memory: what day2 reads and writes. */
function fakeApple() {
  const st = {
    categories: { primary: null as string | null, secondary: null as string | null },
    rights: null as string | null,
    infoLocs: [{ id: "il-de", locale: "de-DE", privacyPolicyUrl: null as string | null, privacyChoicesUrl: null as string | null }],
    age: { violenceCartoonOrFantasy: "NONE" } as Record<string, unknown>,
    copyright: null as string | null,
    versionLocs: [{ id: "l-de", locale: "de-DE", supportUrl: null as string | null, marketingUrl: null as string | null }],
    review: null as null | { id: string; attributes: Record<string, unknown> },
    price: null as string | null,
    availability: null as null | { id: string; territories: Array<{ id: string; territory: string; available: boolean }> },
    writes: [] as string[],
    previews: [] as string[],
  };
  const w = (what: string) => st.writes.push(what);
  const setup: Partial<AscSetupClient> = {
    appInfo: async () => ({ id: "i1", editable: true }),
    categories: async () => ({ ...st.categories }),
    setCategories: async (_i, p, s) => void (w("categories"), (st.categories = { primary: p, secondary: s })),
    contentRights: async () => st.rights,
    setContentRights: async (_a, v) => void (w("rights"), (st.rights = v)),
    infoLocalizations: async () => st.infoLocs.map((l) => ({ ...l })),
    setInfoLocalization: async (id, a) => void (w("privacy"), Object.assign(st.infoLocs.find((l) => l.id === id)!, a)),
    ageRating: async () => ({ id: "ar1", attributes: { ...st.age } }),
    // Apple doesn't take ageAssurance through the API in this fake.
    setAgeRating: async (_id, a) => void (w("age"), Object.assign(st.age, Object.fromEntries(Object.entries(a).filter(([k]) => k !== "messagingAndChat")))),
    version: async () => ({ copyright: st.copyright, buildId: null }),
    setCopyright: async (_v, c) => void (w("copyright"), (st.copyright = c)),
    versionLocalizations: async () => st.versionLocs.map((l) => ({ ...l })),
    setVersionLocalization: async (id, a) => void (w("versionLinks"), Object.assign(st.versionLocs.find((l) => l.id === id)!, a)),
    reviewDetail: async () => (st.review ? structuredClone(st.review) : null),
    saveReviewDetail: async (_v, id, a) => (w("review"), (st.review = { id: id ?? "rd1", attributes: { ...a } }), "rd1"),
    currentPrice: async () => st.price,
    pricePoint: async () => "pp-free",
    setPrice: async () => void (w("price"), (st.price = "0.0")),
    availability: async () => (st.availability ? structuredClone(st.availability) : null),
    territories: async () => ["DEU", "USA"],
    createAvailability: async (_a, t) => void (w("availability"), (st.availability = { id: "av", territories: t.map((x) => ({ id: `ta-${x}`, territory: x, available: true })) })),
    setTerritory: async () => void w("territory"),
    screenshotTypes: async () => ["APP_IPHONE_67"],
    replacePreview: async (_l, type) => (st.previews.push(type), "p1"),
  };
  const listing: Partial<AscListingClient> = {
    appIdFor: async () => "app1",
    versions: async () => ({ live: null, editable: { id: "v1", version: "1.0.0" } }),
    versionLocalizationId: async () => "l-de",
  };
  return { st, client: { listing: listing as AscListingClient, setup: setup as AscSetupClient } };
}

function fakePlay() {
  const st = { details: { defaultLanguage: "de-DE" } as Record<string, string>, images: [] as string[], writes: [] as string[] };
  const client: Partial<PlaySetupClient> = {
    details: async () => ({ ...st.details }),
    setDetails: async (_p, c) => void (st.writes.push("details"), Object.assign(st.details, c)),
    videos: async () => ({ "de-DE": "" }),
    setVideo: async () => void st.writes.push("video"),
    replaceImages: async (_p, l, t) => (st.images.push(`${l}:${t}`), 1),
    trackNotes: async () => [{ track: "production", release: "1.0", languages: ["de-DE"] }],
    imageCounts: async () => ({ phoneScreenshots: 4 }),
  };
  return { st, client: client as PlaySetupClient };
}

function deps(repo: string, store: StoreListingStore, over: Partial<SetupDeps> = {}): SetupDeps & { calls: { answers: number; graphics: number } } {
  const calls = { answers: 0, graphics: 0 };
  return {
    calls,
    now: NOW,
    appId: "dotty",
    appName: "Dotty",
    repoPath: repo,
    store,
    ids,
    asc: null,
    play: null,
    profile: { purpose: "Splits bills.", targetUsers: "Friends", featureMap: ["Groups"], brand: null } as never,
    paid: async (_s, _l, _m, fn) => ({ result: await fn(), credits: 0.2 }),
    answers: async () => (calls.answers++, structuredClone(ANSWERS)),
    practices: async () => ({ ads: false, purchases: false }),
    privacy: async () => [],
    ticket: async () => ({ id: "D2-1", created: true }),
    makeGraphics: async (kinds) => (calls.graphics++, Object.fromEntries(kinds.map((k) => [k, `${k}.png`]))),
    graphicPath: (g) => `/tmp/${g.file}`,
    demo: (s) => JSON.parse(s) as { username: string; password: string },
    log: () => {},
    ...over,
  };
}

function repo(icon?: Uint8Array) {
  const dir = mkdtempSync(join(tmpdir(), "day2-setup-"));
  writeFileSync(join(dir, "app.json"), JSON.stringify({ expo: { name: "Dotty", icon: "./assets/icon.png", ios: { bundleIdentifier: ids.bundleId, supportsTablet: false, config: { usesNonExemptEncryption: false } }, android: { package: ids.packageName } } }));
  if (icon) {
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "icon.png"), icon);
  }
  return dir;
}

const approveAll = (f: StoreFile, demo = true) => {
  for (const k of Object.keys(f.setup.facts) as Array<keyof StoreFile["setup"]["facts"]>) {
    const value = k === "ios.review" ? { firstName: "Pia", lastName: "Lang" } : {};
    decideFact(f, k, { value, approve: true, by: "pia", now: NOW });
  }
  if (demo) f.setup.demo = { secret: JSON.stringify({ username: "demo@dotty.app", password: "s3cret" }), label: "Demo account saved", setAt: NOW.toISOString(), setBy: "pia" };
  return f;
};

describe("answers from the code", () => {
  test("the agent's JSON is checked: bad URLs and unknown categories dropped, every age rating question answered", () => {
    const text = `Read the code.\nSTORE_SETUP_JSON:\n${JSON.stringify({ facts: { privacyPolicyUrl: "dotty.app/privacy", supportUrl: "https://dotty.app/help", contactEmail: "nope", primaryCategory: "finance", secondaryCategory: "FINANCE", signInRequired: true, playTags: ["a", "b", "c", "d", "e", "f"] }, ageRating: { violenceRealistic: "FREQUENT", lootBox: true, madeUp: "x" }, play: { targetAges: ["18+", "kids"], sharesLocation: true } })}`;
    const a = parseAnswers(text)!;
    expect(a.facts).toMatchObject({ privacyPolicyUrl: "", supportUrl: "https://dotty.app/help", contactEmail: "", primaryCategory: "FINANCE", secondaryCategory: "", signInRequired: true, free: true });
    expect(a.facts.playTags).toHaveLength(5);
    expect(a.ageRating).toMatchObject({ violenceRealistic: "FREQUENT_OR_INTENSE", lootBox: true, gambling: false, ageAssurance: false, horrorOrFearThemes: "NONE", ageRatingOverrideV2: "NONE", kidsAgeBand: null });
    expect("madeUp" in a.ageRating).toBe(false);
    expect(a.play.targetAges).toEqual(["18+"]);
    expect(a.play.contentNotes).toContain("shares the user's location");
    expect(parseAnswers("no marker")).toBeNull();
  });

  test("Google Play's forms, prepared: content rating from the age rating, app access with the demo account, declarations", () => {
    const g = guidedPlay(ANSWERS, { appName: "Dotty", contactEmail: "hi@dotty.app", containsAds: false, purchases: true, signInRequired: true, ageRating: ANSWERS.ageRating });
    const rating = Object.fromEntries(g["android.contentRating"]!.answers.map((x) => [x.q, x.a]));
    expect(rating["Can users interact or exchange content with each other?"]).toBe("Yes");
    expect(rating["Does the app allow users to purchase digital goods?"]).toBe("Yes");
    expect(rating["Does the app contain violence?"]).toBe("No");
    expect(g["android.appAccess"]!.answers[0]!.a).toBe("All or some functionality in my app is restricted");
    expect(g["android.declarations"]!.answers.find((x) => x.q.startsWith("Financial"))!.a).toMatch(/^Yes/);
    expect(g["android.category"]!.answers).toContainEqual({ q: "Tags (Manage tags → add up to 5)", a: "Budget, Bill splitting" });
    expect(g["android.ads"]!.steps[0]!.detail).toContain("App content");
    expect(contentRatingAnswers(ANSWERS, { contactEmail: "", purchases: false, ageRating: ANSWERS.ageRating })[1]!.a).toBe("All Other App Types");
  });
});

describe("facts", () => {
  test("proposed once, from the answers; nothing proposed twice", () => {
    const s = emptyStoreFile().setup;
    const p = proposeFacts(s, { answers: ANSWERS, ids, appName: "Dotty", locales: ["de-DE"], now: NOW });
    expect(Object.keys(p).sort()).toEqual(["android.details", "android.video", "ios.ageRating", "ios.categories", "ios.contentRights", "ios.pricing", "ios.privacyUrls", "ios.review", "ios.versionInfo"]);
    expect(p["ios.versionInfo"]!.value).toEqual({ supportUrl: "https://dotty.app/help", marketingUrl: "https://dotty.app", copyright: "2026 Dotty GmbH" });
    expect(p["ios.categories"]!.why).toBe("It splits bills between friends.");
    expect(p["android.details"]!.value).toMatchObject({ contactEmail: "hi@dotty.app", contactWebsite: "https://dotty.app", defaultLanguage: "de-DE" });
    expect(proposeFacts({ ...s, facts: p }, { answers: ANSWERS, ids, appName: "Dotty", locales: ["de-DE"], now: NOW })).toEqual({});
    expect(Object.keys(proposeFacts(s, { answers: null, ids: { ...ids, packageName: null }, appName: "Dotty", locales: [], now: NOW }))).not.toContain("android.details");
  });

  test("the owner's edits are checked in plain words", () => {
    expect(() => checkFact("ios.privacyUrls", { privacyPolicyUrl: "dotty.app" }, { privacyPolicyUrl: "", privacyChoicesUrl: "" })).toThrow("Privacy policy link: that isn't a web address (it starts with https://).");
    expect(() => checkFact("ios.categories", { primary: "FINANCE", secondary: "FINANCE" }, {})).toThrow(/different/);
    expect(() => checkFact("ios.pricing", { free: false, price: "" }, { baseTerritory: "USA", territories: "all" })).toThrow(/say what the app costs/);
    expect(checkFact("ios.pricing", { territories: "deu, aut" }, { free: true, price: "", baseTerritory: "usa", territories: "all" })).toMatchObject({ baseTerritory: "USA", territories: "DEU, AUT" });
    expect(() => checkFact("android.video", { url: "https://vimeo.com/1" }, {})).toThrow(/YouTube/);
    expect(() => checkFact("ios.review", {}, { firstName: "", lastName: "x", phone: "1", email: "a@b.de" })).toThrow("First name: please fill this in.");
  });
});

describe("assets", () => {
  test("the App Store icon: 1024×1024 without alpha passes; transparency and the wrong size don't", () => {
    expect(pngInfo(png(1024, 1024, 2))).toEqual({ width: 1024, height: 1024, alpha: false });
    expect(pngInfo(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(checkAppIcon(repo(png(1024, 1024, 2)))).toMatchObject({ ok: true, problems: [] });
    const bad = checkAppIcon(repo(png(512, 512, 6)));
    expect(bad.ok).toBe(false);
    expect(bad.problems).toEqual(["It's 512×512; the App Store needs 1024×1024.", "It has an alpha channel (transparency); the App Store needs an icon without one."]);
    expect(checkAppIcon(repo()).problems[0]).toMatch(/isn't in the repository/);
  });

  test("previews: trimmed to 15–30 s and encoded to Apple's spec", () => {
    expect(trimWindow(42)).toEqual({ start: 1, duration: 30 });
    expect(trimWindow(16.4)).toEqual({ start: 1, duration: 15.4 });
    expect(trimWindow(15.5)).toEqual({ start: 0, duration: 15.5 });
    expect(trimWindow(9)).toBeNull();
    const a = ffmpegArgs({ input: "in.mov", output: "out.mp4", start: 1, duration: 30, width: 886, height: 1920, pad: "#112233" });
    expect(a.join(" ")).toContain("-ss 1 -t 30 -i in.mov");
    expect(a.join(" ")).toContain("fps=30,scale=886:1920:force_original_aspect_ratio=decrease,pad=886:1920:(ow-iw)/2:(oh-ih)/2:color=0x112233");
    expect(a.join(" ")).toContain("-c:v libx264 -profile:v high -level 4.0");
    expect(a.join(" ")).toContain("-c:a aac -b:a 256k -ar 44100 -ac 2");
  });

  test("recording: the screen records while the flow runs, then the recording is encoded", async () => {
    const dir = repo();
    mkdirSync(join(dir, ".maestro/day2"), { recursive: true });
    writeFileSync(join(dir, ".maestro/day2/store-screens.yaml"), "appId: ${APP_ID}");
    const order: string[] = [];
    const target = { platform: "ios", device: "iPhone 17 Pro", id: "SIM-1", build: async () => ({ app: "/x.app" }), install: async () => {}, uninstall: async () => {}, launch: async () => {}, screenshot: async () => true, running: async () => true, crashesSince: async () => [] };
    const r = await recordPreview(
      { cwd: dir, bundleId: ids.bundleId, locale: "de-DE", outDir: join(dir, "out"), pad: "#000000" },
      {
        target: async () => target as never,
        has: () => true,
        record: async (udid) => (order.push(`record:${udid}`), async () => void order.push("stop")),
        runFlow: async (o) => (order.push(`flow:${o.env.DAY2_LOCALE}`), { ok: true, why: null }),
        run: async (cmd) => (order.push(cmd[0]!), { code: 0, out: cmd[0] === "ffprobe" ? "21.3\n" : "", err: "", timedOut: false }),
      },
    );
    expect("file" in r && r.file).toMatch(/preview-de-DE-.*\.mp4$/);
    expect(order).toEqual(["record:SIM-1", "flow:de-DE", "stop", "ffprobe", "ffmpeg"]);
    const short = await recordPreview({ cwd: dir, bundleId: ids.bundleId, locale: "de-DE", outDir: join(dir, "out"), pad: "#000" }, { target: async () => target as never, has: () => true, record: async () => async () => {}, runFlow: async () => ({ ok: true, why: null }), run: async () => ({ code: 0, out: "8", err: "", timedOut: false }) });
    expect("error" in short && short.error).toMatch(/15–30 s/);
    expect(await recordPreview({ cwd: dir, bundleId: ids.bundleId, locale: "de-DE", outDir: dir, pad: "" }, { target: async () => target as never, has: (b) => b !== "ffmpeg" })).toMatchObject({ error: expect.stringMatching(/ffmpeg isn't installed/) });
  });

  test("the feature graphic carries the name and promise, escaped", () => {
    const h = featureGraphicHtml({ name: "Dotty <3", tagline: "Bills, split fairly", style: { background: "#112233", accent: "#ff5500", font: "Arial" }, icon: null });
    expect(h).toContain("width:1024px;height:500px");
    expect(h).toContain("Dotty &lt;3");
    expect(h).toContain("Bills, split fairly");
  });
});

describe("the setup pass", () => {
  test("first pass: answers once, proposals and Play graphics waiting for the owner, the icon checked — nothing written", async () => {
    const store = memoryStore();
    const d = deps(repo(png(1024, 1024, 2)), store);
    const r = await setupPass(d);
    expect(d.calls).toEqual({ answers: 1, graphics: 1 });
    expect(r.proposed).toHaveLength(9);
    expect(r.wrote).toEqual([]);
    const f = store.file();
    expect(f.setup.graphics.map((g) => [g.kind, g.status])).toEqual([["playIcon", "draft"], ["featureGraphic", "draft"]]);
    expect(f.setup.checks["ios.icon"]).toMatchObject({ ok: true });
    expect(f.log.at(-2)!.text).toMatch(/9 answers ready for your OK/);
    // The next pass right after: not due, does nothing.
    await setupPass(d);
    expect(d.calls).toEqual({ answers: 1, graphics: 1 });
  });

  test("approved facts go into both stores; a second pass finds everything in place and writes nothing", async () => {
    const store = memoryStore();
    const apple = fakeApple();
    const play = fakePlay();
    const d = deps(repo(png(1024, 1024, 2)), store, { asc: apple.client, play: play.client });
    await setupPass(d);
    await store.update("dotty", (f) => {
      approveAll(f);
      for (const g of f.setup.graphics) g.status = "approved";
      return { file: f, result: null };
    });
    const r = await setupPass(d);
    expect(apple.st.writes.sort()).toEqual(["age", "availability", "categories", "copyright", "price", "privacy", "review", "rights", "versionLinks"]);
    expect(apple.st.categories).toEqual({ primary: "FINANCE", secondary: "PRODUCTIVITY" });
    expect(apple.st.review!.attributes).toMatchObject({ contactFirstName: "Pia", contactEmail: "hi@dotty.app", demoAccountRequired: true, demoAccountName: "demo@dotty.app", demoAccountPassword: "s3cret" });
    expect(play.st.details).toMatchObject({ contactEmail: "hi@dotty.app", contactWebsite: "https://dotty.app" });
    expect(play.st.images).toEqual(["de-DE:icon", "de-DE:featureGraphic"]);
    expect(r.wrote).toContain("categories");
    const f = store.file();
    expect(f.setup.facts["ios.categories"]).toMatchObject({ state: "approved", error: null, syncedAt: NOW.toISOString() });
    // Apple didn't take "messaging and chat": it becomes the owner's to set by hand.
    expect(f.setup.facts["ios.ageRating"]!.manual).toEqual(["messagingAndChat"]);
    expect(f.setup.graphics.every((g) => g.status === "uploaded")).toBe(true);

    apple.st.writes = [];
    play.st.writes = [];
    const again = await setupPass(d, { force: true });
    expect(apple.st.writes).toEqual([]);
    expect(play.st.writes).toEqual([]);
    expect(again.wrote).toEqual([]);
  });

  test("the checklist: what day2 did, what waits for the owner, the owner's steps with answers", async () => {
    const store = memoryStore();
    const apple = fakeApple();
    const d = deps(repo(png(1024, 1024, 2)), store, { asc: apple.client });
    await setupPass(d);
    const ctx: ChecklistContext = { appId: "dotty", appName: "Dotty", repoPath: d.repoPath, ids, connected: { ios: true, android: false }, privacy: [{ store: "android", where: "", upToDate: false, confirmedAt: null, confirmedBy: null, steps: ["Add App activity → App interactions"], version: "v" }], practices: { ads: false, purchases: false }, canRecord: false, fileUrl: (x) => `/files/${x}` };
    let items = setupItems(store.file(), ctx);
    const by = (id: string) => [...items.ios, ...items.android].find((i) => i.id === id)!;
    expect(by("ios.categories")).toMatchObject({ status: "waiting", how: "api", fact: { state: "proposed", value: { primary: "FINANCE" } } });
    expect(by("ios.exportCompliance")).toMatchObject({ status: "done", how: "release" });
    expect(by("ios.previews").status).toBe("not_needed");
    expect(by("android.playIcon")).toMatchObject({ status: "waiting", graphics: [{ url: "/files/playIcon.png" }] });
    expect(by("android.video").status).toBe("not_needed");
    expect(by("android.dataSafety")).toMatchObject({ status: "owner", link: { url: "/apps/dotty/privacy" } });
    expect(by("android.contentRating")).toMatchObject({ status: "owner", how: "guided" });
    expect(by("android.contentRating").steps![0]!.link!.url).toBe("https://play.google.com/console");

    await store.update("dotty", (f) => {
      approveAll(f, false);
      f.setup.confirmed["android.contentRating"] = { version: answersVersion(by("android.contentRating").answers!), at: NOW.toISOString(), by: "pia" };
      return { file: f, result: null };
    });
    await setupPass(d, { force: true });
    items = setupItems(store.file(), ctx);
    expect(by("ios.categories")).toMatchObject({ status: "done" });
    expect(by("ios.review")).toMatchObject({ status: "owner", demo: { set: false } });
    expect(by("ios.ageRating")).toMatchObject({ status: "owner", how: "guided", answers: [{ q: "Messaging or chat between users", a: "Yes" }] });
    expect(by("ios.screenshots").status).toBe("done");
    expect(by("android.contentRating").status).toBe("done");
    expect(by("android.details").status).toBe("pending");
  });

  test("version facts wait for a version being prepared", async () => {
    const store = memoryStore();
    const apple = fakeApple();
    apple.client.listing.versions = async () => ({ live: { id: "v0", version: "0.9" }, editable: null });
    const d = deps(repo(png(1024, 1024, 2)), store, { asc: apple.client });
    await setupPass(d);
    await store.update("dotty", (f) => ({ file: approveAll(f), result: null }));
    await setupPass(d, { force: true });
    const fact = store.file().setup.facts["ios.versionInfo"]!;
    expect(fact).toMatchObject({ waitsForVersion: true, syncedAt: null });
    expect(fact.error).toMatch(/next App Store version/);
    expect(apple.st.writes).not.toContain("copyright");
  });

  test("the release hook writes the version facts and approved previews into the version being submitted", async () => {
    const apple = fakeApple();
    const f = emptyStoreFile();
    f.setup.facts = proposeFacts(f.setup, { answers: ANSWERS, ids, appName: "Dotty", locales: ["de-DE"], now: NOW });
    approveAll(f);
    f.setup.graphics.push({ id: "SG-p", kind: "preview", file: "p.mp4", locale: "de-DE", previewType: "IPHONE_67", status: "approved", at: "", uploadedAt: null, error: null });
    const r = await applyVersionSetup(apple.client, f.setup, { versionId: "v1", demo: (s) => JSON.parse(s), previewFile: () => "/x/p.mp4" });
    expect(r.facts["ios.versionInfo"]).toMatchObject({ ok: true, wrote: true });
    expect(r.facts["ios.review"]).toMatchObject({ ok: true, wrote: true });
    expect(r.previews).toEqual({ "SG-p": null });
    expect(apple.st.previews).toEqual(["IPHONE_67", "IPHONE_65"]);
  });

  test("due: never ran, six hours later, or the owner approved something since", () => {
    const s = emptyStoreFile().setup;
    expect(setupDue(s, NOW)).toBe(true);
    s.lastPassAt = NOW.toISOString();
    expect(setupDue(s, new Date(NOW.getTime() + 3_600_000))).toBe(false);
    expect(setupDue(s, new Date(NOW.getTime() + 7 * 3_600_000))).toBe(true);
    s.facts["ios.pricing"] = { value: {}, state: "approved", why: "", proposedAt: "", approvedBy: null, approvedAt: new Date(NOW.getTime() + 60_000).toISOString(), syncedAt: null, error: null };
    expect(setupDue(s, new Date(NOW.getTime() + 120_000))).toBe(true);
  });
});
