import { checkKey, dataUriParts, envNum, ProviderError, providerRequest, usd } from "../http";
import type { CreatorClient, CreativeJob, ToolCreds, ToolDef, ToolDeps } from "../types";

/**
 * Google video via the Gemini API (https://aistudio.google.com/docs/omni),
 * with a Gemini API key.
 *
 * Google shut the Veo 3.1 preview models on the Gemini API down on
 * 22 Oct 2026 (GA Veo is only on the Gemini Enterprise Agent Platform, with
 * Google Cloud credentials, not an API key). Their replacement on the Gemini
 * API is Gemini Omni Flash, called through the Interactions API:
 *
 *   POST /v1beta/interactions
 *        {model, input: [{type: "image", data, mime_type}, {type: "text", text}],
 *         response_format: {type: "video", aspect_ratio: "9:16" | "16:9"},
 *         background: false, store: false, stream: false}
 *        → the finished interaction; the video is a content part {type: "video", data: <base64>}
 *   GET  /v1beta/models → the key check
 *
 * Auth: x-goog-api-key. The call is synchronous ("unary"), so it waits for
 * the render; one attempt only (a retry after a timeout could pay twice).
 * Length is set in the prompt (no duration field). Pricing
 * (aistudio.google.com/docs/pricing, Nov 2026): $17.50 per 1M video output
 * tokens at 5,792 tokens per second of 720p ≈ $0.10 per second.
 * Images of minors and of recognizable people can't be used as input.
 */

export const GEMINI_BASE = "https://generativelanguage.googleapis.com";
export const GEMINI_VIDEO_MODEL = "gemini-omni-1.1-flash";
const USD_PER_SEC = 0.1014;
const MIN_SEC = 3;
const MAX_SEC = 10;

const seconds = (s: number) => Math.min(MAX_SEC, Math.max(MIN_SEC, Math.round(s || 6)));
function estimate(c: ToolCreds, job: CreativeJob): number {
  return job.capability === "generated_video" ? usd(seconds(job.durationSec) * envNum(c.usdPerSecond, USD_PER_SEC)) : 0;
}

/** Finds the first video part anywhere in the answer (steps[].content[] or output). Pure. */
export function findVideoPart(v: unknown, depth = 0): { data?: string; uri?: string; mime?: string } | null {
  if (!v || typeof v !== "object" || depth > 8) return null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const f = findVideoPart(x, depth + 1);
      if (f) return f;
    }
    return null;
  }
  const o = v as Record<string, unknown>;
  if (o.type === "video" && (typeof o.data === "string" || typeof o.uri === "string")) return { data: o.data as string | undefined, uri: o.uri as string | undefined, mime: (o.mime_type as string | undefined) ?? (o.mimeType as string | undefined) };
  for (const k of Object.keys(o)) {
    const f = findVideoPart(o[k], depth + 1);
    if (f) return f;
  }
  return null;
}

export function geminiVideoClient(c: ToolCreds, deps: ToolDeps = {}): CreatorClient {
  const base = (c.baseUrl ?? GEMINI_BASE).replace(/\/$/, "");
  const headers = { "x-goog-api-key": c.apiKey! };
  return {
    estimateUsd: (job) => estimate(c, job),
    async generate(job) {
      if (job.capability !== "generated_video") throw new ProviderError("gemini_video", `can't make ${job.capability}`);
      const sec = seconds(job.durationSec);
      const input: Array<Record<string, unknown>> = [];
      if (job.imageUrl) {
        const img = dataUriParts(job.imageUrl);
        if (!img) throw new ProviderError("gemini_video", "the first frame must be a data:image URI");
        input.push({ type: "image", data: img.base64, mime_type: img.mime });
      }
      input.push({ type: "text", text: `${job.prompt.trim().slice(0, 1500)}\nOne continuous shot, about ${sec} seconds long. No people, no faces, no added text or logos.` });
      const r = await providerRequest<unknown>("gemini_video", deps, `${base}/v1beta/interactions`, {
        method: "POST",
        headers,
        json: { model: c.model || GEMINI_VIDEO_MODEL, input, response_format: { type: "video", aspect_ratio: job.ratio === "16:9" ? "16:9" : "9:16" }, background: false, store: false, stream: false },
        retries: 1,
      });
      const part = findVideoPart(r);
      if (!part?.data) throw new ProviderError("gemini_video", "the answer had no video");
      const id = (r as { id?: string; name?: string })?.id ?? (r as { name?: string })?.name ?? `omni-${Date.now().toString(36)}`;
      return { bytes: new Uint8Array(Buffer.from(part.data, "base64")), mime: part.mime ?? "video/mp4", durationSec: sec, aiPerson: false, costUsd: estimate(c, job), providerJobId: String(id) };
    },
  };
}

export const GEMINI_VIDEO: ToolDef = {
  id: "gemini_video",
  name: "Google (Gemini Omni)",
  oneLine: "Short generated clips from the app's real screen with Google's video model (Gemini API key).",
  capabilities: ["generated_video"],
  ratios: { generated_video: ["9:16", "16:9"] },
  fields: [{ key: "apiKey", label: "Gemini API key", secret: true, help: "aistudio.google.com → Get API key" }],
  env: { required: ["GEMINI_API_KEY"], optional: ["GEMINI_VIDEO_MODEL", "GEMINI_VIDEO_USD_PER_SECOND"] },
  docsUrl: "https://aistudio.google.com/docs/omni",
  keyUrl: "https://aistudio.google.com/apikey",
  priceNote: "about $0.10 per second of 720p video",
  sample: { capability: "generated_video", prompt: "x", ratio: "9:16", durationSec: 6, appName: "app" },
  unverified: "Built from the Gemini API's Omni docs (which still described gemini-omni-1.1-flash) and tested against fakes; not yet run against a real Gemini API key. Veo itself is no longer offered on the Gemini API.",
  fromEnv(env) {
    const apiKey = env.GEMINI_API_KEY?.trim();
    if (!apiKey) return null;
    return { apiKey, ...(env.GEMINI_VIDEO_MODEL?.trim() ? { model: env.GEMINI_VIDEO_MODEL.trim() } : {}), ...(env.GEMINI_VIDEO_USD_PER_SECOND?.trim() ? { usdPerSecond: env.GEMINI_VIDEO_USD_PER_SECOND.trim() } : {}) };
  },
  client: geminiVideoClient,
  verify: (c, deps = {}) => checkKey("gemini_video", "Google", deps, `${(c.baseUrl ?? GEMINI_BASE).replace(/\/$/, "")}/v1beta/models`, { headers: { "x-goog-api-key": c.apiKey ?? "" }, query: { pageSize: 1 } }),
};
