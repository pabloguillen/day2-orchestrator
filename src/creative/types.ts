import type { VideoProviderDeps } from "../ads/providers/video";

/**
 * Creator tools (docs/creator-tools.md): outside services that make media
 * for posts and ads — presenter videos, generated clips, still images,
 * voiceovers, music. Each tool declares what it can make, in which formats,
 * what it costs, the key it needs and how day2 checks that key. day2 uses
 * either its own account (operator env keys; billed to the customer in
 * credits) or the owner's own account (their API key, stored encrypted;
 * billed by the tool, no credits).
 */

export const CAPABILITIES = ["presenter_video", "generated_video", "image", "voice", "music"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_LABEL: Record<Capability, string> = {
  presenter_video: "Presenter videos",
  generated_video: "Generated video clips",
  image: "Images",
  voice: "Voiceovers",
  music: "Music",
};

export const TOOL_IDS = ["runway", "creatify", "heygen", "elevenlabs", "gemini_video", "luma", "openai_images"] as const;
export type ToolId = (typeof TOOL_IDS)[number];
export const isToolId = (v: unknown): v is ToolId => typeof v === "string" && (TOOL_IDS as readonly string[]).includes(v);

export type CreativeRatio = "9:16" | "1:1" | "16:9" | "4:5";

/** A talking presenter (a stock avatar, or the owner's own likeness with consent) reading a script. */
export type PresenterJob = { capability: "presenter_video"; script: string; ratio: CreativeRatio; language?: string; appName: string };
/** A short clip from a prompt, usually starting from the app's real screen (`imageUrl`: https or data:image). */
export type GeneratedVideoJob = { capability: "generated_video"; prompt: string; ratio: CreativeRatio; durationSec: number; imageUrl?: string; appName: string };
/**
 * A still image (background scene, thumbnail) — never text, logos or people.
 * `fictional_person`: a profile photo of an invented adult for an app's demo
 * cast (creative/demo-cast) — the only kind of person day2 ever asks for;
 * always marked as an AI-generated person.
 */
export type ImageJob = { capability: "image"; prompt: string; ratio: CreativeRatio; appName: string; subject?: "scene" | "fictional_person" };
export type VoiceJob = { capability: "voice"; text: string; language?: string };
export type MusicJob = { capability: "music"; prompt: string; durationSec: number };
export type CreativeJob = PresenterJob | GeneratedVideoJob | ImageJob | VoiceJob | MusicJob;

/** What a tool returned: a (usually short-lived) URL or the bytes. */
export type CreativeOutput = {
  url?: string;
  bytes?: Uint8Array;
  mime: string;
  durationSec?: number;
  /** Shows an AI-generated person. */
  aiPerson: boolean;
  /** What the call cost on the account that made it. */
  costUsd: number;
  providerJobId: string;
};

export interface CreatorClient {
  estimateUsd(job: CreativeJob): number;
  generate(job: CreativeJob): Promise<CreativeOutput>;
}

/** Credentials and options, by field key (see ToolDef.fields). */
export type ToolCreds = Record<string, string>;

export type CredentialField = {
  key: string;
  label: string;
  /** Never shown again once saved. */
  secret: boolean;
  optional?: boolean;
  help?: string;
  /**
   * A field that picks a person's face or voice (your own avatar or cloned
   * voice): only accepted with the consent checkbox.
   */
  likeness?: "avatar" | "voice";
};

export type ToolDeps = VideoProviderDeps;

export type ToolDef = {
  id: ToolId;
  name: string;
  /** What it does for posts and ads, in one line. */
  oneLine: string;
  capabilities: Capability[];
  /** Formats per capability; others are padded/cropped from the closest one by day2. */
  ratios: Partial<Record<Capability, CreativeRatio[]>>;
  /** Capabilities that need a first-frame image (the app's real screen). */
  needsImage?: Capability[];
  fields: CredentialField[];
  /** Operator env names: the first `required` must all be set for day2's account. */
  env: { required: string[]; optional: string[]; gate?: { name: string; value: string } };
  docsUrl: string;
  /** Where an owner/operator gets a key. */
  keyUrl: string;
  /** Plain-words price, for the console ("about $0.50 per 5-second clip"). */
  priceNote: string;
  /** A typical job, for the estimate shown before use. */
  sample: CreativeJob;
  /** Everything here is built from the tool's public docs and tested against fakes; marked until run against a real account. */
  unverified: string;
  fromEnv(env: Record<string, string | undefined>): ToolCreds | null;
  client(creds: ToolCreds, deps?: ToolDeps): CreatorClient;
  /** A cheap call that proves the key works (no generation). Throws KeyCheckError. */
  verify(creds: ToolCreds, deps?: ToolDeps): Promise<void>;
};

/** Why a key check failed — `rejected` = the tool said the key is wrong. */
export class KeyCheckError extends Error {
  constructor(
    message: string,
    public rejected: boolean,
  ) {
    super(message);
    this.name = "KeyCheckError";
  }
}

/** Whose account made something. */
export type AccountKind = "own" | "day2";

/** What a post or ad asset was made with (shown as "Made with Runway"). */
export type MadeWith = { tool: ToolId; name: string; capability: Capability; account: AccountKind };
