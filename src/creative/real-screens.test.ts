import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileAssetStore } from "../ads/assets";
import { AI_SOURCE_TYPE, withAiMark } from "./ai-label";
import { adbCommands, captureMoments, chooseScreens, flowScreenshots, importScreens, loadCaptureSet, shotName, type CaptureSet } from "./capture";
import { autoCaptureReason, captureMode, loadCaptureStatus, runCapture, type CaptureRunDeps } from "./capture-run";
import { OPENAI_IMAGES } from "./providers/openai-images";
import { fakeCastDraft, fakeCastModel, generateCast, buildCastPrompt } from "./demo-cast/generate";
import { addCastImages, avatarPrompt, bundledDemoPictures, placeholderPng } from "./demo-cast/images";
import { CAST_MARKER, castUuid, rng, validateCast } from "./demo-cast/schema";
import { castAiFlags, loadCast, loadCastRaw, saveCast } from "./demo-cast/store";
import { artifactLinks, captureWorkflowYaml, demoFlowTicket, DEMO_PROFILE, LOGIN_ENV, withDemoProfile } from "./demo-flow";
import { creatorKit, FICTIONAL_PERSON_RULES } from "./kit";
import type { ToolState } from "./select";
import { checkScreenshot, loadUploadSet, saveUploadSet, sniffImage, UploadError } from "./upload";

/**
 * Real screens: the demo cast (schema, generator, pictures), screenshot
 * uploads (checked and cleaned), captures wired to fake devices and a fake
 * EAS, the flow ticket, and the AI mark.
 */

let data: string;
const prev = process.env.DAY2_DATA_DIR;
beforeAll(() => {
  data = mkdtempSync(join(tmpdir(), "day2-rs-"));
  process.env.DAY2_DATA_DIR = data;
});
afterAll(() => {
  rmSync(data, { recursive: true, force: true });
  if (prev === undefined) delete process.env.DAY2_DATA_DIR;
  else process.env.DAY2_DATA_DIR = prev;
});

const ffmpeg = (args: string[]) => spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]).status === 0;
/** A phone-shaped test image (JPEG or PNG) made by ffmpeg. */
function phoneShot(dir: string, name: string, w = 600, h = 1300): string {
  const f = join(dir, name);
  ffmpeg(["-f", "lavfi", "-i", `color=c=0x3366aa:s=${w}x${h}`, "-frames:v", "1", f]);
  return f;
}
const ctx = { appId: "app_rs", appName: "Dotty", purpose: "Sieh, wo deine Freunde gerade sind", features: ["Karte mit Freunden", "Moment teilen", "Feed", "Wochenrangliste"], audience: "junge Leute in Deutschland", language: "de", tone: "casual (du)" };

describe("the demo cast", () => {
  test("the seeded cast is deterministic, German, all adults, and valid", () => {
    const a = fakeCastDraft({ language: "de", seed: 42 });
    expect(fakeCastDraft({ language: "de", seed: 42 })).toEqual(a);
    expect(fakeCastDraft({ language: "de", seed: 43 })).not.toEqual(a);
    expect(a.people).toHaveLength(8);
    expect(a.people.every((p) => p.age >= 18 && p.age <= 30)).toBe(true);
    expect(validateCast(a).ok).toBe(true);
    expect(castUuid(42, "moments", "m1")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(rng(1)()).toBe(rng(1)());
  });

  test("minors, real people, handles and links are refused; dangling references are dropped", () => {
    const base = fakeCastDraft({ language: "de", seed: 1 });
    const minor = validateCast({ ...base, people: base.people.map((p, i) => (i === 2 ? { ...p, age: 16 } : p)) });
    expect(minor.ok).toBe(false);
    expect(minor.problems.join()).toContain("must be an adult");
    const famous = validateCast({ ...base, people: base.people.map((p, i) => (i === 1 ? { ...p, displayName: "Taylor Swift" } : p)) });
    expect(famous.ok).toBe(false);
    expect(validateCast({ ...base, people: base.people.map((p, i) => (i === 1 ? { ...p, bio: "folgt mir auf @realperson" } : p)) }).ok).toBe(false);
    const dangling = validateCast({ ...base, moments: [...base.moments, { key: "mx", person: "nobody", place: "pl1", caption: "x", minutesAgo: 3, scene: "x" }], reactions: [...base.reactions, { moment: "nope", person: "p1" }] });
    expect(dangling.ok).toBe(true);
    if (dangling.ok) {
      expect(dangling.draft.moments.some((m) => m.key === "mx")).toBe(false);
      expect(dangling.draft.reactions.some((r) => r.moment === "nope")).toBe(false);
    }
    expect(validateCast({ ...base, self: "zz" }).ok).toBe(false);
  });

  test("the model's cast is used when valid; one retry with its problems; else the built-in cast", async () => {
    const prompts: string[] = [];
    const good = await generateCast(ctx, { model: async (p) => (prompts.push(p), fakeCastModel(5)(p)), seed: 5 });
    expect(good.cast.generator).toBe("model");
    expect(good.cast.status).toBe("draft");
    expect(prompts[0]).toContain("LANGUAGE: de");
    expect(prompts[0]).toContain("ADULT aged 18");
    expect(prompts[0]).not.toMatch(/https?:/);
    let n = 0;
    const retried = await generateCast(ctx, { model: async () => (++n === 1 ? `${CAST_MARKER}\n{"self":"p1","people":[{"key":"p1","displayName":"Kim","username":"kim","age":15}]}` : null), seed: 5 });
    expect(n).toBe(2);
    expect(retried.cast.generator).toBe("fake");
    expect(retried.note).toContain("built-in");
    expect(buildCastPrompt(ctx, ["person p1: age 15"])).toContain("refused for: person p1: age 15");
  });

  test("pictures: generated with the posts' image tool as an invented adult (AI person); without a tool the app's own demo pictures, else placeholders", async () => {
    const { cast } = await generateCast(ctx, { model: fakeCastModel(3), seed: 3 });
    const store = fileAssetStore(join(data, "assets"), "https://day2.test");
    // No tool, no pictures in the repo: placeholders.
    const empty = mkdtempSync(join(tmpdir(), "day2-norepo-"));
    const plain = await addCastImages(structuredClone(cast), { kit: null, store, repoPath: empty, appName: "Dotty", colors: ["#f5d84a"] });
    expect(plain.images.source).toBe("placeholder");
    expect(plain.images.note).toContain("No image tool is connected");
    expect(castAiFlags(plain)).toEqual({ aiGenerated: false, aiPerson: false });
    // The app's own bundled demo pictures.
    const repo = mkdtempSync(join(tmpdir(), "day2-bundled-"));
    mkdirSync(join(repo, "src/assets/welcome"), { recursive: true });
    for (const n of ["avatar-mia.jpg", "avatar-jonas.jpg", "pizza.jpg", "park.jpg", "map-bg.jpg"]) writeFileSync(join(repo, "src/assets/welcome", n), Buffer.alloc(5000, 1));
    expect(bundledDemoPictures(repo)).toEqual({ avatars: [join(repo, "src/assets/welcome/avatar-jonas.jpg"), join(repo, "src/assets/welcome/avatar-mia.jpg")], photos: [join(repo, "src/assets/welcome/park.jpg"), join(repo, "src/assets/welcome/pizza.jpg")] });
    const bundled = await addCastImages(structuredClone(cast), { kit: null, store, repoPath: repo, appName: "Dotty", colors: [] });
    expect(bundled.images.source).toBe("bundled");
    // A connected image tool (OpenAI Images, fake API): AI-generated, people marked as AI persons, the prompt has the person rules.
    const bodies: Array<{ prompt: string }> = [];
    const jpeg = readFileSync(phoneShot(mkdtempSync(join(tmpdir(), "day2-j-")), "a.jpg", 64, 64)).toString("base64");
    const fakeFetch = (async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ data: [{ b64_json: jpeg }] });
    }) as typeof fetch;
    const states: ToolState[] = [{ def: OPENAI_IMAGES, setting: { account: "own", posts: true, ads: true, capCredits: 300 }, own: { id: "k", accountId: "a", appId: null, tool: "openai_images", creds: { apiKey: ["sk", "test", "x"].join("-") }, meta: { fields: ["apiKey"], likeness: {} }, connectedBy: null, connectedAt: "" }, operator: null, usedCredits: 0 }];
    const kit = creatorKit({ purpose: "posts", states, deps: { fetch: fakeFetch, sleep: async () => {} } });
    const made = await addCastImages(structuredClone(cast), { kit, store, repoPath: repo, appName: "Dotty", colors: [] });
    expect(made.images.source).toBe("generated");
    expect(made.people.every((p) => p.avatar?.aiPerson && p.avatar.aiGenerated)).toBe(true);
    expect(made.moments.every((m) => m.photo?.aiGenerated && !m.photo.aiPerson)).toBe(true);
    expect(castAiFlags(made)).toEqual({ aiGenerated: true, aiPerson: true });
    expect(bodies[0]!.prompt).toContain(FICTIONAL_PERSON_RULES);
    expect(bodies[0]!.prompt).not.toContain(cast.people[0]!.displayName);
    expect(bodies.at(-1)!.prompt).toContain("no people, faces or hands");
    const asset = await store.get(made.people[0]!.avatar!.assetId!);
    expect(asset).toMatchObject({ purpose: "demo-cast", aiGenerated: true, aiPerson: true });
    // Stored without file paths; loaded back with them.
    saveCast(made);
    expect(JSON.stringify(loadCastRaw(cast.appId))).not.toContain(data);
    expect((await loadCast(cast.appId, store))!.people[0]!.avatar!.file).toBe(asset!.path);
    expect(avatarPrompt(cast.people[0]!)).toMatch(/invented adult, about \d+ years old/);
    expect(sniffImage(placeholderPng(8, 8, "#ff0000"))).toBe("png");
  });
});

describe("screenshot uploads", () => {
  test("magic bytes, header size and shape are checked before decoding", () => {
    const png = readFileSync(phoneShot(mkdtempSync(join(tmpdir(), "day2-u-")), "a.png"));
    expect(checkScreenshot("a.png", png)).toMatchObject({ kind: "png", width: 600, height: 1300 });
    expect(() => checkScreenshot("evil.png", new TextEncoder().encode("<svg onload=alert(1)>"))).toThrow(UploadError);
    expect(() => checkScreenshot("wide.png", readFileSync(phoneShot(mkdtempSync(join(tmpdir(), "day2-u-")), "w.png", 1300, 600)))).toThrow(/portrait phone screenshot/);
    expect(() => checkScreenshot("big.png", new Uint8Array(11 * 1024 * 1024).fill(0x89))).toThrow(/over 10 MB/);
    const fakeSize = Buffer.from(png);
    fakeSize.writeUInt32BE(90000, 16);
    expect(() => checkScreenshot("bomb.png", fakeSize)).toThrow(/too large/);
  });

  test("a set is re-encoded without metadata (EXIF/GPS gone), stored per app and language, and preferred right after fresh captures", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-u-"));
    const jpg = readFileSync(phoneShot(dir, "a.jpg"));
    const secret = "GPS-52.5200N-13.4050E-PHONE-OF-OWNER";
    const exif = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.alloc(2), Buffer.from(`Exif\0\0${secret}`)]);
    exif.writeUInt16BE(exif.length - 2, 2);
    const withExif = Buffer.concat([jpg.subarray(0, 2), exif, jpg.subarray(2)]);
    expect(withExif.includes(secret)).toBe(true);
    const files = [{ name: "1.jpg", bytes: new Uint8Array(withExif) }, { name: "2.png", bytes: new Uint8Array(readFileSync(phoneShot(dir, "b.png"))) }, { name: "3.png", bytes: new Uint8Array(readFileSync(phoneShot(dir, "c.png"))) }];
    expect(() => saveUploadSet("app_up", "de", files.slice(0, 2))).toThrow(/Upload 3–8 screenshots/);
    expect(() => saveUploadSet("app_up", "../de", files)).toThrow(/language/);
    const set = saveUploadSet("app_up", "de", files, { now: new Date("2026-11-08T10:00:00Z"), version: "1.0.2" });
    expect(set).toMatchObject({ source: "upload", locale: "de-DE", language: "de" });
    for (const s of set.screens) {
      const b = readFileSync(s.file);
      expect(sniffImage(b)).toBe("png");
      expect(b.includes(secret)).toBe(false);
      expect(b.includes("Exif")).toBe(false);
    }
    const loaded = loadUploadSet("app_up", "de-DE")!;
    expect(loaded.screens).toHaveLength(3);
    expect(loadUploadSet("other_app", "de-DE")).toBeNull();
    // A file that claims to be a PNG but isn't one is refused, and nothing of the set is kept.
    const fake = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0x58, 0, 0, 5, 0x14, ...new Array(60).fill(7)]);
    expect(() => saveUploadSet("app_up2", "de", [files[1]!, files[2]!, { name: "x.png", bytes: fake }])).toThrow(/couldn't read that image/);
    expect(loadUploadSet("app_up2", "de-DE")).toBeNull();
  });

  test("order: fresh capture → upload → older capture → store locale → App Store (with the warning)", () => {
    const cap = (version: string, language = "de"): CaptureSet => ({ version, locale: "de-DE", language, capturedAt: new Date().toISOString(), source: "capture", device: "iPhone", screens: [{ file: "/c.png", width: 1, height: 2, language, source: "capture", name: "01" }], recordings: [], aiContent: { aiGenerated: true, aiPerson: true } });
    const up: CaptureSet = { ...cap("1.0.2"), source: "upload", screens: [{ file: "/u.png", width: 1, height: 2, language: "de", source: "upload", name: "upload-1" }], aiContent: null };
    const base = { language: "de", storeLocale: [], store: [{ file: "/s.png", language: "en" }], web: [] };
    expect(chooseScreens({ ...base, capture: cap("1.0.2"), upload: up, version: "1.0.2" })).toMatchObject({ source: "capture", stale: false, aiContent: { aiGenerated: true } });
    expect(chooseScreens({ ...base, capture: cap("1.0.1"), upload: up, version: "1.0.2" })).toMatchObject({ source: "upload", aiContent: null });
    expect(chooseScreens({ ...base, capture: cap("1.0.1"), upload: null, version: "1.0.2" })).toMatchObject({ source: "capture", stale: true });
    expect(chooseScreens({ ...base, capture: null, upload: { ...up, language: "en" }, version: "1.0.2" }).warning).toContain("Screens are in English");
  });
});

describe("captures", () => {
  const plan = { version: "1.0.2", locale: "de-DE", language: "de", flow: ".maestro/day2/store-screens.yaml", moments: [{ name: "01-karte", shows: "Die Karte" }], record: false };

  test("Android: locale and the demo-mode status bar; the login reaches the flow only as secret env; screenshots named without the prefix", async () => {
    expect(adbCommands("emulator-5554", { locale: "de-DE" }).map((c) => c.join(" "))).toEqual(expect.arrayContaining(["adb -s emulator-5554 shell setprop persist.sys.locale de-DE", expect.stringContaining("-e hhmm 0941")]));
    const ran: string[][] = [];
    const flows: Array<{ env: Record<string, string>; secretEnv?: Record<string, string> }> = [];
    const r = await captureMoments(
      { appId: "app_cap", repoPath: "/repo", bundleId: "de.x", plan, secretEnv: { [LOGIN_ENV.email]: "demo@example.com", [LOGIN_ENV.password]: "pw-123" }, aiContent: { aiGenerated: true, aiPerson: true } },
      {
        device: async () => ({ id: "emulator-5554", name: "Pixel 8", platform: "android", run: async (c) => (ran.push(c), { code: 0 }) }),
        flow: async (o) => {
          flows.push(o);
          mkdirSync(join(o.outDir, "nested"), { recursive: true });
          writeFileSync(join(o.outDir, "day2-shot-01-karte.png"), placeholderPng(60, 130, "#f5d84a"));
          writeFileSync(join(o.outDir, "nested", "day2-shot-02-feed.png"), placeholderPng(60, 130, "#222222"));
          writeFileSync(join(o.outDir, "screenshot-❌-1.png"), placeholderPng(60, 130, "#ff0000"));
          return { ok: true, why: null };
        },
      },
    );
    expect(ran.some((c) => c.includes("persist.sys.locale"))).toBe(true);
    expect(flows[0]!.env).not.toHaveProperty(LOGIN_ENV.password);
    expect(flows[0]!.secretEnv).toEqual({ [LOGIN_ENV.email]: "demo@example.com", [LOGIN_ENV.password]: "pw-123" });
    expect(r.set!.screens.map((s) => s.name)).toEqual(["01-karte", "02-feed"]);
    expect(r.set!.screens[0]!.shows).toBe("Die Karte");
    expect(loadCaptureSet("app_cap", "de-DE")!.aiContent).toEqual({ aiGenerated: true, aiPerson: true });
    expect(shotName("/x/day2-shot-03-moment.png")).toBe("03-moment");
  });

  test("capture mode: a Mac with Xcode runs locally (Maestro hint when missing); a server without a simulator uses EAS; off when told", () => {
    expect(captureMode({ env: {}, platform: "darwin", has: (b) => b === "xcrun" })).toMatchObject({ mode: "local", maestro: false, why: expect.stringContaining('curl -fsSL "https://get.maestro.mobile.dev" | bash') });
    expect(captureMode({ env: {}, platform: "linux", has: () => false })).toMatchObject({ mode: "eas", why: null });
    expect(captureMode({ env: { DAY2_CAPTURE: "off" }, platform: "linux", has: () => false })).toMatchObject({ mode: "off" });
    expect(captureMode({ env: { DAY2_CAPTURE: "eas" }, platform: "linux", has: () => false }).mode).toBe("eas");
  });

  test("automatic captures: a new app version, and before the first How it works post", () => {
    const idle = { state: "idle" as const, mode: null, reason: null, startedAt: null, finishedAt: null, note: null, screens: 0, log: [] };
    const set = { version: "1.0.1", capturedAt: new Date().toISOString() } as CaptureSet;
    const now = new Date();
    expect(autoCaptureReason({ set, version: "1.0.2", howItWorksAt: "x", making: null, status: idle, now, ready: true })).toBe("new_version");
    expect(autoCaptureReason({ set: null, version: "1.0.2", howItWorksAt: null, making: "how-it-works", status: idle, now, ready: true })).toBe("first_how_it_works");
    expect(autoCaptureReason({ set: null, version: "1.0.2", howItWorksAt: null, making: "how-it-works", status: idle, now, ready: false })).toBeNull();
    expect(autoCaptureReason({ set, version: "1.0.2", howItWorksAt: "x", making: null, status: { ...idle, state: "failed", reason: "new_version", finishedAt: now.toISOString() }, now, ready: true })).toBeNull();
  });

  function checkout(): string {
    const dir = mkdtempSync(join(tmpdir(), "day2-co-"));
    mkdirSync(join(dir, ".maestro/day2"), { recursive: true });
    writeFileSync(join(dir, ".maestro/day2/store-screens.yaml"), "appId: ${APP_ID}\n");
    writeFileSync(join(dir, ".maestro/day2/store-screens.json"), JSON.stringify({ screens: [{ name: "01-karte", shows: "Die Karte" }] }));
    writeFileSync(join(dir, "app.json"), JSON.stringify({ expo: { version: "1.0.2" } }));
    writeFileSync(join(dir, "eas.json"), JSON.stringify({ build: { production: {} } }));
    return dir;
  }
  const demo = { url: "https://refdemo0000000000001.supabase.co", key: "sb_publishable_refdemo", login: { email: "demo-x@example.com", password: ["pass", "word", "9z"].join("-") }, ai: { aiGenerated: true, aiPerson: true } };

  test("local: the demo build gets the demo backend's public values (never the password); the flow gets the login; status and log", async () => {
    const dir = checkout();
    const builds: Array<Record<string, string>> = [];
    const d: CaptureRunDeps = {
      mode: "local",
      checkout: async () => ({ dir, done: async () => {} }),
      demo: async () => demo,
      local: {
        target: async () => ({ platform: "ios", device: "iPhone 16 (iOS 18.2)", id: "UDID", build: async (_d, env) => (builds.push(env), { app: "/x.app" }), install: async () => {}, uninstall: async () => {}, launch: async () => {}, screenshot: async () => true, running: async () => true, crashesSince: async () => [] }),
        flow: async (o) => {
          expect(o.secretEnv![LOGIN_ENV.password]).toBe(demo.login.password);
          writeFileSync(join(o.outDir, "day2-shot-01-karte.png"), placeholderPng(60, 130, "#f5d84a"));
          return { ok: true, why: null };
        },
        run: async () => ({ code: 0 }),
      },
    };
    const s = await runCapture({ appId: "app_local", repoPath: dir, language: "de", features: [], bundleId: "de.x", packageName: null, reason: "button" }, d);
    expect(s).toMatchObject({ state: "done", screens: 1, mode: "local" });
    expect(builds[0]).toEqual({ EXPO_PUBLIC_DAY2_DEMO: "1", EXPO_PUBLIC_SUPABASE_URL: demo.url, EXPO_PUBLIC_SUPABASE_KEY: demo.key });
    expect(JSON.stringify(loadCaptureStatus("app_local"))).not.toContain(demo.login.password);
    expect(loadCaptureSet("app_local", "de-DE")!.screens).toHaveLength(1);
  });

  test("EAS: demo profile + workflow in the checkout, the login as secret EAS variables, artifact downloaded and imported", async () => {
    const dir = checkout();
    const runs: Array<{ cmd: string[]; env: Record<string, string> }> = [];
    const downloads: string[] = [];
    const token = ["expo", "tok", "abc"].join("_");
    const d: CaptureRunDeps = {
      mode: "eas",
      checkout: async () => ({ dir, done: async () => {} }),
      demo: async () => demo,
      eas: {
        expoToken: async () => token,
        run: async (cmd, o) => {
          runs.push({ cmd, env: o.env });
          if (cmd.includes("workflow:run")) return { code: 0, stdout: JSON.stringify({ id: "wr_1", status: "SUCCESS", url: "https://expo.dev/x" }), stderr: "" };
          if (cmd.includes("workflow:view")) return { code: 0, stdout: JSON.stringify({ jobs: [{ key: "capture", artifacts: [{ name: "day2-screens", downloadUrl: "https://storage.googleapis.com/eas/a.png" }, { name: "junit", downloadUrl: "https://storage.googleapis.com/eas/r.xml" }] }] }), stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        download: async (url, out, o) => {
          expect(o.tool).toBe("eas");
          downloads.push(url);
          writeFileSync(out, placeholderPng(60, 130, "#00ff00"));
          return { mime: "image/png", bytes: 10 };
        },
      },
    };
    const s = await runCapture({ appId: "app_eas", repoPath: dir, language: "de", features: [], bundleId: "de.x", packageName: null, reason: "new_version" }, d);
    expect(s.state).toBe("done");
    expect(downloads).toEqual(["https://storage.googleapis.com/eas/a.png"]);
    const create = runs.filter((r) => r.cmd.includes("env:create"));
    expect(create).toHaveLength(2);
    expect(create.every((r) => r.cmd.includes("secret") && r.env.EXPO_TOKEN === token)).toBe(true);
    const eas = JSON.parse(readFileSync(join(dir, "eas.json"), "utf-8"));
    expect(eas.build[DEMO_PROFILE].env).toMatchObject({ EXPO_PUBLIC_SUPABASE_URL: demo.url, EXPO_PUBLIC_DAY2_DEMO: "1" });
    const files = readFileSync(join(dir, "eas.json"), "utf-8") + readFileSync(join(dir, ".eas/workflows/day2-capture.yml"), "utf-8");
    expect(files).not.toContain(demo.login.password);
    expect(loadCaptureSet("app_eas", "de-DE")).toMatchObject({ mode: "eas", device: "EAS iOS Simulator" });
  });

  test("EAS without a fetchable artifact: says so and keeps the Mac path", async () => {
    const dir = checkout();
    const d: CaptureRunDeps = { mode: "eas", checkout: async () => ({ dir, done: async () => {} }), demo: async () => demo, eas: { expoToken: async () => "t", run: async (cmd) => ({ code: 0, stdout: cmd.includes("workflow:run") ? '{"id":"wr_2","status":"SUCCESS"}' : "{}", stderr: "" }) } };
    const s = await runCapture({ appId: "app_eas2", repoPath: dir, language: "de", features: [], bundleId: "de.x", packageName: null, reason: "button" }, d);
    expect(s).toMatchObject({ state: "failed", note: expect.stringContaining("Capture on your Mac instead") });
  });

  test("no flow yet: the capture explains the ticket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-noflow-"));
    const s = await runCapture({ appId: "app_noflow", repoPath: dir, language: "de", features: [], bundleId: "de.x", packageName: null, reason: "button" }, { mode: "local", checkout: async () => ({ dir, done: async () => {} }), demo: async () => null });
    expect(s.note).toContain("no Maestro flow yet");
  });

  test("flowScreenshots never follows a symlink out of the folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-ln-"));
    writeFileSync(join(dir, "day2-shot-01-a.png"), placeholderPng(60, 130, "#000000"));
    spawnSync("ln", ["-s", "/etc/passwd", join(dir, "day2-shot-02-b.png")]);
    expect(flowScreenshots(dir).map(shotName)).toEqual(["01-a"]);
    expect(importScreens({ appId: "app_ln", plan, dir, device: null, at: new Date(), aiContent: null, mode: "eas" }).set!.screens).toHaveLength(1);
  });
});

describe("the app-side pieces", () => {
  test("the flow ticket: demo sign-in behind a flag, MAESTRO_ variables, a demo profile without secrets, the moments", () => {
    const { cast } = { cast: { ...fakeCastDraft({ language: "de", seed: 2 }), self: "p1" } as never };
    const t = demoFlowTicket({ appName: "Dotty", features: ["Karte mit Freunden", "Moment teilen", "Feed"], locale: "de-DE", cast, hasStoreFlow: false, existingNotes: [], record: true });
    expect(t.source.key).toBe("creative:demo-flow");
    expect(t.description).toContain("${MAESTRO_DAY2_DEMO_EMAIL}");
    expect(t.description).toContain('process.env.EXPO_PUBLIC_DAY2_DEMO === "1"');
    expect(t.description).toContain("takeScreenshot: day2-shot-<name>");
    expect(t.description).toContain("01-karte-mit-freunden");
    expect(t.description).not.toMatch(/supabase\.co|sb_publishable|password":/);
  });

  test("EAS pieces: the demo profile, the workflow with Maestro and the artifact upload, and links found in the run's JSON", () => {
    const j = JSON.parse(withDemoProfile(JSON.stringify({ build: { production: { channel: "production" } } }), { url: "https://r.supabase.co", key: "pk" }));
    expect(j.build.production).toEqual({ channel: "production" });
    expect(j.build[DEMO_PROFILE]).toMatchObject({ ios: { simulator: true }, env: { EXPO_PUBLIC_DAY2_DEMO: "1", EXPO_PUBLIC_SUPABASE_KEY: "pk" } });
    const y = captureWorkflowYaml({ flow: ".maestro/day2/store-screens.yaml", record: true });
    expect(y).toContain("type: maestro");
    expect(y).toContain("build_id: ${{ needs.build.outputs.build_id }}");
    expect(y).toContain("uses: eas/upload_artifact");
    expect(y).toContain("record_screen: true");
    expect(artifactLinks({ a: { name: "day2-screens", files: [{ url: "https://x.expo.dev/1.zip" }] }, b: { url: "http://insecure/day2-screens.png" } })).toEqual(["https://x.expo.dev/1.zip"]);
  });

  test("the AI mark: IPTC digital source type in an XMP segment of JPEGs, once", () => {
    const jpg = new Uint8Array(readFileSync(phoneShot(mkdtempSync(join(tmpdir(), "day2-ai-")), "a.jpg", 64, 64)));
    const marked = withAiMark(jpg);
    expect(Buffer.from(marked).includes(AI_SOURCE_TYPE)).toBe(true);
    expect(withAiMark(marked).length).toBe(marked.length);
    expect(ffmpeg(["-i", "pipe:0", "-f", "null", "-"])).toBe(false); // (no input given: just proves ffmpeg is callable)
    const out = join(mkdtempSync(join(tmpdir(), "day2-ai2-")), "m.jpg");
    writeFileSync(out, marked);
    expect(ffmpeg(["-i", out, "-f", "null", "-"])).toBe(true);
    expect(existsSync(out)).toBe(true);
  });
});
