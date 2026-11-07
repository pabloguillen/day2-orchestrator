import { randomBytes } from "node:crypto";
import { checkKey, envNum, ProviderError, providerPoll, providerRequest, secondsOfScript, usd } from "../http";
import type { CreatorClient, CreativeJob, ToolCreds, ToolDef, ToolDeps } from "../types";

/**
 * HeyGen (https://developers.heygen.com) — presenter videos with HeyGen's
 * stock studio avatars (or the owner's own avatar, with consent).
 *
 *   POST /v3/videos {type: "avatar", avatar_id, script, voice_id?, aspect_ratio, resolution, caption, engine}
 *        → {data: {video_id, status}}
 *   GET  /v3/videos/{video_id} → {data: {status: pending|processing|completed|failed, video_url, duration, thumbnail_url, failure_code, failure_message}}
 *   GET  /v3/avatars/looks?ownership=public&avatar_type=studio_avatar → stock avatars (look id = avatar_id, default_voice_id)
 *
 * Auth: x-api-key. The v1/v2 endpoints were sunset on 31 Oct 2026
 * (developers.heygen.com/endpoint-version-comparison), so this uses v3.
 * Pricing (help.heygen.com "HeyGen API pricing explained", Nov 2026): Avatar
 * III studio avatar $0.99/min, Avatar IV studio avatar $4.83/min, per second
 * generated. Video URLs are presigned and expire: download right away.
 */

export const HEYGEN_BASE = "https://api.heygen.com";
const ENGINES = { avatar_iii: 0.99 / 60, avatar_iv: 4.83 / 60 } as const;
type Engine = keyof typeof ENGINES;
const PENDING = new Set(["waiting", "pending", "processing"]);
const LOCALE: Record<string, string> = { de: "de-DE", en: "en-US", fr: "fr-FR", es: "es-ES", it: "it-IT", nl: "nl-NL", pt: "pt-PT", pl: "pl-PL" };

type Look = { id: string; name?: string; avatar_type?: string; default_voice_id?: string | null };
type Video = { video_id?: string; id?: string; status?: string; video_url?: string | null; duration?: number | null; thumbnail_url?: string | null; failure_code?: string | null; failure_message?: string | null };

const engineOf = (c: ToolCreds): Engine => (c.engine === "avatar_iv" ? "avatar_iv" : "avatar_iii");
const perSec = (c: ToolCreds) => envNum(c.usdPerSecond, ENGINES[engineOf(c)]);

function estimate(c: ToolCreds, job: CreativeJob): number {
  return job.capability === "presenter_video" ? usd(secondsOfScript(job.script, 5) * perSec(c)) : 0;
}

export function heygenClient(c: ToolCreds, deps: ToolDeps = {}): CreatorClient {
  const base = (c.baseUrl ?? HEYGEN_BASE).replace(/\/$/, "");
  const headers = { "x-api-key": c.apiKey!, accept: "application/json" };
  let stock: Look | null = null;

  async function look(): Promise<{ avatarId: string; voiceId?: string }> {
    if (c.avatarId) return { avatarId: c.avatarId, voiceId: c.voiceId || undefined };
    if (!stock) {
      const r = await providerRequest<{ data?: Look[] }>("heygen", deps, `${base}/v3/avatars/looks`, { headers, query: { ownership: "public", avatar_type: "studio_avatar", limit: 20 } });
      stock = (r?.data ?? []).find((l) => l.id) ?? null;
      if (!stock) throw new ProviderError("heygen", "no stock avatar available on this account");
    }
    return { avatarId: stock.id, voiceId: c.voiceId || stock.default_voice_id || undefined };
  }

  return {
    estimateUsd: (job) => estimate(c, job),
    async generate(job) {
      if (job.capability !== "presenter_video") throw new ProviderError("heygen", `can't make ${job.capability}`);
      const script = job.script.trim();
      if (!script) throw new ProviderError("heygen", "a presenter video needs a script");
      const who = await look();
      const body: Record<string, unknown> = {
        type: "avatar",
        avatar_id: who.avatarId,
        script: script.slice(0, 5000),
        title: `day2 ${job.appName}`.slice(0, 200),
        aspect_ratio: job.ratio,
        resolution: "1080p",
        caption: { file_format: "srt", style: "default" },
        engine: { type: engineOf(c) },
      };
      if (who.voiceId) body.voice_id = who.voiceId;
      if (job.language && LOCALE[job.language]) body.voice_settings = { locale: LOCALE[job.language] };
      const created = await providerRequest<{ data?: Video }>("heygen", deps, `${base}/v3/videos`, { method: "POST", headers: { ...headers, "Idempotency-Key": `day2-${randomBytes(12).toString("hex")}` }, json: body, retries: 2 });
      const id = created?.data?.video_id ?? created?.data?.id;
      if (!id) throw new ProviderError("heygen", "create video returned no video_id");
      const done = await providerPoll(
        "heygen",
        deps,
        async () => {
          const r = await providerRequest<{ data?: Video }>("heygen", deps, `${base}/v3/videos/${encodeURIComponent(id)}`, { headers });
          const v = r?.data ?? {};
          const status = String(v.status ?? "").toLowerCase();
          if (PENDING.has(status)) return undefined;
          if (status === "completed") return v;
          if (status === "failed") {
            const code = v.failure_code ?? "";
            throw new ProviderError("heygen", `video ${id} failed${code ? ` (${code})` : ""}: ${v.failure_message ?? "no reason given"}`, undefined, /internal|timeout|server/i.test(code));
          }
          throw new ProviderError("heygen", `video ${id} has unknown status "${v.status}"`);
        },
        `video ${id}`,
        { everyMs: 10_000, timeoutMs: 30 * 60_000 },
      );
      if (!done.video_url) throw new ProviderError("heygen", `video ${id} completed without a video_url`);
      const seconds = done.duration ?? secondsOfScript(script, 5);
      return { url: done.video_url, mime: "video/mp4", durationSec: done.duration ?? undefined, aiPerson: true, costUsd: usd(seconds * perSec(c)), providerJobId: id };
    },
  };
}

export const HEYGEN: ToolDef = {
  id: "heygen",
  name: "HeyGen",
  oneLine: "Presenter videos: one of HeyGen's stock avatars reads the script, with captions.",
  capabilities: ["presenter_video"],
  ratios: { presenter_video: ["9:16", "1:1", "16:9", "4:5"] },
  fields: [
    { key: "apiKey", label: "API key", secret: true, help: "HeyGen → Settings → API" },
    { key: "avatarId", label: "Your own avatar ID (optional)", secret: false, optional: true, likeness: "avatar", help: "Leave empty to use a HeyGen stock avatar." },
    { key: "voiceId", label: "Voice ID (optional)", secret: false, optional: true, likeness: "voice" },
  ],
  env: { required: ["HEYGEN_API_KEY"], optional: ["HEYGEN_AVATAR_ID", "HEYGEN_VOICE_ID", "HEYGEN_ENGINE", "HEYGEN_USD_PER_SECOND"] },
  docsUrl: "https://developers.heygen.com/reference/create-video",
  keyUrl: "https://app.heygen.com/settings?nav=API",
  priceNote: "about $1 per minute of video (Avatar III); Avatar IV about $4.83",
  sample: { capability: "presenter_video", script: "x ".repeat(60), ratio: "9:16", appName: "app" },
  unverified: "Built from HeyGen's v3 API reference and tested against fakes; not yet run against a real HeyGen account.",
  fromEnv(env) {
    const apiKey = env.HEYGEN_API_KEY?.trim();
    if (!apiKey) return null;
    return { apiKey, ...(env.HEYGEN_AVATAR_ID?.trim() ? { avatarId: env.HEYGEN_AVATAR_ID.trim() } : {}), ...(env.HEYGEN_VOICE_ID?.trim() ? { voiceId: env.HEYGEN_VOICE_ID.trim() } : {}), ...(env.HEYGEN_ENGINE?.trim() ? { engine: env.HEYGEN_ENGINE.trim() } : {}), ...(env.HEYGEN_USD_PER_SECOND?.trim() ? { usdPerSecond: env.HEYGEN_USD_PER_SECOND.trim() } : {}) };
  },
  client: heygenClient,
  verify: (c, deps = {}) => checkKey("heygen", "HeyGen", deps, `${(c.baseUrl ?? HEYGEN_BASE).replace(/\/$/, "")}/v3/avatars/looks`, { headers: { "x-api-key": c.apiKey ?? "" }, query: { ownership: "public", limit: 1 } }),
};
