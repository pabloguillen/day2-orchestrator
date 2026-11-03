/**
 * Request paths day2 accepts before routing (handleRequest in api-server.ts).
 *
 * Local mode has no sign-in: only the paths the Cloudflare Tunnel makes
 * public (deploy/tunnel/day2-tunnel.sh) may be reachable from outside. A
 * path that only *looks* public before normalization — `/api/ingest/%2e%2e/apps`
 * becomes `/api/apps` — must never get through, so anything with encoded
 * dots, slashes or backslashes, dot segments, or a raw path that differs
 * from the parsed one is refused outright.
 */

/**
 * The public paths. Kept identical to the tunnel's ingress `path:` in
 * deploy/tunnel/day2-tunnel.sh (a test checks they match).
 */
export const PUBLIC_PATH_SOURCE =
  "^/api/(ads/connect/callback/[a-z]+|assets/[A-Za-z0-9_-]+(\\.[a-z0-9]+)?|l/[A-Za-z0-9_-]+(/handoff\\.js)?|ingest/d2k_[A-Za-z0-9_-]+(/(config|contracts|push))?|store-notify/(apple|google|revenuecat)/[A-Za-z0-9_-]+)$";
export const PUBLIC_PATH = new RegExp(PUBLIC_PATH_SOURCE);

/** The path part of a request target as it came in (no query, no fragment), without parsing it. */
export function rawPath(url: string): string {
  let rest = url;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/.exec(rest);
  if (scheme) rest = rest.slice(scheme[0].length);
  const end = rest.search(/[?#]/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Why a request target is refused (400), or null when it's a plain path. Pure. */
export function pathProblem(url: string): string | null {
  const raw = rawPath(url);
  if (/%2e|%2f|%5c/i.test(raw)) return "encoded dot, slash or backslash in the path";
  if (raw.includes("\\")) return "backslash in the path";
  if (raw.split("/").some((s) => s === "." || s === "..")) return "dot segment in the path";
  let parsed: string;
  try {
    parsed = new URL(url, "http://day2.invalid").pathname;
  } catch {
    return "unreadable path";
  }
  if (parsed !== (raw || "/")) return "path changes when normalized";
  return null;
}

/**
 * True when the request came through Cloudflare (the tunnel, or the inbox
 * Worker in front of it): Cloudflare sets these itself and can't be told
 * not to.
 */
export const viaCloudflare = (req: Request) => req.headers.has("cf-ray") || req.headers.has("cf-connecting-ip");
