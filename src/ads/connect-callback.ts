import type { PlatformId } from "./types";

/**
 * GET /api/ads/connect/callback/:platform — where a platform sends the
 * person back after signing in. The code exchange (and, for Meta, the
 * long-lived token and /me/permissions) runs here, over a possibly slow
 * tunnel. Whatever happens — a thrown error, a Graph error, a fetch that
 * times out, the whole exchange taking too long — the person lands back on
 * the console with a readable `connectError`, never on a blank page, and the
 * server console gets one line (no tokens, no codes).
 */

/** The whole exchange may take this long before the person is sent back with an error. */
export const CALLBACK_DEADLINE_MS = 45_000;

type Scope = "day2" | { appId: string };
type Started = { id: string; scope: Scope; purpose?: string } | null;

export type CallbackDeps = {
  consoleUrl: string;
  /** The half-done connection this callback belongs to, from its query (state / p). */
  started: (q: URLSearchParams) => Promise<Started>;
  finish: (platform: PlatformId, query: Record<string, string>) => Promise<{ pendingId: string; scope: Scope; purpose: string }>;
  /** Drops a half-done connection whose sign-in failed. */
  endPending?: (id: string) => Promise<void>;
  log?: (line: string) => void;
  deadlineMs?: number;
};

const pageOf = (scope: Scope | undefined, purpose?: string) =>
  !scope ? "/" : scope === "day2" ? "/operator" : purpose === "social" ? `/apps/${encodeURIComponent(scope.appId)}/social` : `/apps/${encodeURIComponent(scope.appId)}/growth/ads`;

/** Strips anything token- or code-like and squeezes to one short line. */
export function safeErrorLine(text: string, max = 300): string {
  const t = text
    .replace(/(access_token|fb_exchange_token|client_secret|token|secret|key|authorization)(["']?\s*[=:]\s*["']?)[^"'&\s,}]+/gi, "$1$2[redacted]")
    .replace(/\b(code)=[^"'&\s,}]+/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)}s — try connecting again.`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function adsConnectCallback(req: Request, platform: string, isPlatform: (p: string) => p is PlatformId, deps: CallbackDeps): Promise<Response> {
  const log = deps.log ?? ((l: string) => globalThis.console.error(l));
  const q = new URL(req.url).searchParams;
  if (!isPlatform(platform)) return Response.redirect(`${deps.consoleUrl}/`, 302);
  let started: Started = null;
  try {
    started = await deps.started(q).catch(() => null);
    const r = await withDeadline(deps.finish(platform, Object.fromEntries(q)), deps.deadlineMs ?? CALLBACK_DEADLINE_MS, "Signing in");
    return Response.redirect(`${deps.consoleUrl}${pageOf(r.scope, r.purpose)}?connect=${encodeURIComponent(r.pendingId)}&platform=${platform}`, 302);
  } catch (err) {
    const message = safeErrorLine((err as Error)?.message ?? String(err)) || "Signing in failed — try connecting again.";
    log(`[day2-ads] ${platform} sign-in callback failed: ${message}`);
    if (started && deps.endPending) await deps.endPending(started.id).catch(() => {});
    return Response.redirect(`${deps.consoleUrl}${pageOf(started?.scope, started?.purpose)}?platform=${platform}&connectError=${encodeURIComponent(message)}`, 302);
  }
}

/** GET callbacks that do slow work inline (code exchange over a tunnel): Bun's 10s idle limit must not drop them. */
export function isSlowCallbackPath(method: string, pathname: string): boolean {
  return method === "GET" && /^\/api\/ads\/connect\/callback\/[^/]+$/.test(pathname);
}
