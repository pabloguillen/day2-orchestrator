import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetStore, StoredAsset } from "../ads/assets";
import type { BrandDna } from "../brand-dna";
import { chooseTemplate, directShots, type Idea } from "./art-director";
import { kitBrief, resolveKit, type ResolvedKit, type StoredBrandKit } from "./brand-kit";
import type { ScreenChoice } from "./capture";
import { critique, critiqueLoop, type Critique } from "./critique";
import { renderTemplate, type Rendered } from "./render";
import { preferenceLines, type CreativeState } from "./taste";
import { TEMPLATES } from "./templates";
import type { BrollAsset, Ratio, ShotList, TemplateId } from "./templates/types";
import type { VisionRun } from "./vision";

/**
 * The studio: one idea in, 1–2 finished variants out (docs/creative-quality.md).
 *
 *   brand kit (the app's design language) + the app's real screens
 *   → art director: template + shot list
 *   → render (9:16 video with sound, 4:5 and 1:1 slides)
 *   → critique (layout facts + vision rubric) → fixes → re-render (≤ 2 rounds)
 *   → stored assets, with the score and "why this works"; or dropped with the reason.
 */

export type StudioVariant = {
  template: TemplateId;
  templateWhy: string;
  shots: ShotList;
  critique: Critique;
  rounds: number;
  video: StoredAsset | null;
  cover: StoredAsset | null;
  slides: Partial<Record<Ratio, StoredAsset[]>>;
};

export type StudioInput = {
  appId: string;
  appName: string;
  repoPath: string;
  purpose: string;
  features: string[];
  language: string;
  idea: Idea;
  kit: StoredBrandKit | null;
  dna?: BrandDna | null;
  screens: ScreenChoice;
  broll: BrollAsset[];
  state: CreativeState;
  posts: number;
  release?: { version: string; notes: string[]; at: string; posted: boolean } | null;
  forced?: TemplateId | null;
  variants: 1 | 2;
  /** Which outputs the post needs. */
  want: { video: boolean; carousel: boolean };
  vision: VisionRun | null;
  music?: string | null;
  store: AssetStore;
  /** Stored assets' purpose, e.g. "social:sg_…". */
  tag: string;
  rng?: () => number;
  log?: (t: string) => void;
  /** Tests: a fake renderer. */
  render?: (id: TemplateId, shots: ShotList, kit: ResolvedKit, dir: string, name: string) => Promise<Rendered>;
};

/** The screens a post was made from, kept as assets (so an edit can re-render the slides later). */
export type KeptScreen = { id: string; width: number; height: number; language: string | null; statusBar: number; name: string; source: string };
export type StudioOut = { variants: StudioVariant[]; dropped: string[]; warning: string | null; kit: ResolvedKit; screens?: KeptScreen[] };

export async function runStudio(i: StudioInput): Promise<StudioOut> {
  const kit = resolveKit(i.kit, { repoPath: i.repoPath, appName: i.appName, dna: i.dna });
  // Post language wins over the kit's guess (the owner may have set it on Social).
  kit.language = i.language;
  const brief = kitBrief(kit, i.kit);
  const out: StudioOut = { variants: [], dropped: [], warning: i.screens.warning, kit };
  if (!i.screens.screens.length) {
    out.dropped.push("day2 has no real screen of the app yet");
    return out;
  }
  const used: TemplateId[] = [];
  const dir = mkdtempSync(join(tmpdir(), "day2-studio-"));
  try {
    for (let v = 0; v < i.variants; v++) {
      const choice = chooseTemplate({ forced: v === 0 ? i.forced : null, posts: i.posts, howItWorksDone: Boolean(i.state.howItWorksAt), release: i.release, topic: i.idea.topic, hook: i.idea.hook, state: i.state, broll: i.broll.length, screens: i.screens.screens.length, exclude: used, rng: i.rng });
      if (!choice) break;
      used.push(choice.template);
      const t = TEMPLATES[choice.template];
      const dirIn = { appName: i.appName, purpose: i.purpose, features: i.features, language: i.language, kit, kitBrief: brief, idea: i.idea, template: choice.template, screens: i.screens.screens, brollCount: i.broll.length, preferences: preferenceLines(i.state), releaseNotes: i.release?.notes };
      const first = await directShots(dirIn, i.vision);
      if (first.note) i.log?.(first.note);
      const ratios: Ratio[] = i.want.carousel && t.slides ? ["4:5", "1:1"] : t.slides && !t.video ? ["4:5"] : t.slides ? ["4:5"] : [];
      const name = `v${v + 1}-${choice.template}`;
      const loop = await critiqueLoop({
        first: first.shots,
        render: async (shots, round) => {
          const input = { shots, kit, screens: i.screens.screens, broll: i.broll };
          const r = i.render ? await i.render(choice.template, shots, kit, dir, `${name}-r${round}`) : await renderTemplate(choice.template, input, { dir, name: `${name}-r${round}`, video: i.want.video || !t.slides, ratios, music: i.music });
          return r;
        },
        judge: (r) => critique({ rendered: r, screens: i.screens.screens, language: i.language, hasIcon: Boolean(kit.icon), appName: i.appName, kitBrief: brief, vision: i.vision, warned: Boolean(i.screens.warning) }),
        direct: async (fixes, prev) => (await directShots({ ...dirIn, fixes, previous: prev }, i.vision)).shots,
        log: i.log,
      });
      if (!loop.ok) {
        out.dropped.push(`${t.label}: ${loop.reason}`);
        i.log?.(`Dropped a ${t.label} variant: ${loop.reason}`);
        continue;
      }
      out.variants.push({ template: choice.template, templateWhy: choice.why, shots: loop.shots, critique: loop.critique, rounds: loop.rounds, ...(await storeRendered(i, loop.rendered, name)) });
    }
    if (out.variants.some((v) => Object.keys(v.slides).length)) {
      out.screens = [];
      for (const [k, sc] of i.screens.screens.entries()) {
        const copy = join(dir, `screen-${k}${sc.file.match(/\.(png|jpe?g)$/i)?.[0] ?? ".png"}`);
        copyFileSync(sc.file, copy);
        const a = await i.store.put(copy, { appId: i.appId, purpose: `${i.tag}:screens`, label: `Screen ${k + 1}`, kind: "image", ratio: "9:16", width: sc.width, height: sc.height, mime: /\.png$/i.test(copy) ? "image/png" : "image/jpeg", source: "screenshot", aiGenerated: false, aiPerson: false });
        out.screens.push({ id: a.id, width: sc.width, height: sc.height, language: sc.language, statusBar: sc.statusBar ?? 0, name: sc.name ?? `screen-${k + 1}`, source: sc.source });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

async function storeRendered(i: StudioInput, r: Rendered, name: string): Promise<Pick<StudioVariant, "video" | "cover" | "slides">> {
  const base = { appId: i.appId, purpose: i.tag, aiGenerated: false, aiPerson: false, source: "motion_template" as const };
  let cover: StoredAsset | null = null;
  let video: StoredAsset | null = null;
  if (r.video) {
    cover = await i.store.put(r.video.cover, { ...base, label: `Cover · ${TEMPLATES[r.template].label}`, kind: "image", ratio: "9:16", width: 1080, height: 1920, mime: "image/jpeg" });
    video = await i.store.put(r.video.file, { ...base, label: `${TEMPLATES[r.template].label} video`, kind: "video", ratio: "9:16", width: 1080, height: 1920, mime: "video/mp4", durationSec: r.video.seconds, thumbnailId: cover.id });
  }
  const slides: StudioVariant["slides"] = {};
  for (const s of r.slides) {
    const list: StoredAsset[] = [];
    for (const [k, f] of s.files.entries()) list.push(await i.store.put(f, { ...base, label: `${TEMPLATES[r.template].label} slide ${k + 1} (${s.ratio})`, kind: "image", ratio: s.ratio, width: 1080, height: s.ratio === "4:5" ? 1350 : 1080, mime: "image/jpeg" }));
    slides[s.ratio] = list;
  }
  void name;
  return { video, cover, slides };
}
