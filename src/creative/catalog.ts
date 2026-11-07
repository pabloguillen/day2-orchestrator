import { createCreatify, creatifyFromEnv, CREATIFY_BASE, CREATIFY_DEFAULT_USD_PER_CREDIT } from "../ads/providers/creatify";
import { createRunway, runwayFromEnv, RUNWAY_BASE, RUNWAY_DEFAULT_USD_PER_CREDIT, RUNWAY_VERSION, type RunwayModel } from "../ads/providers/runway";
import type { VideoJob, VideoProvider } from "../ads/providers/video";
import { checkKey, envNum, ProviderError } from "./http";
import { ELEVENLABS } from "./providers/elevenlabs";
import { GEMINI_VIDEO } from "./providers/gemini-video";
import { HEYGEN } from "./providers/heygen";
import { LUMA } from "./providers/luma";
import { OPENAI_IMAGES } from "./providers/openai-images";
import type { Capability, CreativeJob, CreativeRatio, CreatorClient, ToolCreds, ToolDef, ToolDeps, ToolId } from "./types";

/**
 * Every creator tool day2 can use (docs/creator-tools.md). Runway and
 * Creatify were day2's first two (src/ads/providers); they are wrapped here
 * so the registry treats all tools the same.
 *
 * Not added (docs/creator-tools.md "Not added"): Kling (its official API
 * docs only render as an app at kling.ai/document-api, which couldn't be
 * read and checked; auth is a self-signed JWT from an access/secret key
 * pair) and Ideogram (its v1 endpoint is marked legacy and the v2 reference
 * couldn't be read). Google Veo is no longer on the Gemini API; Google's
 * video is offered through Gemini Omni (providers/gemini-video.ts).
 */

const ratio3 = (r: CreativeRatio): VideoJob["ratio"] => (r === "4:5" ? "9:16" : r);

/** A VideoProvider (ads) as a creator client. */
function fromVideoProvider(p: VideoProvider): CreatorClient {
  const toJob = (job: CreativeJob): VideoJob => {
    if (job.capability === "presenter_video") return { kind: "avatar_ad", ratio: ratio3(job.ratio), durationSec: 30, script: job.script, language: job.language, appName: job.appName };
    if (job.capability === "generated_video") return { kind: "image_to_video", ratio: ratio3(job.ratio), durationSec: job.durationSec, imageUrl: job.imageUrl, prompt: job.prompt, appName: job.appName };
    throw new ProviderError(p.id, `can't make ${job.capability}`);
  };
  return {
    estimateUsd: (job) => (job.capability === "presenter_video" || job.capability === "generated_video" ? p.estimateUsd(toJob(job)) : 0),
    async generate(job) {
      const r = await p.generate(toJob(job));
      return { url: r.url, mime: "video/mp4", durationSec: r.durationSec, aiPerson: r.aiPerson, costUsd: r.costUsd, providerJobId: r.providerJobId };
    },
  };
}

const RUNWAY: ToolDef = {
  id: "runway",
  name: "Runway",
  oneLine: "Generated motion shots: the app's real screen comes alive for Reels, TikTok and video ads.",
  capabilities: ["generated_video"],
  ratios: { generated_video: ["9:16", "1:1", "16:9"] },
  needsImage: ["generated_video"],
  fields: [{ key: "apiSecret", label: "API key", secret: true, help: "dev.runwayml.com → API keys" }],
  env: { required: ["RUNWAYML_API_SECRET"], optional: ["RUNWAY_MODEL", "RUNWAY_USD_PER_CREDIT"], gate: { name: "DAY2_ADS_RUNWAY", value: "on" } },
  docsUrl: "https://docs.dev.runwayml.com",
  keyUrl: "https://dev.runwayml.com",
  priceNote: "about $0.60 per 5-second clip (gen4.5)",
  sample: { capability: "generated_video", prompt: "x", ratio: "9:16", durationSec: 5, appName: "app" },
  unverified: "Generation is built from Runway's API guide and SDK and tested against fakes. The key check (GET /v1/organization) is from the API reference's list of endpoints.",
  fromEnv(env) {
    if (env.DAY2_ADS_RUNWAY !== "on") return null;
    const r = runwayFromEnv(env);
    return r ? { apiSecret: r.apiSecret, model: r.model, usdPerCredit: String(r.usdPerCredit) } : null;
  },
  client: (c, deps) => fromVideoProvider(createRunway({ apiSecret: c.apiSecret!, model: (c.model as RunwayModel) || "gen4.5", usdPerCredit: envNum(c.usdPerCredit, RUNWAY_DEFAULT_USD_PER_CREDIT), baseUrl: c.baseUrl }, deps)),
  verify: (c, deps = {}) => checkKey("runway", "Runway", deps, `${(c.baseUrl ?? RUNWAY_BASE).replace(/\/$/, "")}/v1/organization`, { headers: { authorization: `Bearer ${c.apiSecret ?? ""}`, "X-Runway-Version": RUNWAY_VERSION } }),
};

const CREATIFY: ToolDef = {
  id: "creatify",
  name: "Creatify",
  oneLine: "Presenter videos: a stock AI presenter reads the script while the app is shown.",
  capabilities: ["presenter_video"],
  ratios: { presenter_video: ["9:16", "1:1", "16:9"] },
  fields: [
    { key: "apiId", label: "API ID", secret: true, help: "app.creatify.ai → account → Show API Keys" },
    { key: "apiKey", label: "API key", secret: true },
    { key: "avatarId", label: "Your own avatar ID (optional)", secret: false, optional: true, likeness: "avatar", help: "Leave empty to use a Creatify stock avatar." },
  ],
  env: { required: ["CREATIFY_API_ID", "CREATIFY_API_KEY"], optional: ["CREATIFY_USD_PER_CREDIT", "CREATIFY_AVATAR_ID", "CREATIFY_VOICE_ID", "CREATIFY_SCRIPT_STYLE", "CREATIFY_VISUAL_STYLE"] },
  docsUrl: "https://docs.creatify.ai",
  keyUrl: "https://app.creatify.ai",
  priceNote: "5 Creatify credits per 30 seconds (about $1 on the Starter API plan)",
  sample: { capability: "presenter_video", script: "x ".repeat(60), ratio: "9:16", appName: "app" },
  unverified: "Built from Creatify's API docs and tested against fakes; not yet run against a real Creatify account.",
  fromEnv(env) {
    const c = creatifyFromEnv(env);
    if (!c) return null;
    return Object.fromEntries(Object.entries({ apiId: c.apiId, apiKey: c.apiKey, usdPerCredit: String(c.usdPerCredit), avatarId: c.avatarId, voiceId: c.voiceId, scriptStyle: c.scriptStyle, visualStyle: c.visualStyle }).filter(([, v]) => v)) as ToolCreds;
  },
  client: (c, deps) => fromVideoProvider(createCreatify({ apiId: c.apiId!, apiKey: c.apiKey!, usdPerCredit: envNum(c.usdPerCredit, CREATIFY_DEFAULT_USD_PER_CREDIT), avatarId: c.avatarId || undefined, voiceId: c.voiceId || undefined, scriptStyle: c.scriptStyle || undefined, visualStyle: c.visualStyle || undefined, baseUrl: c.baseUrl }, deps)),
  verify: (c, deps = {}) => checkKey("creatify", "Creatify", deps, `${(c.baseUrl ?? CREATIFY_BASE).replace(/\/$/, "")}/api/personas/`, { headers: { "X-API-ID": c.apiId ?? "", "X-API-KEY": c.apiKey ?? "" } }),
};

export const TOOLS: ToolDef[] = [RUNWAY, CREATIFY, HEYGEN, LUMA, GEMINI_VIDEO, ELEVENLABS, OPENAI_IMAGES];
export const toolDef = (id: ToolId): ToolDef => TOOLS.find((t) => t.id === id)!;

/** Tools that day2's own account offered before creator tools existed: on by default when the operator set them up. */
export const DAY2_DEFAULT_ON: ToolId[] = ["runway", "creatify"];

/** day2's own account for each tool, from the operator's env. */
export function operatorCreds(env: Record<string, string | undefined> = process.env): Partial<Record<ToolId, ToolCreds>> {
  const out: Partial<Record<ToolId, ToolCreds>> = {};
  for (const t of TOOLS) {
    try {
      const c = t.fromEnv(env);
      if (c) out[t.id] = c;
    } catch {
      /* a bad optional setting: treat as not set up */
    }
  }
  return out;
}

/** The ratio a tool will actually make for a wanted one (day2 pads/crops the rest). Pure. */
export function nativeRatio(t: ToolDef, cap: Capability, want: CreativeRatio): CreativeRatio | null {
  const list = t.ratios[cap];
  if (!list) return cap === "voice" || cap === "music" ? want : null;
  if (list.includes(want)) return want;
  if (want === "4:5" && list.includes("9:16")) return "9:16";
  if (want === "1:1" && list.includes("9:16")) return "9:16";
  return list[0] ?? null;
}

export type { ToolDeps };
