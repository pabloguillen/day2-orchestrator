import { checkKey, envNum, ProviderError, providerRequest, usd } from "../http";
import type { CreatorClient, CreativeJob, ToolCreds, ToolDef, ToolDeps } from "../types";

/**
 * OpenAI Images (https://developers.openai.com/api/reference/resources/images/methods/generate)
 * — still images: the background scene of image posts, thumbnails.
 *
 *   POST /v1/images/generations {model, prompt, size, quality, output_format, moderation: "auto"}
 *        → {data: [{b64_json}], usage?: {input_tokens, output_tokens}}
 *   GET  /v1/models → the key check
 *
 * Auth: Bearer. GPT image models only return base64 (no URLs). gpt-image-1
 * was shut down on 23 Oct 2026; the default is gpt-image-2. Pricing
 * (developers.openai.com/api/docs/pricing, Nov 2026) is per token: image
 * output $15 / 1M, image input $4 / 1M, text input $2.50 / 1M — a medium
 * 1024×1536 image comes to a few cents (estimate: OPENAI_IMAGE_USD_PER_IMAGE).
 */

export const OPENAI_BASE = "https://api.openai.com";
const DEFAULT_USD_PER_IMAGE = 0.06;
const SIZE: Record<string, string> = { "9:16": "1024x1536", "4:5": "1024x1536", "1:1": "1024x1024", "16:9": "1536x1024" };

function estimate(c: ToolCreds, job: CreativeJob): number {
  return job.capability === "image" ? usd(envNum(c.usdPerImage, DEFAULT_USD_PER_IMAGE)) : 0;
}

export function openaiImagesClient(c: ToolCreds, deps: ToolDeps = {}): CreatorClient {
  const base = (c.baseUrl ?? OPENAI_BASE).replace(/\/$/, "");
  return {
    estimateUsd: (job) => estimate(c, job),
    async generate(job) {
      if (job.capability !== "image") throw new ProviderError("openai_images", `can't make ${job.capability}`);
      const r = await providerRequest<{ data?: Array<{ b64_json?: string }>; usage?: { input_tokens?: number; output_tokens?: number } }>("openai_images", deps, `${base}/v1/images/generations`, {
        method: "POST",
        headers: { authorization: `Bearer ${c.apiKey}` },
        json: { model: c.model || "gpt-image-2", prompt: job.prompt.slice(0, 32_000), size: SIZE[job.ratio] ?? "1024x1536", quality: c.quality || "medium", output_format: "jpeg", moderation: "auto", n: 1 },
        retries: 1,
      });
      const b64 = r?.data?.[0]?.b64_json;
      if (!b64) throw new ProviderError("openai_images", "the answer had no image");
      const u = r?.usage;
      const fromUsage = u?.output_tokens ? usd((u.output_tokens * 15 + (u.input_tokens ?? 0) * 4) / 1_000_000) : null;
      return { bytes: new Uint8Array(Buffer.from(b64, "base64")), mime: "image/jpeg", aiPerson: false, costUsd: fromUsage ?? estimate(c, job), providerJobId: `img-${Date.now().toString(36)}` };
    },
  };
}

export const OPENAI_IMAGES: ToolDef = {
  id: "openai_images",
  name: "OpenAI Images",
  oneLine: "Still images in the app's colours: backgrounds for image posts and thumbnails (never fake app screens).",
  capabilities: ["image"],
  ratios: { image: ["9:16", "4:5", "1:1", "16:9"] },
  fields: [{ key: "apiKey", label: "API key", secret: true, help: "platform.openai.com → API keys" }],
  env: { required: ["OPENAI_API_KEY"], optional: ["OPENAI_IMAGE_MODEL", "OPENAI_IMAGE_QUALITY", "OPENAI_IMAGE_USD_PER_IMAGE"] },
  docsUrl: "https://developers.openai.com/api/reference/resources/images/methods/generate",
  keyUrl: "https://platform.openai.com/api-keys",
  priceNote: "a few cents per image",
  sample: { capability: "image", prompt: "x", ratio: "4:5", appName: "app" },
  unverified: "Built from OpenAI's Images API reference and tested against fakes; not yet run against a real OpenAI account.",
  fromEnv(env) {
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) return null;
    return { apiKey, ...(env.OPENAI_IMAGE_MODEL?.trim() ? { model: env.OPENAI_IMAGE_MODEL.trim() } : {}), ...(env.OPENAI_IMAGE_QUALITY?.trim() ? { quality: env.OPENAI_IMAGE_QUALITY.trim() } : {}), ...(env.OPENAI_IMAGE_USD_PER_IMAGE?.trim() ? { usdPerImage: env.OPENAI_IMAGE_USD_PER_IMAGE.trim() } : {}) };
  },
  client: openaiImagesClient,
  verify: (c, deps = {}) => checkKey("openai_images", "OpenAI", deps, `${(c.baseUrl ?? OPENAI_BASE).replace(/\/$/, "")}/v1/models`, { headers: { authorization: `Bearer ${c.apiKey ?? ""}` } }),
};
