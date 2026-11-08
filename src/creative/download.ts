import { lookup as dnsLookup } from "node:dns/promises";
import { createWriteStream, rmSync } from "node:fs";
import { isIP } from "node:net";

/**
 * Downloading what a creator tool made, from the URL the tool returned —
 * never trusted blindly:
 *  - https only, and the host must be one the tool is known to serve
 *    media from (KNOWN_HOSTS, plus DAY2_CREATOR_HOSTS_<TOOL> for more);
 *  - every resolved address must be public (no loopback, private,
 *    link-local, CGNAT, multicast or metadata addresses);
 *  - redirects are followed by hand (at most 3), each hop checked again;
 *  - a timeout, a size cap read as it streams, and the content type.
 *
 * The host lists come from where each tool's docs and SDKs say outputs
 * live; they're not yet confirmed against real accounts (docs/creator-tools.md).
 * An unknown host is refused with a clear error naming the env to extend it.
 */

export type MediaKind = "video" | "image" | "audio";

/** Host suffixes per tool (a host matches itself or any subdomain). */
export const KNOWN_HOSTS: Record<string, string[]> = {
  // Runway task outputs: signed URLs on Runway's CDN (CloudFront) or storage.
  runway: ["runwayml.com", "cloudfront.net", "amazonaws.com"],
  // Creatify video_output: its own CDN / S3 / CloudFront.
  creatify: ["creatify.ai", "cloudfront.net", "amazonaws.com"],
  // HeyGen video_url: presigned links on HeyGen's file hosts / CloudFront / S3.
  heygen: ["heygen.ai", "heygen.com", "cloudfront.net", "amazonaws.com"],
  // Luma output[].url: presigned storage links.
  luma: ["lumalabs.ai", "cdn-luma.com", "amazonaws.com", "cloudfront.net", "r2.cloudflarestorage.com", "googleapis.com"],
  // Bytes come back inline for these; listed for completeness.
  gemini_video: ["googleapis.com", "googleusercontent.com"],
  elevenlabs: ["elevenlabs.io"],
  openai_images: ["oaiusercontent.com", "openai.com"],
  // EAS workflow artifacts (capture screenshots): Expo's API and its signed storage links.
  eas: ["expo.dev", "expo.io", "storage.googleapis.com"],
};

export const MAX_BYTES: Record<MediaKind, number> = { video: 200 * 1024 * 1024, image: 20 * 1024 * 1024, audio: 50 * 1024 * 1024 };
const TYPES: Record<MediaKind, RegExp> = {
  video: /^(video\/|application\/octet-stream|binary\/octet-stream)/i,
  image: /^(image\/|application\/octet-stream|binary\/octet-stream)/i,
  audio: /^(audio\/|application\/octet-stream|binary\/octet-stream)/i,
};
const MAX_HOPS = 3;

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

/** Is this IP address a public, routable one? Pure. */
export function isPublicIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false; // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a >= 224) return false; // multicast, reserved, broadcast
    return true;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPublicIp(mapped[1]!);
    if (/^(fc|fd)/.test(x)) return false; // unique local
    if (/^fe[89ab]/.test(x)) return false; // link-local
    if (/^ff/.test(x)) return false; // multicast
    if (x.startsWith("64:ff9b:") || x.startsWith("2001:db8:")) return false;
    return true;
  }
  return false;
}

export function allowedHosts(tool: string, env: Record<string, string | undefined> = process.env): string[] {
  const extra = (env[`DAY2_CREATOR_HOSTS_${tool.toUpperCase()}`] ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return [...(KNOWN_HOSTS[tool] ?? []), ...extra];
}

const hostMatches = (host: string, suffixes: string[]) => suffixes.some((s) => host === s || host.endsWith(`.${s}`));

export type SafeDownloadOpts = {
  tool: string;
  kind: MediaKind;
  fetch?: typeof fetch;
  lookup?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
  maxBytes?: number;
  env?: Record<string, string | undefined>;
};

async function checkUrl(raw: string, o: SafeDownloadOpts, name: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new DownloadError(`${name} returned a link that isn't a URL.`);
  }
  if (u.protocol !== "https:") throw new DownloadError(`${name} returned a non-https link; day2 only downloads over https.`);
  if (u.username || u.password) throw new DownloadError(`${name} returned a link with credentials in it.`);
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, ""))) throw new DownloadError(`${name} returned a link to a bare IP address.`);
  const hosts = allowedHosts(o.tool, o.env);
  if (!hostMatches(host, hosts)) throw new DownloadError(`${name} returned a file on ${host}, which isn't one of its known hosts — add it to DAY2_CREATOR_HOSTS_${o.tool.toUpperCase()} if it's right.`);
  const addrs = await (o.lookup ?? (async (h: string) => (await dnsLookup(h, { all: true })).map((a) => a.address)))(host).catch(() => [] as string[]);
  if (!addrs.length) throw new DownloadError(`Couldn't resolve ${host}.`);
  if (addrs.some((a) => !isPublicIp(a))) throw new DownloadError(`${host} resolves to a private or local address; not downloaded.`);
  return u;
}

/** Downloads a creator tool's output to `out`, with every check above. Returns the content type. */
export async function safeDownload(url: string, out: string, o: SafeDownloadOpts): Promise<{ mime: string; bytes: number }> {
  const doFetch = o.fetch ?? fetch;
  const name = o.tool;
  const signal = AbortSignal.timeout(o.timeoutMs ?? 5 * 60_000);
  let target = await checkUrl(url, o, name);
  let res: Response | null = null;
  for (let hop = 0; ; hop++) {
    res = await doFetch(target.toString(), { redirect: "manual", signal }).catch((err: Error) => {
      throw new DownloadError(`Downloading from ${name} failed: ${err.name === "TimeoutError" || err.name === "AbortError" ? "timed out" : "network error"}.`);
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new DownloadError(`${name} redirected without a location.`);
      if (hop + 1 > MAX_HOPS) throw new DownloadError(`${name}'s link redirected too many times.`);
      target = await checkUrl(new URL(loc, target).toString(), o, name);
      continue;
    }
    break;
  }
  if (!res.ok) throw new DownloadError(`Couldn't download what ${name} made (${res.status}).`);
  const mime = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
  if (!TYPES[o.kind].test(mime)) throw new DownloadError(`${name} returned ${mime}, not ${o.kind}.`);
  const max = o.maxBytes ?? MAX_BYTES[o.kind];
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new DownloadError(`${name}'s file is larger than ${Math.round(max / 1024 / 1024)} MB.`);
  if (!res.body) throw new DownloadError(`${name} returned an empty file.`);
  const file = createWriteStream(out);
  let total = 0;
  let ok = false;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new DownloadError(`${name}'s file is larger than ${Math.round(max / 1024 / 1024)} MB.`);
      }
      if (!file.write(value)) await new Promise<void>((r) => file.once("drain", () => r()));
    }
    ok = true;
  } finally {
    await new Promise<void>((r) => file.end(() => r()));
    if (!ok) rmSync(out, { force: true });
  }
  if (!total) throw new DownloadError(`${name} returned an empty file.`);
  return { mime, bytes: total };
}
