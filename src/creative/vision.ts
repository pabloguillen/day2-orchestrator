import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * One agent run that looks at images (the art director looks at the app's
 * screens; the critic at sampled frames and slides). Metered like every run
 * (metered-query.ts); no tools; images are downscaled JPEGs.
 */

export type VisionImage = { label: string; file: string };
export type VisionRun = (o: { prompt: string; images: VisionImage[]; maxUsd: number; label: string }) => Promise<string>;

const MODEL = process.env.DAY2_VISION_MODEL ?? process.env.DAY2_MODEL ?? "claude-sonnet-5";

/** A JPEG ≤ `width` px wide as base64 (ffmpeg), else the file as-is. */
export function shrink(file: string, width = 540): { data: string; mime: string } {
  const r = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `scale='min(${width},iw)':-2`, "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "-"], { timeout: 20_000, maxBuffer: 20 * 1024 * 1024 });
  if (r.status === 0 && r.stdout?.length) return { data: r.stdout.toString("base64"), mime: "image/jpeg" };
  return { data: readFileSync(file).toString("base64"), mime: /\.png$/i.test(file) ? "image/png" : "image/jpeg" };
}

export const runVision: VisionRun = async ({ prompt, images, maxUsd, label }) => {
  const { meteredQuery } = await import("../metered-query");
  const content: Array<Record<string, unknown>> = [];
  for (const im of images.slice(0, 16)) {
    const { data, mime } = shrink(im.file);
    content.push({ type: "text", text: im.label }, { type: "image", source: { type: "base64", media_type: mime, data } });
  }
  content.push({ type: "text", text: prompt });
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: content as never }, parent_tool_use_id: null } as SDKUserMessage;
  }
  let text = "";
  for await (const m of meteredQuery("content_generation", label)({
    prompt: input(),
    options: { model: MODEL, permissionMode: "bypassPermissions", maxTurns: 2, maxBudgetUsd: maxUsd, persistSession: false, settingSources: [], settings: { disableClaudeAiConnectors: true }, tools: [] },
  })) {
    const msg = m as { type?: string; result?: string; is_error?: boolean };
    if (msg.type === "result") {
      if (msg.is_error) throw new Error(`${label} failed`);
      text = msg.result ?? "";
    }
  }
  return text;
};

/** The JSON after the last marker line, or null. Pure. */
export function jsonAfter(text: string, marker: string): Record<string, unknown> | null {
  const at = text.lastIndexOf(marker);
  if (at === -1) return null;
  try {
    const v = JSON.parse(text.slice(at + marker.length).trim()) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
