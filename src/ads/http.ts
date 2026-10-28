import { readFile } from "node:fs/promises";
import { PlatformError, type Asset, type PlatformDeps, type PlatformId } from "./types";

/**
 * HTTP for the ad platform adapters: JSON in and out, retries on rate
 * limits and outages (with Retry-After), platform errors as PlatformError,
 * and an injectable fetch for tests. Tokens never appear in errors.
 */

export type RequestInit2 = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  /** JSON body. */
  json?: unknown;
  /** application/x-www-form-urlencoded body. */
  form?: Record<string, string>;
  /** multipart/form-data body. */
  multipart?: FormData;
  /** Raw body (e.g. bytes for an upload URL). */
  raw?: Uint8Array | string;
  /** Query parameters (undefined values are skipped). */
  query?: Record<string, string | number | boolean | undefined>;
  /** Attempts on 429/5xx/network errors. Default 3. */
  retries?: number;
  /** Return the raw Response instead of parsed JSON. */
  rawResponse?: boolean;
};

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function withQuery(url: string, query?: RequestInit2["query"]): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
}

/** Removes anything that looks like a token from text that may end up in logs. */
export function redact(text: string): string {
  return text
    .replace(/(access_token|token|secret|key|authorization)(["'=:\s]+)[^"'&\s,}]+/gi, "$1$2[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]");
}

export async function request<T = unknown>(platform: PlatformId, deps: PlatformDeps, url: string, init: RequestInit2 = {}): Promise<T> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? sleepDefault;
  const attempts = Math.max(1, init.retries ?? 3);
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers["content-type"] ??= "application/json";
    body = JSON.stringify(init.json);
  } else if (init.form) {
    headers["content-type"] ??= "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  } else if (init.multipart) body = init.multipart;
  else if (init.raw !== undefined) body = init.raw as BodyInit;
  const target = withQuery(url, init.query);

  let last: PlatformError | null = null;
  for (let i = 0; i < attempts; i++) {
    let res: Response;
    try {
      res = await doFetch(target, { method: init.method ?? (body ? "POST" : "GET"), headers, body });
    } catch (err) {
      last = new PlatformError(platform, `network error: ${redact((err as Error).message)}`, undefined, true);
      await sleep(500 * 2 ** i);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      last = new PlatformError(platform, `${res.status} ${redact((await res.text().catch(() => "")).slice(0, 300))}`, res.status, true);
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 1000 * 2 ** i);
      continue;
    }
    if (init.rawResponse) return res as unknown as T;
    const text = await res.text();
    if (!res.ok) throw new PlatformError(platform, `${res.status} ${redact(text.slice(0, 500))}`, res.status, false);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
  throw last ?? new PlatformError(platform, "request failed", undefined, true);
}

export async function assetBytes(deps: PlatformDeps, asset: Asset): Promise<Uint8Array> {
  return deps.readAsset ? deps.readAsset(asset) : new Uint8Array(await readFile(asset.path));
}

/** Polls `check` until it returns a value (not undefined), up to `timeoutMs`. */
export async function poll<T>(deps: PlatformDeps, check: () => Promise<T | undefined>, opts: { everyMs?: number; timeoutMs?: number; what: string; platform: PlatformId }): Promise<T> {
  const sleep = deps.sleep ?? sleepDefault;
  const every = opts.everyMs ?? 3000;
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  for (;;) {
    const v = await check();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new PlatformError(opts.platform, `timed out waiting for ${opts.what}`, undefined, true);
    await sleep(every);
  }
}

/**
 * A cached OAuth access token from a refresh token (most ad APIs). Calls
 * `refresh` when there's none or it's about to expire.
 */
export function tokenCache(refresh: () => Promise<{ accessToken: string; expiresInSec: number }>, now: () => number = Date.now) {
  let token: { value: string; until: number } | null = null;
  let inflight: Promise<string> | null = null;
  return async (): Promise<string> => {
    if (token && token.until - 60_000 > now()) return token.value;
    inflight ??= refresh()
      .then((t) => {
        token = { value: t.accessToken, until: now() + t.expiresInSec * 1000 };
        return t.accessToken;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

/** Fits copy into a platform's limits on a word boundary. */
export function fit(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, "")}…`;
}
