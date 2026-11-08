import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileAssetStore } from "../ads/assets";
import { chooseTemplate, cleanRegion, fallbackShotList, parseShotList, templateFit } from "./art-director";
import { cleanOverrides, contrast, ensureBrandKit, extractBrandKit, fontFromFile, kitBrief, loadBrandKit, onColor, resolveKit, type ResolvedKit } from "./brand-kit";
import { capturePlan, chooseScreens, isStale, simctlCommands, type CaptureSet } from "./capture";
import { applyIssues, critique, critiqueLoop, layoutIssues, parseCritique, type Critique } from "./critique";
import { applySlideTexts, reorderSlides } from "./edit";
import { fetchFigmaTokens, figmaFileKey } from "./figma";
import { beatSource, mixArgs } from "./motion/audio";
import { chromiumPath } from "../simulation";
import type { Rendered } from "./render";
import { runStudio } from "./studio";
import { CRITERIA, noteSignal, passes, preferenceLines, templateLiking, weightedScore, type CreativeState } from "./taste";
import { TEMPLATE_LIST, TEMPLATES } from "./templates";
import { innerZoom, trailPoints } from "./templates/parts";
import type { ScreenAsset, ShotList } from "./templates/types";

const DOTTY = "/home/claude/dotty";
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "day2-cq-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A small fake Expo app: theme tokens, NativeWind/Tailwind config, fonts, icon, German UI copy. */
function fakeRepo(): string {
  const r = join(dir, `repo-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(r, "src", "theme"), { recursive: true });
  mkdirSync(join(r, "src", "screens"), { recursive: true });
  mkdirSync(join(r, "assets", "fonts"), { recursive: true });
  writeFileSync(join(r, "app.json"), JSON.stringify({ expo: { name: "Lernly", icon: "./assets/icon.png", userInterfaceStyle: "light", android: { adaptiveIcon: { backgroundColor: "#3B5BFD" } }, plugins: [["expo-font", { fonts: ["./assets/fonts/Inter-Regular.ttf", "./assets/fonts/Inter-ExtraBold.ttf"] }]] } }));
  writeFileSync(join(r, "src", "theme", "colors.ts"), `export const colors = { brand: '#3b5bfd', text: '#101828', muted: '#667085', bg: '#FFFFFF', card: '#F2F4F7', danger: '#F04438' };\nexport const radii = { sm: 8, md: 14, lg: 22, pill: 999 };`);
  writeFileSync(join(r, "tailwind.config.js"), `module.exports = { theme: { extend: { colors: { brand: '#3b5bfd' } } } }`);
  writeFileSync(join(r, "src", "screens", "Home.tsx"), `export function Home(){ return <View><Text>Deine Karteikarten für heute</Text><Text>Lern mit deinen Freunden 🎉</Text><Text style={{fontFamily:'Inter-ExtraBold', borderRadius: 14}}>Los geht's</Text><Text>Du hast 5 Karten gelernt</Text></View> }`);
  writeFileSync(join(r, "assets", "fonts", "Inter-Regular.ttf"), "x");
  writeFileSync(join(r, "assets", "fonts", "Inter-ExtraBold.ttf"), "x");
  writeFileSync(join(r, "assets", "icon.png"), "x");
  return r;
}

// ---------------------------------------------------------------- brand kit

describe("brand kit from the app's repo", () => {
  test("a generic Expo app: brand colour near the icon, ink, radii, fonts, language and tone", () => {
    const r = fakeRepo();
    const k = extractBrandKit(r, { iconColor: () => null });
    expect(k.appName).toBe("Lernly");
    expect(k.colors.primary).toBe("#3b5bfd");
    expect(k.colors.ink).toBe("#101828");
    expect(k.colors.background).toBe("#ffffff");
    expect(k.fonts.display?.family).toBe("Inter");
    expect(k.fonts.display?.weight).toBe(800);
    expect(k.fonts.body?.weight).toBe(400);
    expect(k.radii.pill).toBe(true);
    expect(k.icon.path).toBe("assets/icon.png");
    expect(k.copy.language).toBe("de");
    expect(k.copy.casualYou).toBe(true);
    expect(k.sources).toContain("src/theme/colors.ts");
  });

  test.skipIf(!existsSync(DOTTY))("Dotty: yellow from its icon, ink #222, Nunito Black/SemiBold, 3D icons and buttons, German casual tone", () => {
    const k = extractBrandKit(DOTTY);
    expect(k.appName).toBe("Dotty");
    expect(["#f5d84a", "#f7dd5b", "#f5c228"]).toContain(k.colors.primary);
    expect(k.colors.ink).toBe("#222222");
    expect(k.colors.inkSoft).toBe("#6a6a6a");
    expect(k.fonts.display).toMatchObject({ family: "Nunito", weight: 900 });
    expect(k.fonts.body).toMatchObject({ family: "Nunito", weight: 600 });
    expect(k.icon.path).toBe("assets/icon.png");
    expect(k.style.illustration).toBe("3d-icons");
    expect(k.style.buttons).toBe("3d");
    expect(k.copy.language).toBe("de");
    expect(k.copy.casualYou).toBe(true);
    expect(k.copy.samples.some((s) => /Freunde/.test(s))).toBe(true);
    const r = resolveKit({ extracted: k, overrides: {}, updatedAt: "" }, { repoPath: DOTTY, appName: "Dotty" });
    expect(r.onPrimary).toBe("#222222");
    expect(r.icon).toBe(join(DOTTY, "assets/icon.png"));
    expect(Object.keys(r.stickers)).toEqual(expect.arrayContaining(["fire", "pin", "sparkles", "map"]));
    expect(kitBrief(r)).toContain("Nunito");
  });

  test("owner edits win; invalid edits are dropped; stored next to the app and kept on refresh", () => {
    const r = fakeRepo();
    expect(cleanOverrides({ primary: "#FF0000", ink: "red", displayFont: "Nunito<script>", tone: "<b>locker</b>", language: "de" })).toEqual({ primary: "#ff0000", tone: "blocker/b", language: "de" } as never);
    const s = ensureBrandKit(r);
    expect(loadBrandKit(r)?.extracted?.appName).toBe("Lernly");
    const k = resolveKit({ ...s, overrides: { primary: "#ff5500" } }, { repoPath: r, appName: "Lernly" });
    expect(k.primary).toBe("#ff5500");
    // Brand DNA's confirmed primary is used when there's no extracted kit.
    expect(resolveKit(null, { repoPath: r, appName: "X", dna: { visual: { palette: [{ hex: "#00aa55", role: "primary" }] } } as never }).primary).toBe("#00aa55");
    // Never a placeholder logo: no icon file → null.
    expect(resolveKit(null, { repoPath: r, appName: "X" }).icon).toBeNull();
  });

  test("helpers: font weights from file names, readable text colour", () => {
    expect(fontFromFile("a/Nunito-ExtraBold.ttf")).toMatchObject({ family: "Nunito", weight: 800 });
    expect(fontFromFile("a/Poppins-SemiBold.otf")).toMatchObject({ family: "Poppins", weight: 600 });
    expect(onColor("#f5d84a", "#222222")).toBe("#222222");
    expect(onColor("#3b5bfd", "#101828")).toBe("#ffffff");
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 0);
  });
});

// ---------------------------------------------------------------- templates

function pngScreen(name: string, color: string): ScreenAsset {
  const file = join(dir, `${name}.png`);
  if (!existsSync(file)) spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=390x844`, "-frames:v", "1", file]);
  return { file, width: 390, height: 844, language: "de", source: "mock", name, statusBar: 0.06 };
}
const kitFor = (): ResolvedKit =>
  existsSync(DOTTY) ? { ...resolveKit({ extracted: extractBrandKit(DOTTY), overrides: {}, updatedAt: "" }, { repoPath: DOTTY, appName: "Dotty" }), language: "de" } : { ...resolveKit(null, { repoPath: dir, appName: "Dotty" }), language: "de" };
const shotsFor = (template: ShotList["template"]): ShotList => ({
  template,
  hook: "Wo seid ihr eigentlich?",
  kicker: null,
  steps: [
    { headline: "Freunde auf der Karte", caption: "Du siehst sofort, wer wo ist", screen: 0, focus: { x: 0.1, y: 0.3, w: 0.6, h: 0.2 }, tap: { x: 0.5, y: 0.9 }, sticker: "map" },
    { headline: "Teil deinen Moment", caption: "Nur wo du wirklich bist", screen: 1, focus: { x: 0.05, y: 0.7, w: 0.9, h: 0.1 }, tap: null, sticker: "pin" },
    { headline: "Gewinn die Woche", caption: null, screen: 0, focus: null, tap: null, sticker: null },
  ],
  problem: ["wo seid ihr?", "hallo???"],
  pov: "POV: Du suchst deine Freunde",
  cta: "Link in Bio",
  endLine: "Dein Leben mit Freunden auf der Karte",
  version: "1.0.2",
  broll: null,
});

describe("templates", () => {
  test("every template builds deterministic HTML with the kit's colours, fonts and escaped text", () => {
    const kit = kitFor();
    const screens = [pngScreen("a", "white"), pngScreen("b", "gray")];
    for (const t of TEMPLATE_LIST()) {
      const shots = { ...shotsFor(t.id), steps: shotsFor(t.id).steps.slice(0, t.maxSteps), hook: "Wo <seid> ihr?", pov: "POV: Wo <seid> ihr?", problem: ["wo <seid> ihr?"] };
      const input = { shots, kit, screens, broll: [] };
      if (t.video) {
        const v = t.video(input);
        expect(v.html).toBe(t.video(input).html);
        expect(v.html).toContain(kit.primary);
        expect(v.html).toContain("&lt;seid&gt;");
        expect(v.html).not.toContain("<seid>");
        expect(v.seconds).toBeGreaterThan(6);
        expect(v.seconds).toBeLessThanOrEqual(30);
        expect(v.sampleTimes[0]).toBeLessThan(1.5);
        expect(v.cues.length).toBeGreaterThan(1);
      }
      if (t.slides) for (const r of ["4:5", "1:1"] as const) {
        const s = t.slides(input, r);
        expect(s.html).toContain('font-family:"Display"');
        expect(s.count).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test("How it works: cover + one slide per step + end slide; the real icon on the end card, never a letter mark", () => {
    const kit = kitFor();
    const s = TEMPLATES["how-it-works"].slides!({ shots: shotsFor("how-it-works"), kit, screens: [pngScreen("a", "white")], broll: [] }, "4:5");
    expect(s.count).toBe(5);
    if (kit.icon) expect(s.html).toContain('class="icon');
    const noIcon = TEMPLATES["how-it-works"].slides!({ shots: shotsFor("how-it-works"), kit: { ...kit, icon: null }, screens: [pngScreen("a", "white")], broll: [] }, "4:5");
    expect(noIcon.html).not.toContain('class="icon');
    expect(noIcon.html).not.toContain('class="mark');
  });

  test("camera zoom never shows past the screen's edges; trail points are evenly spaced", () => {
    const z = innerZoom({ cardW: 700, viewH: 800, contentH: 1500, focus: { x: 650, y: 1450 }, target: { x: 350, y: 400 }, z: 1.5 });
    expect(z.tx).toBeGreaterThanOrEqual(700 - 1.5 * 700);
    expect(z.ty).toBeGreaterThanOrEqual(800 - 1.5 * 1500);
    expect(z.tx).toBeLessThanOrEqual(0);
    const pts = trailPoints([{ x: 0, y: 0 }, { x: 100, y: 0 }], 11);
    expect(pts).toHaveLength(11);
    expect(pts[5]!.x).toBeCloseTo(50, 0);
  });

  test("sound: built-in beat and cues mixed into the social spec", () => {
    const a = mixArgs("in.mp4", { seconds: 10, cues: [{ t: 1, kind: "whoosh" }, { t: 2, kind: "tap" }] }, "out.mp4");
    expect(a.join(" ")).toContain("amix=inputs=4");
    expect(a).toContain("aac");
    expect(a.join(" ")).toContain("-ar 48000");
    expect(a.join(" ")).toContain("+faststart");
    expect(mixArgs("in.mp4", { seconds: 10, cues: [], music: "m.mp3" }, "o.mp4").join(" ")).toContain("-stream_loop -1 -i m.mp3");
    expect(beatSource(5)).toContain("aevalsrc");
  });

  test.skipIf(!chromiumPath())("render smoke: How it works slides and a Feature spotlight video (low fps) come out at the right sizes", async () => {
    const { renderTemplate } = await import("./render");
    const kit = kitFor();
    const screens = [pngScreen("a", "white"), pngScreen("b", "gray")];
    const r = await renderTemplate("how-it-works", { shots: shotsFor("how-it-works"), kit, screens, broll: [] }, { dir: join(dir, "render"), name: "hiw", video: false, ratios: ["4:5", "1:1"] });
    expect(r.slides[0]!.files).toHaveLength(5);
    expect(r.slides[1]!.ratio).toBe("1:1");
    expect(r.slides[0]!.boxes[1]!.some((b) => b.role === "headline")).toBe(true);
    const v = await renderTemplate("feature-spotlight", { shots: { ...shotsFor("feature-spotlight"), steps: shotsFor("feature-spotlight").steps.slice(0, 1) }, kit, screens, broll: [] }, { dir: join(dir, "render"), name: "spot", ratios: [], fps: 4 });
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,sample_rate", "-of", "csv=p=0", v.video!.file]).stdout.toString();
    expect(probe).toContain("h264,1080,1920");
    expect(probe).toContain("aac,48000");
    expect(v.video!.frames.length).toBeGreaterThanOrEqual(3);
    const blockers = layoutIssues({ rendered: v, screens, language: "de", hasIcon: true }).filter((i) => i.severity === "blocker");
    if (blockers.length) console.log(blockers);
    expect(blockers).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------- art director

const emptyState = (): CreativeState => ({ templates: {}, howItWorksAt: null, log: [] });

describe("art director", () => {
  test("template choice: forced, new app → How it works, fresh release → What's new, POV only with b-roll, variants differ", () => {
    const base = { posts: 10, howItWorksDone: true, topic: "story", hook: "relatable_moment", state: emptyState(), broll: 0, screens: 4, rng: () => 0.5 };
    expect(chooseTemplate({ ...base, forced: "launch" })!.template).toBe("launch");
    expect(chooseTemplate({ ...base, posts: 0, howItWorksDone: false })!.template).toBe("how-it-works");
    expect(chooseTemplate({ ...base, release: { version: "1.1", notes: ["Neu: Chats"], at: new Date().toISOString(), posted: false } })!.template).toBe("whats-new");
    for (let k = 0; k < 20; k++) expect(chooseTemplate({ ...base, rng: () => k / 20 })!.template).not.toBe("pov-hook");
    expect(chooseTemplate({ ...base, broll: 1, exclude: ["how-it-works", "feature-spotlight", "problem-solution"] })!.template).toBe("pov-hook");
    expect(chooseTemplate({ ...base, exclude: ["how-it-works", "feature-spotlight", "problem-solution"] })).toBeNull();
    expect(templateFit("feature", "feature_demo")["feature-spotlight"]).toBeGreaterThan(templateFit("feature", "feature_demo")["pov-hook"]);
  });

  test("the owner's taste shifts the choice", () => {
    let s = emptyState();
    for (let k = 0; k < 6; k++) s = noteSignal(s, "problem-solution", "declined", "zu werbig");
    for (let k = 0; k < 6; k++) s = noteSignal(s, "feature-spotlight", "picked");
    const like = templateLiking(s);
    expect(like["feature-spotlight"]).toBeGreaterThan(0.7);
    expect(like["problem-solution"]).toBeLessThan(0.3);
    let spot = 0;
    for (let k = 0; k < 100; k++) if (chooseTemplate({ posts: 10, howItWorksDone: true, topic: "use_case", hook: "before_after", state: s, broll: 0, screens: 4, rng: () => k / 100 })!.template === "feature-spotlight") spot++;
    expect(spot).toBeGreaterThan(40);
    expect(preferenceLines(s)[0]).toContain("feature-spotlight");
    expect(preferenceLines(s).join(" ")).toContain('"zu werbig"');
  });

  test("shot list parsing clamps words, regions (also percentages), screens and stickers", () => {
    const text = `ok\nSHOT_LIST_JSON:\n${JSON.stringify({ hook: "Wo seid ihr eigentlich alle heute Abend bloß hin?", steps: [{ headline: "Freunde auf der Karte sehen und so weiter", caption: "c", screen: 9, focus: { x: 10, y: 50, w: 80, h: 20 }, tap: { x: 2, y: 0.5 }, sticker: "rocket" }, { headline: "Zwei", screen: 0, focus: null }, { headline: "Drei", screen: 1 }], cta: "", endLine: "Ende" })}`;
    const s = parseShotList(text, { template: "how-it-works", screens: 2, stickers: ["map"], language: "de", broll: 0 })!;
    expect(s.hook.split(" ").length).toBeLessThanOrEqual(7);
    expect(s.steps[0]!.headline.split(" ").length).toBeLessThanOrEqual(6);
    expect(s.steps[0]!.screen).toBe(1);
    expect(s.steps[0]!.focus).toEqual({ x: 0.1, y: 0.5, w: 0.8, h: 0.2 });
    expect(s.steps[0]!.tap).toEqual({ x: 1, y: 0.5 });
    expect(s.steps[0]!.sticker).toBeNull();
    expect(s.cta).toBe("Link in Bio");
    expect(parseShotList("no marker", { template: "how-it-works", screens: 2, stickers: [], language: "de", broll: 0 })).toBeNull();
    // Too few steps for the template → unusable.
    expect(parseShotList(`SHOT_LIST_JSON:\n{"hook":"x","steps":[{"headline":"a","screen":0}]}`, { template: "how-it-works", screens: 2, stickers: [], language: "de", broll: 0 })).toBeNull();
    expect(cleanRegion({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 });
  });

  test("fallback shot list without a director run is valid for every template", () => {
    const screens = [pngScreen("a", "white"), pngScreen("b", "gray")];
    for (const t of TEMPLATE_LIST()) {
      const s = fallbackShotList({ idea: { title: "So geht Dotty heute", lines: ["Karte", "Momente teilen", "Rückblick"], topic: "feature", hook: "how_to", cta: "" }, template: t.id, screens, language: "de", kit: kitFor() });
      expect(s.steps.length).toBeGreaterThanOrEqual(t.minSteps);
      expect(s.steps.length).toBeLessThanOrEqual(t.maxSteps);
      expect(s.cta).toBe("Link in Bio");
    }
  });
});

// ---------------------------------------------------------------- critique

const rendered = (boxes: Array<{ role: string; x: number; y: number; w: number; h: number; px: number }>, slides = false): Rendered =>
  slides
    ? { template: "how-it-works", video: null, slides: [{ ratio: "4:5", files: ["s1.jpg"], boxes: [boxes.map((b) => ({ ...b, visible: true, text: "Text" }))] }] }
    : { template: "how-it-works", video: { file: "v.mp4", seconds: 12, cover: "c.jpg", frames: [{ t: 0.8, file: "f.jpg", boxes: boxes.map((b) => ({ ...b, visible: true, text: "Text" })) }] }, slides: [] };

describe("design critique", () => {
  test("layout facts: TikTok UI zones, tiny text, cut-off text, clutter, English screens under German copy", () => {
    const de = [pngScreen("a", "white")];
    expect(layoutIssues({ rendered: rendered([{ role: "headline", x: 84, y: 300, w: 800, h: 200, px: 96 }]), screens: de, language: "de", hasIcon: true })).toEqual([]);
    const bottom = layoutIssues({ rendered: rendered([{ role: "caption", x: 140, y: 1600, w: 800, h: 100, px: 46 }]), screens: de, language: "de", hasIcon: true });
    expect(bottom[0]).toMatchObject({ criterion: "safe_zones", severity: "blocker" });
    expect(layoutIssues({ rendered: rendered([{ role: "headline", x: 84, y: 300, w: 800, h: 50, px: 20 }]), screens: de, language: "de", hasIcon: true })[0]!.criterion).toBe("legibility");
    expect(layoutIssues({ rendered: rendered([{ role: "headline", x: 900, y: 300, w: 400, h: 50, px: 80 }], true), screens: de, language: "de", hasIcon: true })[0]!.text).toContain("cut off");
    const many = Array.from({ length: 6 }, (_, k) => ({ role: "headline", x: 100, y: 300 + k * 100, w: 300, h: 50, px: 50 }));
    expect(layoutIssues({ rendered: rendered(many), screens: de, language: "de", hasIcon: true }).some((i) => i.criterion === "clutter")).toBe(true);
    const en = [{ ...pngScreen("a", "white"), language: "en" }];
    const mix = layoutIssues({ rendered: rendered([]), screens: en, language: "de", hasIcon: false });
    expect(mix.find((i) => i.criterion === "language")).toMatchObject({ severity: "blocker" });
    expect(mix.find((i) => i.criterion === "language")!.text).toContain("English");
    // Warned on the post card instead: it may go to the owner, flagged.
    expect(layoutIssues({ rendered: rendered([]), screens: en, language: "de", hasIcon: true, warned: true }).find((i) => i.criterion === "language")!.severity).toBe("major");
  });

  test("scores: weighted, blockers can't pass, layout findings cap the critic's scores", () => {
    const good = Object.fromEntries(CRITERIA.map((c) => [c.id, 8])) as never;
    expect(weightedScore(good)).toBe(8);
    expect(passes(good).ok).toBe(true);
    expect(passes({ ...(good as object), language: 4 } as never)).toMatchObject({ ok: false, failing: ["language"] });
    const capped = applyIssues(good, [{ criterion: "safe_zones", severity: "blocker", text: "", fix: "" }]);
    expect(capped.safe_zones).toBe(3);
    expect(passes(capped).ok).toBe(false);
  });

  test("the critic's answer is parsed defensively", () => {
    const p = parseCritique(`x\nCRITIQUE_JSON:\n{"scores":{"hook":9,"legibility":12,"bogus":3},"verdict":"approve","fixes":["shorten step 2 <b>"],"why":"Real German screens."}`)!;
    expect(p.scores).toEqual({ hook: 9, legibility: 10 });
    expect(p.fixes[0]).toBe("shorten step 2 b");
    expect(parseCritique("nothing")).toBeNull();
  });

  test("with a fake vision model: approve / fix → re-render / drop after 2 rounds", async () => {
    const screens = [pngScreen("a", "white")];
    const scored = (n: number, why = "Works.") => async () => `CRITIQUE_JSON:\n${JSON.stringify({ scores: Object.fromEntries(CRITERIA.map((c) => [c.id, n])), verdict: n >= 7 ? "approve" : "fix", fixes: n >= 7 ? [] : ["make the hook specific"], why })}`;
    const judge = (vision: () => Promise<string>) => (r: Rendered) => critique({ rendered: r, screens, language: "de", hasIcon: true, appName: "Dotty", kitBrief: "", vision });
    const r0 = rendered([{ role: "headline", x: 84, y: 300, w: 800, h: 200, px: 96 }]);
    // Approve first time.
    const a = await critiqueLoop({ first: shotsFor("how-it-works"), render: async () => r0, judge: judge(scored(8.5)), direct: async () => { throw new Error("no re-direct needed"); } });
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.critique).toMatchObject({ verdict: "approve", why: "Works.", bySight: true, score: 8.5 });
    // Fails, the director gets the fixes, the re-render passes.
    const answers = [scored(5), scored(8)];
    const fixesSeen: string[][] = [];
    let renders = 0;
    const b = await critiqueLoop({ first: shotsFor("how-it-works"), render: async () => (renders++, r0), judge: (r) => judge(answers.shift()!)(r), direct: async (fixes, prev) => (fixesSeen.push(fixes), { ...prev, hook: "Wo seid ihr eigentlich?" }) });
    expect(b.ok).toBe(true);
    expect(renders).toBe(2);
    expect(fixesSeen[0]).toContain("make the hook specific");
    // Still failing after 2 re-renders → dropped with a reason, never shown.
    let n = 0;
    const c = await critiqueLoop({ first: shotsFor("how-it-works"), render: async () => (n++, r0), judge: judge(scored(4)), direct: async (_f, prev) => prev });
    expect(c.ok).toBe(false);
    expect(n).toBe(3);
    if (!c.ok) expect(c.reason).toContain("didn't pass after 3 rounds");
    // A layout blocker overrides an approving critic.
    const bad = rendered([{ role: "caption", x: 140, y: 1700, w: 800, h: 100, px: 46 }]);
    const d: Critique = await judge(scored(9))(bad);
    expect(d.verdict).toBe("fix");
    expect(d.fixes.join(" ")).toContain("shorten the caption");
  });

  test("without a vision model the layout facts decide", async () => {
    const c = await critique({ rendered: rendered([{ role: "headline", x: 84, y: 300, w: 800, h: 200, px: 96 }]), screens: [pngScreen("a", "white")], language: "de", hasIcon: true, appName: "Dotty", kitBrief: "", vision: null });
    expect(c).toMatchObject({ verdict: "approve", bySight: false });
  });
});

// ---------------------------------------------------------------- studio

describe("studio", () => {
  test("variants with different templates, critique per variant, assets stored with the score; foreign screens warned", async () => {
    const store = fileAssetStore(join(dir, "assets"), "https://day2.test");
    const screens = [pngScreen("a", "white"), pngScreen("b", "gray")];
    const fakeRender = async (id: ShotList["template"], _s: ShotList, _k: ResolvedKit, d: string, name: string): Promise<Rendered> => {
      mkdirSync(d, { recursive: true });
      const f = (x: string) => {
        const p = join(d, `${name}-${x}.jpg`);
        writeFileSync(p, "jpg");
        return p;
      };
      writeFileSync(join(d, `${name}.mp4`), "mp4");
      return { template: id, video: { file: join(d, `${name}.mp4`), seconds: 12, cover: f("cover"), frames: [{ t: 0.8, file: f("f0"), boxes: [] }] }, slides: TEMPLATES[id].slides ? [{ ratio: "4:5", files: [f("s1"), f("s2")], boxes: [[], []] }] : [] };
    };
    const vision = async ({ prompt }: { prompt: string }) => (prompt.includes("SHOT_LIST_JSON") ? `SHOT_LIST_JSON:\n${JSON.stringify({ hook: "Wo seid ihr?", steps: [{ headline: "Karte", screen: 0 }, { headline: "Moment", screen: 1 }, { headline: "Rückblick", screen: 0 }], problem: ["wo?", "hallo?"], cta: "Link in Bio", endLine: "Dotty" })}` : `CRITIQUE_JSON:\n${JSON.stringify({ scores: Object.fromEntries(CRITERIA.map((c) => [c.id, 8])), verdict: "approve", fixes: [], why: "Clear steps on real screens." })}`);
    const out = await runStudio({
      appId: "dotty", appName: "Dotty", repoPath: existsSync(DOTTY) ? DOTTY : dir, purpose: "Freunde auf der Karte", features: ["Karte"], language: "de",
      idea: { title: "So geht Dotty", lines: ["Karte", "Momente"], topic: "use_case", hook: "before_after", cta: "" },
      kit: null, screens: { screens, source: "capture", warning: null, recordings: [] }, broll: [], state: emptyState(), posts: 0,
      variants: 2, want: { video: true, carousel: true }, vision, store, tag: "social:sv_test", render: fakeRender, rng: () => 0.3,
    });
    expect(out.variants).toHaveLength(2);
    expect(out.variants[0]!.template).toBe("how-it-works");
    expect(out.variants[1]!.template).not.toBe("how-it-works");
    expect(out.variants[0]!.critique.why).toBe("Clear steps on real screens.");
    expect(out.variants[0]!.video?.mime).toBe("video/mp4");
    expect(out.variants[0]!.slides["4:5"]).toHaveLength(2);
    expect(out.screens).toHaveLength(2);
    // No screens → nothing made.
    const none = await runStudio({ appId: "dotty", appName: "Dotty", repoPath: dir, purpose: "", features: [], language: "de", idea: { title: "x", lines: [], topic: "feature", hook: "how_to", cta: "" }, kit: null, screens: { screens: [], source: "none", warning: "No screens", recordings: [] }, broll: [], state: emptyState(), posts: 0, variants: 1, want: { video: true, carousel: true }, vision: null, store, tag: "t" });
    expect(none.variants).toHaveLength(0);
    expect(none.dropped[0]).toContain("no real screen");
  });
});

// ---------------------------------------------------------------- capture, edits, figma

describe("screens in the audience's language", () => {
  const cap = (language: string): CaptureSet => ({ version: "1.0.2", locale: "de-DE", language, capturedAt: new Date().toISOString(), source: "capture", device: "iPhone 16", screens: [{ file: "/x/a.png", width: 1179, height: 2556, language, source: "capture", name: "karte" }], recordings: [] });
  test("fallback order: fresh capture → store captures for the locale → App Store screenshots with a warning", () => {
    expect(chooseScreens({ language: "de", capture: cap("de"), storeLocale: [], store: [], web: [] }).source).toBe("capture");
    expect(chooseScreens({ language: "de", capture: cap("en"), storeLocale: [{ file: "/s/1.png", name: "home" }], store: [], web: [] })).toMatchObject({ source: "store-locale", warning: null });
    const en = chooseScreens({ language: "de", capture: null, storeLocale: [], store: [{ file: "/s/en.png", language: "en" }], web: [] });
    expect(en.source).toBe("store");
    expect(en.warning).toContain("Screens are in English");
    expect(en.screens[0]!.language).toBe("en");
    expect(chooseScreens({ language: "de", capture: null, storeLocale: [], store: [], web: [] }).source).toBe("none");
  });
  test("capture plan from the store notes; simulator commands set the locale and a clean status bar; stale on a new version", () => {
    const r = fakeRepo();
    mkdirSync(join(r, ".maestro", "day2"), { recursive: true });
    writeFileSync(join(r, ".maestro/day2/store-screens.json"), JSON.stringify({ screens: [{ name: "01-karte", shows: "Die Karte" }, { name: "02-moment", shows: "Moment teilen" }] }));
    writeFileSync(join(r, ".maestro/day2/store-screens.yaml"), "appId: x");
    const p = capturePlan({ repoPath: r, language: "de", features: [] });
    expect(p).toMatchObject({ locale: "de-DE", flow: ".maestro/day2/store-screens.yaml" });
    expect(p.moments.map((m) => m.name)).toEqual(["01-karte", "02-moment"]);
    const cmds = simctlCommands("UDID", { locale: "de-DE", screenshot: "/o/a.png", record: "/o/a.mp4" }).map((c) => c.join(" "));
    expect(cmds[0]).toContain("AppleLanguages -array de");
    expect(cmds[1]).toContain("AppleLocale de_DE");
    expect(cmds[2]).toContain("status_bar UDID override --time 9:41");
    expect(cmds.some((c) => c.includes("io UDID screenshot"))).toBe(true);
    expect(cmds.some((c) => c.includes("io UDID recordVideo --codec=h264"))).toBe(true);
    expect(isStale(cap("de"), "1.0.2")).toBe(false);
    expect(isStale(cap("de"), "1.1.0")).toBe(true);
    expect(isStale(null, "1")).toBe(true);
  });
});

describe("carousel edits", () => {
  test("per-slide words: cover → hook, steps → headline/caption, end → line and button", () => {
    const s = applySlideTexts(shotsFor("how-it-works"), [{ index: 0, headline: "Neuer Hook" }, { index: 2, headline: "Moment <teilen>", caption: null }, { index: 4, headline: "Bis gleich", caption: "Jetzt laden" }]);
    expect(s.hook).toBe("Neuer Hook");
    expect(s.steps[1]).toMatchObject({ headline: "Moment teilen", caption: null });
    expect(s.endLine).toBe("Bis gleich");
    expect(s.cta).toBe("Jetzt laden");
  });
  test("reorder: only a permutation; steps follow when cover and end stay", () => {
    const sh = shotsFor("how-it-works");
    const ids = ["c", "s1", "s2", "s3", "e"];
    const r = reorderSlides(ids, ["c", "s3", "s1", "s2", "e"], sh)!;
    expect(r.ids).toEqual(["c", "s3", "s1", "s2", "e"]);
    expect(r.shots!.steps.map((x) => x.headline)).toEqual(["Gewinn die Woche", "Freunde auf der Karte", "Teil deinen Moment"]);
    expect(reorderSlides(ids, ["c", "s1"], sh)).toBeNull();
    expect(reorderSlides(ids, ["c", "s1", "s1", "s3", "e"], sh)).toBeNull();
    expect(reorderSlides(ids, ["s1", "c", "s2", "s3", "e"], sh)!.shots).toBe(sh);
  });
});

describe("Figma (optional)", () => {
  test("file key from URLs; colour and text styles from two REST calls, token in the header only", async () => {
    expect(figmaFileKey("https://www.figma.com/design/AbCdEf1234567890/Dotty?node-id=1-2")).toBe("AbCdEf1234567890");
    expect(figmaFileKey("https://evil.com/design/AbCdEf1234567890/x")).toBeNull();
    const calls: Array<{ url: string; token: string | null }> = [];
    const f = (async (u: string, init?: RequestInit) => {
      calls.push({ url: String(u), token: new Headers(init?.headers).get("x-figma-token") });
      if (String(u).includes("/styles")) return Response.json({ meta: { styles: [{ key: "k1", node_id: "1:2", style_type: "FILL", name: "Brand/Primary" }, { key: "k2", node_id: "1:3", style_type: "TEXT", name: "Title" }] } });
      return Response.json({ nodes: { "1:2": { document: { fills: [{ type: "SOLID", color: { r: 0.96, g: 0.85, b: 0.29 } }] } }, "1:3": { document: { style: { fontFamily: "Nunito", fontWeight: 900 } } } } });
    }) as typeof fetch;
    const t = await fetchFigmaTokens("AbCdEf1234567890", "figd_secret_token_value", { fetch: f });
    expect(t.colors).toEqual([{ name: "Brand/Primary", hex: "#f5d94a" }]);
    expect(t.fonts).toEqual([{ name: "Title", family: "Nunito", weight: 900 }]);
    expect(calls.every((c) => c.token === "figd_secret_token_value" && !c.url.includes("figd_"))).toBe(true);
    // The kit uses the Figma primary unless the owner set one.
    expect(resolveKit({ extracted: null, overrides: {}, figma: t, updatedAt: "" }, { repoPath: dir, appName: "X" }).primary).toBe("#f5d94a");
  });
});
