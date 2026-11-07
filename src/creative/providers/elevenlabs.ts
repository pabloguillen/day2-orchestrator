import { binaryRequest, checkKey, envNum, ProviderError, usd } from "../http";
import type { CreatorClient, CreativeJob, ToolCreds, ToolDef, ToolDeps } from "../types";

/**
 * ElevenLabs (https://elevenlabs.io/docs) — voiceovers and music.
 *
 *   POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128 {text, model_id} → audio file
 *   POST /v1/music?output_format=mp3_44100_128 {prompt, music_length_ms (3000–600000), force_instrumental, model_id} → audio file
 *   GET  /v1/user → the account (the key check)
 *
 * Auth: xi-api-key. Both calls answer synchronously with the audio.
 * Pricing (elevenlabs.io/pricing/api, Nov 2026): Multilingual v2 $0.08 per
 * 1,000 characters, Flash $0.04; music $0.15 per minute.
 *
 * Voice: a premade ElevenLabs voice unless one is set. A cloned voice is
 * only accepted from the owner with the likeness consent (it must be their
 * own voice or one they have written permission to use).
 */

export const ELEVENLABS_BASE = "https://api.elevenlabs.io";
/** "Rachel", one of ElevenLabs' premade (stock) voices. */
export const ELEVENLABS_DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";
const TTS_USD_PER_1K = 0.08;
const MUSIC_USD_PER_MIN = 0.15;

function estimate(c: ToolCreds, job: CreativeJob): number {
  if (job.capability === "voice") return usd((Math.max(1, job.text.length) / 1000) * envNum(c.usdPer1kChars, TTS_USD_PER_1K));
  if (job.capability === "music") return usd((Math.max(3, job.durationSec) / 60) * envNum(c.usdPerMusicMinute, MUSIC_USD_PER_MIN));
  return 0;
}

export function elevenlabsClient(c: ToolCreds, deps: ToolDeps = {}): CreatorClient {
  const base = (c.baseUrl ?? ELEVENLABS_BASE).replace(/\/$/, "");
  const headers = { "xi-api-key": c.apiKey! };
  return {
    estimateUsd: (job) => estimate(c, job),
    async generate(job) {
      if (job.capability === "voice") {
        const text = job.text.trim();
        if (!text) throw new ProviderError("elevenlabs", "a voiceover needs text");
        const voice = c.voiceId || ELEVENLABS_DEFAULT_VOICE;
        const r = await binaryRequest("elevenlabs", deps, `${base}/v1/text-to-speech/${encodeURIComponent(voice)}`, { method: "POST", headers, query: { output_format: "mp3_44100_128" }, json: { text: text.slice(0, 5000), model_id: c.model || "eleven_multilingual_v2" }, retries: 2 });
        return { bytes: r.bytes, mime: "audio/mpeg", aiPerson: false, costUsd: estimate(c, job), providerJobId: `tts-${Date.now().toString(36)}` };
      }
      if (job.capability === "music") {
        const ms = Math.min(600_000, Math.max(3000, Math.round(job.durationSec * 1000)));
        const r = await binaryRequest("elevenlabs", deps, `${base}/v1/music`, { method: "POST", headers, query: { output_format: "mp3_44100_128" }, json: { prompt: job.prompt.slice(0, 2000), music_length_ms: ms, force_instrumental: true, model_id: c.musicModel || "music_v1" }, retries: 1 });
        return { bytes: r.bytes, mime: "audio/mpeg", durationSec: ms / 1000, aiPerson: false, costUsd: estimate(c, job), providerJobId: `music-${Date.now().toString(36)}` };
      }
      throw new ProviderError("elevenlabs", `can't make ${job.capability}`);
    },
  };
}

export const ELEVENLABS: ToolDef = {
  id: "elevenlabs",
  name: "ElevenLabs",
  oneLine: "Voiceovers in the post's language for generated clips, and instrumental music.",
  capabilities: ["voice", "music"],
  ratios: {},
  fields: [
    { key: "apiKey", label: "API key", secret: true, help: "ElevenLabs → Developers → API keys" },
    { key: "voiceId", label: "Your own voice ID (optional)", secret: false, optional: true, likeness: "voice", help: "Leave empty to use a premade ElevenLabs voice." },
  ],
  env: { required: ["ELEVENLABS_API_KEY"], optional: ["ELEVENLABS_VOICE_ID", "ELEVENLABS_MODEL", "ELEVENLABS_USD_PER_1K_CHARS", "ELEVENLABS_USD_PER_MUSIC_MINUTE"] },
  docsUrl: "https://elevenlabs.io/docs/api-reference/text-to-speech/convert",
  keyUrl: "https://elevenlabs.io/app/developers/api-keys",
  priceNote: "about $0.08 per 1,000 characters of voiceover; music about $0.15 a minute",
  sample: { capability: "voice", text: "x".repeat(150) },
  unverified: "Built from ElevenLabs' API reference and tested against fakes; not yet run against a real ElevenLabs account. The default premade voice id is from ElevenLabs' voice library and may change.",
  fromEnv(env) {
    const apiKey = env.ELEVENLABS_API_KEY?.trim();
    if (!apiKey) return null;
    return { apiKey, ...(env.ELEVENLABS_VOICE_ID?.trim() ? { voiceId: env.ELEVENLABS_VOICE_ID.trim() } : {}), ...(env.ELEVENLABS_MODEL?.trim() ? { model: env.ELEVENLABS_MODEL.trim() } : {}), ...(env.ELEVENLABS_USD_PER_1K_CHARS?.trim() ? { usdPer1kChars: env.ELEVENLABS_USD_PER_1K_CHARS.trim() } : {}), ...(env.ELEVENLABS_USD_PER_MUSIC_MINUTE?.trim() ? { usdPerMusicMinute: env.ELEVENLABS_USD_PER_MUSIC_MINUTE.trim() } : {}) };
  },
  client: elevenlabsClient,
  verify: (c, deps = {}) => checkKey("elevenlabs", "ElevenLabs", deps, `${(c.baseUrl ?? ELEVENLABS_BASE).replace(/\/$/, "")}/v1/user`, { headers: { "xi-api-key": c.apiKey ?? "" } }),
};
