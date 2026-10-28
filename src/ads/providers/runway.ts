import { envNumber, ProviderError, providerPoll, providerRequest, usd, type VideoJob, type VideoProvider, type VideoProviderDeps, type VideoResult } from "./video";

/**
 * Runway developer API (https://docs.dev.runwayml.com) — short image-to-video
 * shots: an app screenshot (or rendered image) as the first frame plus a
 * motion prompt.
 *
 *   POST https://api.dev.runwayml.com/v1/image_to_video
 *        {model, promptImage: [{uri, position: "first"}], promptText, ratio, duration}
 *        → {id, estimatedCost: {credits}}
 *   GET  /v1/tasks/{id} (no more often than every 5 s)
 *        → status PENDING | THROTTLED | RUNNING | SUCCEEDED | FAILED | CANCELLED;
 *          SUCCEEDED has output: string[] and cost: {credits}; FAILED has failure + failureCode.
 *
 * Headers: Authorization: Bearer $RUNWAYML_API_SECRET, X-Runway-Version: 2024-11-06.
 * Shapes from Runway's official Node SDK (@runwayml/sdk 4.24.0) and the API guide.
 * Pricing (docs.dev.runwayml.com/guides/pricing, Oct 2026): $0.01 per credit;
 * gen4.5 12 credits/s, gen4_turbo 5 credits/s.
 * Output URLs are temporary: download them right away.
 */

export const RUNWAY_BASE = "https://api.dev.runwayml.com";
export const RUNWAY_VERSION = "2024-11-06";
export const RUNWAY_DEFAULT_USD_PER_CREDIT = 0.01;

export type RunwayModel = "gen4.5" | "gen4_turbo";

/** Credits per second of output. */
export const RUNWAY_CREDITS_PER_SEC: Record<RunwayModel, number> = { "gen4.5": 12, gen4_turbo: 5 };

export type RunwayCreds = {
  apiSecret: string;
  model: RunwayModel;
  usdPerCredit: number;
  baseUrl?: string;
};

export function runwayFromEnv(env: Record<string, string | undefined>): RunwayCreds | null {
  const apiSecret = env.RUNWAYML_API_SECRET?.trim();
  if (!apiSecret) return null;
  const m = env.RUNWAY_MODEL?.trim();
  if (m && !(m in RUNWAY_CREDITS_PER_SEC)) throw new ProviderError("runway", `RUNWAY_MODEL "${m}" is not supported (use ${Object.keys(RUNWAY_CREDITS_PER_SEC).join(" or ")})`);
  return {
    apiSecret,
    model: (m as RunwayModel | undefined) ?? "gen4.5",
    usdPerCredit: envNumber(env.RUNWAY_USD_PER_CREDIT, RUNWAY_DEFAULT_USD_PER_CREDIT),
  };
}

/** Output resolutions both models accept for our three ratios. */
const RATIOS: Record<VideoJob["ratio"], string> = { "9:16": "720:1280", "1:1": "960:960", "16:9": "1280:720" };
/** gen4.5: integer 2–10 s (SDK docs). gen4_turbo: the SDK gives no range; we keep the same one. */
const MIN_SEC = 2;
const MAX_SEC = 10;
const MAX_PROMPT = 1000;
const PENDING = new Set(["PENDING", "THROTTLED", "RUNNING"]);
const DEFAULT_PROMPT =
  "Smooth, slow camera push-in on the app screen. The interface stays sharp, legible and unchanged; subtle light sweep, polished product-ad feel.";

type RunwayCreated = { id: string; estimatedCost?: { credits?: number } };
type RunwayTask = {
  id: string;
  status: string;
  output?: string[];
  cost?: { credits?: number };
  estimatedCost?: { credits?: number };
  failure?: string;
  failureCode?: string;
  progress?: number;
};

const durationFor = (sec: number) => Math.min(MAX_SEC, Math.max(MIN_SEC, Math.round(sec || 5)));

export function createRunway(creds: RunwayCreds, deps: VideoProviderDeps = {}): VideoProvider {
  const base = (creds.baseUrl ?? RUNWAY_BASE).replace(/\/$/, "");
  const headers = { authorization: `Bearer ${creds.apiSecret}`, "X-Runway-Version": RUNWAY_VERSION, accept: "application/json" };
  const perSec = RUNWAY_CREDITS_PER_SEC[creds.model];

  async function imageToVideo(job: VideoJob): Promise<VideoResult> {
    const image = job.imageUrl?.trim();
    if (!image || !/^(https:\/\/|data:image\/)/i.test(image)) throw new ProviderError("runway", "image_to_video needs an https or data:image imageUrl");
    const duration = durationFor(job.durationSec);
    const promptText = (job.prompt?.trim() || DEFAULT_PROMPT).slice(0, MAX_PROMPT);
    const created = await providerRequest<RunwayCreated>("runway", deps, `${base}/v1/image_to_video`, {
      method: "POST",
      headers,
      json: { model: creds.model, promptImage: [{ uri: image, position: "first" }], promptText, ratio: RATIOS[job.ratio], duration },
    });
    if (!created?.id) throw new ProviderError("runway", "image_to_video returned no task id");

    const task = await providerPoll(
      "runway",
      deps,
      async () => {
        const t = await providerRequest<RunwayTask>("runway", deps, `${base}/v1/tasks/${created.id}`, { method: "GET", headers });
        const status = String(t?.status ?? "");
        if (PENDING.has(status)) return undefined;
        if (status === "SUCCEEDED") return t;
        if (status === "FAILED") {
          const code = t.failureCode ?? "";
          // Runway marks transient errors with INTERNAL.* codes; SAFETY.*, ASSET.* etc. won't succeed on retry.
          throw new ProviderError("runway", `task ${created.id} failed${code ? ` (${code})` : ""}: ${t.failure ?? "no reason given"}`, undefined, code.startsWith("INTERNAL"));
        }
        if (status === "CANCELLED") throw new ProviderError("runway", `task ${created.id} was cancelled`);
        throw new ProviderError("runway", `task ${created.id} has unknown status "${status}"`);
      },
      `image_to_video task ${created.id}`,
      { everyMs: 5_000, timeoutMs: 15 * 60_000 },
    );

    const url = task.output?.[0];
    if (!url) throw new ProviderError("runway", `task ${created.id} succeeded without output`);
    const credits = task.cost?.credits ?? created.estimatedCost?.credits ?? perSec * duration;
    return { url, durationSec: duration, aiPerson: false, costUsd: usd(credits * creds.usdPerCredit), providerJobId: created.id };
  }

  return {
    id: "runway",
    kinds: ["image_to_video"],
    estimateUsd(job) {
      return job.kind === "image_to_video" ? usd(perSec * durationFor(job.durationSec) * creds.usdPerCredit) : 0;
    },
    async generate(job) {
      if (job.kind !== "image_to_video") throw new ProviderError("runway", `unsupported job kind "${job.kind}"`);
      return imageToVideo(job);
    },
  };
}
