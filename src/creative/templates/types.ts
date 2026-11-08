import type { ResolvedKit } from "../brand-kit";
import type { Cue } from "../motion/audio";

/**
 * The template system (docs/creative-quality.md): an art director picks a
 * template and writes a shot list (data only — never code); a template turns
 * the shot list, the app's brand kit and its real screens into compositions
 * (a 9:16 video and/or still slides), which the engine renders.
 */

export const TEMPLATE_IDS = ["how-it-works", "feature-spotlight", "pov-hook", "problem-solution", "launch", "whats-new"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
export const isTemplateId = (v: unknown): v is TemplateId => typeof v === "string" && (TEMPLATE_IDS as readonly string[]).includes(v);

/** A region of a screen, as shares of its width and height (0..1). */
export type Region = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };

export type ShotStep = {
  /** ≤ 5 words, on screen big. */
  headline: string;
  /** The spoken-style line shown as word-by-word captions in videos and as the sub line on slides (≤ 12 words). */
  caption: string | null;
  /** Which screen (index into the screens). */
  screen: number;
  /** The part of the screen that matters: the camera zooms there, slides magnify it. */
  focus: Region | null;
  /** Where a tap happens (shares of the screen). */
  tap: Point | null;
  /** One of the app's own stickers (brand kit), by name. */
  sticker: string | null;
};

export type ShotList = {
  template: TemplateId;
  /** The first second: ≤ 6 words. */
  hook: string;
  /** A small line above the hook (chip), e.g. "So geht's". */
  kicker: string | null;
  steps: ShotStep[];
  /** problem-solution: the "before" moments (chat-bubble lines, ≤ 5). */
  problem: string[];
  /** pov-hook: the POV line over the b-roll. */
  pov: string | null;
  /** The button on the end card ("Link in Bio"). */
  cta: string;
  /** One line under the app's name on the end card. */
  endLine: string;
  /** whats-new: the version. */
  version: string | null;
  /** pov-hook: which b-roll clip (index), when there is one. */
  broll: number | null;
};

export type ScreenAsset = {
  file: string;
  width: number;
  height: number;
  /** The language of the screen's UI text, when known (null = unknown). */
  language: string | null;
  source: "capture" | "recording" | "store" | "web" | "mock" | "upload";
  name?: string;
  /** Share of the height the status bar takes (cropped off in cards). */
  statusBar?: number;
};

export type BrollAsset = { file: string; kind: "video" | "image"; durationSec?: number; label?: string };

export type RenderInput = { shots: ShotList; kit: ResolvedKit; screens: ScreenAsset[]; broll: BrollAsset[] };

export type Ratio = "9:16" | "4:5" | "1:1";
export const SIZES: Record<Ratio, { W: number; H: number }> = { "9:16": { W: 1080, H: 1920 }, "4:5": { W: 1080, H: 1350 }, "1:1": { W: 1080, H: 1080 } };

export type VideoComposition = {
  kind: "video";
  ratio: "9:16";
  W: number;
  H: number;
  seconds: number;
  html: string;
  cues: Cue[];
  /** Times the critique samples (first second, each step, end card). */
  sampleTimes: number[];
  /** b-roll video frames the page swaps per frame (pov-hook). */
  brollFrames?: { fps: number; count: number } | null;
};

export type SlideComposition = {
  kind: "slides";
  ratio: Ratio;
  W: number;
  H: number;
  /** One wide page; slide k is the window x ∈ [k·W, (k+1)·W) — elements may cross slides (panorama). */
  html: string;
  count: number;
};

export type TemplateDef = {
  id: TemplateId;
  label: string;
  /** For the console gallery and the art director. */
  description: string;
  bestFor: string;
  outputs: Array<"video" | "carousel" | "still">;
  minSteps: number;
  maxSteps: number;
  video?: (i: RenderInput) => VideoComposition;
  slides?: (i: RenderInput, ratio: Ratio) => SlideComposition;
};
