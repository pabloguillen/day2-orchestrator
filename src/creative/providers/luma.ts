import { checkKey, dataUriParts, envNum, ProviderError, providerPoll, providerRequest, usd } from "../http";
import type { CreatorClient, CreativeJob, ToolCreds, ToolDef, ToolDeps } from "../types";

/**
 * Luma (https://docs.agents.lumalabs.ai) — generated video clips (Ray).
 *
 *   POST /v1/generations {type: "video", model: "ray-3.2", prompt, aspect_ratio,
 *                         video: {resolution, duration: "5s" | "10s", start_frame: {url} | {data}}}
 *        → Generation {id, state}
 *   GET  /v1/generations/{id} → {state: queued|processing|completed|failed, output: [{type, url}], failure_reason, usage: {credits_charged}}
 *   GET  /v1/credits → the balance (the key check)
 *
 * Base https://agents.lumalabs.ai, Authorization: Bearer <luma-api-…>.
 * (The older dream-machine/v1 API isn't used.) Pricing
 * (docs.agents.lumalabs.ai/guides/pricing, Nov 2026), credits per clip:
 * 540p 50 / 150, 720p 100 / 300, 1080p 400 / 1,200 (5 s / 10 s). The USD
 * value of a credit depends on the plan: set LUMA_USD_PER_CREDIT.
 * Output URLs expire after an hour: download right away.
 */

export const LUMA_BASE = "https://agents.lumalabs.ai";
const CREDITS: Record<string, { 5: number; 10: number }> = { "540p": { 5: 50, 10: 150 }, "720p": { 5: 100, 10: 300 }, "1080p": { 5: 400, 10: 1200 } };
/** A guess until the plan is known; LUMA_USD_PER_CREDIT overrides it. */
export const LUMA_DEFAULT_USD_PER_CREDIT = 0.01;
const PENDING = new Set(["queued", "processing", "dreaming"]);

type Gen = { id?: string; state?: string; output?: Array<{ type?: string; url?: string }>; failure_reason?: string | null; failure_code?: string | null; usage?: { credits_charged?: number } };

const dur = (s: number): 5 | 10 => ((s || 5) > 7 ? 10 : 5);
const resOf = (c: ToolCreds) => (c.resolution && CREDITS[c.resolution] ? c.resolution : "720p");
const perCredit = (c: ToolCreds) => envNum(c.usdPerCredit, LUMA_DEFAULT_USD_PER_CREDIT);
function estimate(c: ToolCreds, job: CreativeJob): number {
  return job.capability === "generated_video" ? usd(CREDITS[resOf(c)]![dur(job.durationSec)] * perCredit(c)) : 0;
}

export function lumaClient(c: ToolCreds, deps: ToolDeps = {}): CreatorClient {
  const base = (c.baseUrl ?? LUMA_BASE).replace(/\/$/, "");
  const headers = { authorization: `Bearer ${c.apiKey}`, accept: "application/json" };
  return {
    estimateUsd: (job) => estimate(c, job),
    async generate(job) {
      if (job.capability !== "generated_video") throw new ProviderError("luma", `can't make ${job.capability}`);
      const video: Record<string, unknown> = { resolution: resOf(c), duration: `${dur(job.durationSec)}s` };
      if (job.imageUrl) {
        const d = dataUriParts(job.imageUrl);
        video.start_frame = d ? { data: d.base64 } : /^https:\/\//i.test(job.imageUrl) ? { url: job.imageUrl } : null;
        if (!video.start_frame) throw new ProviderError("luma", "the first frame must be an https URL or a data:image URI");
      }
      const created = await providerRequest<Gen>("luma", deps, `${base}/v1/generations`, { method: "POST", headers, json: { type: "video", model: c.model || "ray-3.2", prompt: job.prompt.slice(0, 6000), aspect_ratio: job.ratio, video }, retries: 2 });
      if (!created?.id) throw new ProviderError("luma", "generation returned no id");
      const done = await providerPoll(
        "luma",
        deps,
        async () => {
          const g = await providerRequest<Gen>("luma", deps, `${base}/v1/generations/${encodeURIComponent(created.id!)}`, { headers });
          const state = String(g?.state ?? "");
          if (PENDING.has(state)) return undefined;
          if (state === "completed") return g;
          if (state === "failed") throw new ProviderError("luma", `generation ${created.id} failed: ${g.failure_reason ?? "no reason given"}`, undefined, /internal|timeout|capacity/i.test(g.failure_code ?? ""));
          throw new ProviderError("luma", `generation ${created.id} has unknown state "${state}"`);
        },
        `generation ${created.id}`,
        { everyMs: 10_000, timeoutMs: 15 * 60_000 },
      );
      const url = done.output?.find((o) => !o.type || o.type === "video")?.url ?? done.output?.[0]?.url;
      if (!url) throw new ProviderError("luma", `generation ${created.id} completed without output`);
      const credits = done.usage?.credits_charged ?? CREDITS[resOf(c)]![dur(job.durationSec)];
      return { url, mime: "video/mp4", durationSec: dur(job.durationSec), aiPerson: false, costUsd: usd(credits * perCredit(c)), providerJobId: created.id };
    },
  };
}

export const LUMA: ToolDef = {
  id: "luma",
  name: "Luma",
  oneLine: "Generated video clips (Ray) from the app's real screen: product b-roll for Reels and TikTok.",
  capabilities: ["generated_video"],
  ratios: { generated_video: ["9:16", "1:1", "16:9"] },
  fields: [{ key: "apiKey", label: "API key", secret: true, help: "platform.lumalabs.ai → API keys (starts with luma-api-)" }],
  env: { required: ["LUMA_API_KEY"], optional: ["LUMA_MODEL", "LUMA_RESOLUTION", "LUMA_USD_PER_CREDIT"] },
  docsUrl: "https://docs.agents.lumalabs.ai/api/resources/generations/methods/create",
  keyUrl: "https://platform.lumalabs.ai",
  priceNote: "100 Luma credits per 5-second 720p clip",
  sample: { capability: "generated_video", prompt: "x", ratio: "9:16", durationSec: 5, appName: "app" },
  unverified: "Built from Luma's Agents API reference and tested against fakes; not yet run against a real Luma account. The dollar value of a Luma credit is an assumption until LUMA_USD_PER_CREDIT is set.",
  fromEnv(env) {
    const apiKey = env.LUMA_API_KEY?.trim();
    if (!apiKey) return null;
    return { apiKey, ...(env.LUMA_MODEL?.trim() ? { model: env.LUMA_MODEL.trim() } : {}), ...(env.LUMA_RESOLUTION?.trim() ? { resolution: env.LUMA_RESOLUTION.trim() } : {}), ...(env.LUMA_USD_PER_CREDIT?.trim() ? { usdPerCredit: env.LUMA_USD_PER_CREDIT.trim() } : {}) };
  },
  client: lumaClient,
  verify: (c, deps = {}) => checkKey("luma", "Luma", deps, `${(c.baseUrl ?? LUMA_BASE).replace(/\/$/, "")}/v1/credits`, { headers: { authorization: `Bearer ${c.apiKey ?? ""}` } }),
};
