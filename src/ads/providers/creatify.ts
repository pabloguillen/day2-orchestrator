import { envNumber, ProviderError, providerPoll, providerRequest, usd, type VideoJob, type VideoProvider, type VideoProviderDeps, type VideoResult } from "./video";

/**
 * Creatify (https://docs.creatify.ai) — AI ad videos for day2's app ads.
 *
 *   link_to_video: POST /api/links/ {url}  (scrapes the app's page, 1 credit)
 *                  → POST /api/link_to_videos/ {link, aspect_ratio, video_length, language, target_audience, script_style, visual_style, override_avatar?, override_script?}
 *                    (creating the video starts the job; the separate /render/ endpoint is only for the preview flow, which we don't use)
 *                  → GET /api/link_to_videos/{id}/ until status "done" → video_output
 *   avatar_ad:     POST /api/lipsyncs/ {text, creator, accent?, aspect_ratio, no_caption, no_music}
 *                  → GET /api/lipsyncs/{id}/ until status "done" → output
 *
 * Auth: X-API-ID + X-API-KEY headers (app.creatify.ai → account → Show API Keys).
 * Status values (docs): pending, in_queue, running, done, failed, rejected.
 * Pricing (docs.creatify.ai/billing, Oct 2026): links 1 credit; URL-to-video and
 * AI Avatar on the `standard` model 5 credits per started 30 s. API Starter is
 * $99 / 500 credits ($0.198/credit), API Pro $299 / 2,000 ($0.15/credit).
 */

export const CREATIFY_BASE = "https://api.creatify.ai";

/** API Starter plan: $99 for 500 credits. Set CREATIFY_USD_PER_CREDIT for your plan (Pro: 0.1495). */
export const CREATIFY_DEFAULT_USD_PER_CREDIT = 0.198;

export type CreatifyCreds = {
  apiId: string;
  apiKey: string;
  usdPerCredit: number;
  /** Persona (stock AI avatar) id from GET /api/personas/. Picked automatically when unset. */
  avatarId?: string;
  /** Voice ("accent") id from GET /api/voices/. Creatify's default for the avatar when unset. */
  voiceId?: string;
  /** link_to_video script style (default "DiscoveryWriter", Creatify's default). */
  scriptStyle?: string;
  /** link_to_video visual style; must be an avatar template (default "AvatarBubbleTemplate"). */
  visualStyle?: string;
  baseUrl?: string;
};

export function creatifyFromEnv(env: Record<string, string | undefined>): CreatifyCreds | null {
  const apiId = env.CREATIFY_API_ID?.trim();
  const apiKey = env.CREATIFY_API_KEY?.trim();
  if (!apiId || !apiKey) return null;
  return {
    apiId,
    apiKey,
    usdPerCredit: envNumber(env.CREATIFY_USD_PER_CREDIT, CREATIFY_DEFAULT_USD_PER_CREDIT),
    avatarId: env.CREATIFY_AVATAR_ID?.trim() || undefined,
    voiceId: env.CREATIFY_VOICE_ID?.trim() || undefined,
    scriptStyle: env.CREATIFY_SCRIPT_STYLE?.trim() || undefined,
    visualStyle: env.CREATIFY_VISUAL_STYLE?.trim() || undefined,
  };
}

/** Lengths link_to_videos accepts. */
const LINK_VIDEO_LENGTHS = [15, 30, 45, 60] as const;
/** Spoken words per second used to size an avatar read before it exists. */
const WORDS_PER_SEC = 2.5;
const LINK_CREDITS = 1;
const STANDARD_CREDITS_PER_30S = 5;
const MAX_LIPSYNC_TEXT = 8000;
const PENDING = new Set(["pending", "in_queue", "running"]);
const FAILED = new Set(["failed", "rejected"]);

type CreatifyLink = { id: string; url: string; credits_used?: number; link?: { id?: string; title?: string | null } };
type CreatifyJob = {
  id: string;
  status: string;
  progress?: string | number | null;
  failed_reason?: string | null;
  credits_used?: number | null;
  duration?: number | null;
  video_thumbnail?: string | null;
  /** link_to_videos */
  video_output?: string | null;
  /** lipsyncs */
  output?: string | null;
};
type CreatifyPersona = { id: string; is_active?: boolean; style?: string; creator_name?: string };

const aspect = (r: VideoJob["ratio"]) => r.replace(":", "x");

function linkVideoLength(sec: number): number {
  return LINK_VIDEO_LENGTHS.find((l) => l >= sec) ?? 60;
}

function scriptSeconds(job: VideoJob): number {
  const words = job.script?.trim().split(/\s+/).filter(Boolean).length ?? 0;
  return Math.max(1, words ? Math.ceil(words / WORDS_PER_SEC) : job.durationSec);
}

function standardCredits(sec: number): number {
  return STANDARD_CREDITS_PER_30S * Math.max(1, Math.ceil(sec / 30));
}

export function createCreatify(creds: CreatifyCreds, deps: VideoProviderDeps = {}): VideoProvider {
  const base = (creds.baseUrl ?? CREATIFY_BASE).replace(/\/$/, "");
  const headers = { "X-API-ID": creds.apiId, "X-API-KEY": creds.apiKey, accept: "application/json" };
  const api = <T>(method: "GET" | "POST", path: string, json?: unknown, query?: Record<string, string | undefined>) =>
    providerRequest<T>("creatify", deps, `${base}${path}`, { method, headers, json, query });
  let personaCache: string | undefined = creds.avatarId;

  async function avatarId(): Promise<string> {
    if (personaCache) return personaCache;
    const list = await api<CreatifyPersona[] | { results?: CreatifyPersona[] }>("GET", "/api/personas/", undefined, { style: "presenter" });
    const items = Array.isArray(list) ? list : (list?.results ?? []);
    const pick = items.find((p) => p.is_active !== false && p.id);
    if (!pick) throw new ProviderError("creatify", "no active stock avatar found (set CREATIFY_AVATAR_ID)");
    personaCache = pick.id;
    return pick.id;
  }

  async function waitFor(path: string, what: string): Promise<CreatifyJob> {
    return providerPoll(
      "creatify",
      deps,
      async () => {
        const j = await api<CreatifyJob>("GET", path);
        return settled(j);
      },
      what,
      { everyMs: 10_000, timeoutMs: 30 * 60_000 },
    );
  }

  /** Returns the job when finished, undefined while running; throws on failure. */
  function settled(j: CreatifyJob): CreatifyJob | undefined {
    const status = String(j?.status ?? "").toLowerCase();
    if (PENDING.has(status)) return undefined;
    if (FAILED.has(status)) {
      // "rejected" is a content decision; "failed" may be a transient render error.
      throw new ProviderError("creatify", `job ${j.id} ${status}: ${j.failed_reason || "no reason given"}`, undefined, status === "failed");
    }
    if (status === "done") return j;
    throw new ProviderError("creatify", `job ${j?.id} has unknown status "${j?.status}"`);
  }

  function result(j: CreatifyJob, url: string | null | undefined, extraCredits: number, estimateCredits: number): VideoResult {
    if (!url) throw new ProviderError("creatify", `job ${j.id} is done but has no video URL`);
    const reported = typeof j.credits_used === "number" && j.credits_used > 0 ? j.credits_used : estimateCredits;
    return {
      url,
      durationSec: j.duration ?? undefined,
      thumbnailUrl: j.video_thumbnail ?? undefined,
      aiPerson: true,
      costUsd: usd((reported + extraCredits) * creds.usdPerCredit),
      providerJobId: j.id,
    };
  }

  async function linkToVideo(job: VideoJob): Promise<VideoResult> {
    if (!job.link || !/^https?:\/\//i.test(job.link)) throw new ProviderError("creatify", "link_to_video needs an http(s) link");
    const length = linkVideoLength(job.durationSec);
    const link = await api<CreatifyLink>("POST", "/api/links/", { url: job.link });
    if (!link?.id) throw new ProviderError("creatify", "link creation returned no id");
    const linkCredits = typeof link.credits_used === "number" ? link.credits_used : LINK_CREDITS;
    const body: Record<string, unknown> = {
      name: `day2 ${job.appName}`.slice(0, 255),
      link: link.id,
      aspect_ratio: aspect(job.ratio),
      video_length: length,
      language: job.language ?? "en",
      target_audience: job.prompt?.trim() || "people who would love this app",
      script_style: creds.scriptStyle ?? "DiscoveryWriter",
      visual_style: creds.visualStyle ?? "AvatarBubbleTemplate",
    };
    if (creds.avatarId) body.override_avatar = creds.avatarId;
    if (creds.voiceId) body.override_voice = creds.voiceId;
    if (job.script?.trim()) body.override_script = job.script.trim();
    const created = await api<CreatifyJob>("POST", "/api/link_to_videos/", body);
    if (!created?.id) throw new ProviderError("creatify", "link_to_videos returned no id");
    const done = settled(created) ?? (await waitFor(`/api/link_to_videos/${created.id}/`, `link_to_video ${created.id}`));
    return result(done, done.video_output, linkCredits, standardCredits(length));
  }

  async function avatarAd(job: VideoJob): Promise<VideoResult> {
    const text = job.script?.trim();
    if (!text) throw new ProviderError("creatify", "avatar_ad needs a script");
    if (text.length > MAX_LIPSYNC_TEXT) throw new ProviderError("creatify", `script is ${text.length} chars (max ${MAX_LIPSYNC_TEXT})`);
    const body: Record<string, unknown> = {
      name: `day2 ${job.appName}`.slice(0, 255),
      text,
      creator: await avatarId(),
      aspect_ratio: aspect(job.ratio),
      no_caption: false,
      no_music: true,
    };
    if (creds.voiceId) body.accent = creds.voiceId;
    const created = await api<CreatifyJob>("POST", "/api/lipsyncs/", body);
    if (!created?.id) throw new ProviderError("creatify", "lipsyncs returned no id");
    const done = settled(created) ?? (await waitFor(`/api/lipsyncs/${created.id}/`, `avatar_ad ${created.id}`));
    return result(done, done.output, 0, standardCredits(scriptSeconds(job)));
  }

  return {
    id: "creatify",
    kinds: ["link_to_video", "avatar_ad"],
    estimateUsd(job) {
      if (job.kind === "link_to_video") return usd((LINK_CREDITS + standardCredits(linkVideoLength(job.durationSec))) * creds.usdPerCredit);
      if (job.kind === "avatar_ad") return usd(standardCredits(scriptSeconds(job)) * creds.usdPerCredit);
      return 0;
    },
    async generate(job) {
      if (job.kind === "link_to_video") return linkToVideo(job);
      if (job.kind === "avatar_ad") return avatarAd(job);
      throw new ProviderError("creatify", `unsupported job kind "${job.kind}"`);
    },
  };
}
