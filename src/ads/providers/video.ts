import { poll, request, type RequestInit2 } from "../http";
import { PlatformError, type PlatformDeps, type PlatformId } from "../types";

/**
 * The contract between day2's ad pipeline and each generative video
 * provider (./creatify.ts, ./runway.ts). A provider turns one VideoJob into
 * one finished video URL (hosted by the provider, often short-lived: the
 * caller downloads it and stores it as a day2 Asset).
 */

export type VideoJob = {
  kind: "avatar_ad" | "link_to_video" | "image_to_video";
  ratio: "9:16" | "1:1" | "16:9";
  /** Wanted length; providers snap to the nearest length they support. */
  durationSec: number;
  /** Words to be spoken (avatar_ad: required; link_to_video: overrides the generated script). */
  script?: string;
  /** Live URL of the app (link_to_video). */
  link?: string;
  /** First frame (image_to_video): https URL or data: URI. */
  imageUrl?: string;
  /** image_to_video: the motion prompt. link_to_video: the target audience. */
  prompt?: string;
  /** ISO 639-1, e.g. "de". */
  language?: string;
  appName: string;
};

export type VideoResult = {
  /** Final mp4, hosted by the provider. Download promptly: URLs can expire. */
  url: string;
  durationSec?: number;
  thumbnailUrl?: string;
  /** Shows an AI-generated person (needs disclosure in some markets). */
  aiPerson: boolean;
  /** What this generation actually cost day2. */
  costUsd: number;
  providerJobId: string;
};

export type VideoProviderId = "creatify" | "runway";

export interface VideoProvider {
  id: VideoProviderId;
  kinds: VideoJob["kind"][];
  /** Expected cost before generating (for budgeting / credit checks). */
  estimateUsd(job: VideoJob): number;
  generate(job: VideoJob): Promise<VideoResult>;
}

export type VideoProviderDeps = Pick<PlatformDeps, "fetch" | "sleep"> & {
  /** Delay between status polls. */
  pollEveryMs?: number;
  /** Give up waiting for a render after this long. */
  timeoutMs?: number;
};

export class ProviderError extends Error {
  constructor(
    public provider: VideoProviderId,
    message: string,
    public status?: number,
    /** Worth retrying later (rate limits, outages, transient render failures). */
    public retryable = false,
  ) {
    super(`${provider}: ${message}`);
    this.name = "ProviderError";
  }
}

/** PlatformError (from ../http) → ProviderError, keeping status and retryability. */
function toProviderError(provider: VideoProviderId, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof PlatformError) {
    const msg = err.message.startsWith(`${provider}: `) ? err.message.slice(provider.length + 2) : err.message;
    return new ProviderError(provider, msg, err.status, err.retryable);
  }
  return new ProviderError(provider, (err as Error)?.message ?? String(err));
}

/**
 * JSON request via ../http (retries 429/5xx with Retry-After), errors as
 * ProviderError. ../http is typed for ad platforms; the id is only used to
 * prefix error messages, which we re-wrap here.
 */
export async function providerRequest<T>(provider: VideoProviderId, deps: VideoProviderDeps, url: string, init: RequestInit2 = {}): Promise<T> {
  try {
    return await request<T>(provider as unknown as PlatformId, deps, url, init);
  } catch (err) {
    throw toProviderError(provider, err);
  }
}

/** Polls until `check` returns a value; timeouts become retryable ProviderErrors. */
export async function providerPoll<T>(provider: VideoProviderId, deps: VideoProviderDeps, check: () => Promise<T | undefined>, what: string, defaults: { everyMs: number; timeoutMs: number }): Promise<T> {
  try {
    return await poll(deps, check, { everyMs: deps.pollEveryMs ?? defaults.everyMs, timeoutMs: deps.timeoutMs ?? defaults.timeoutMs, what, platform: provider as unknown as PlatformId });
  } catch (err) {
    throw toProviderError(provider, err);
  }
}

/** Parses a positive number from env, else the fallback. */
export function envNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Rounds USD to a tenth of a cent. */
export function usd(n: number): number {
  return Math.round(n * 1000) / 1000;
}
