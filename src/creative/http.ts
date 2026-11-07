import { redact, withQuery, type RequestInit2 } from "../ads/http";
import { ProviderError, providerPoll, providerRequest, type VideoProviderId } from "../ads/providers/video";
import { KeyCheckError, type ToolDeps } from "./types";

/**
 * HTTP for the creator tools: the ad pipeline's JSON request and polling
 * helpers (retries on 429/5xx with Retry-After, tokens redacted from
 * errors), plus binary responses (audio) and the key check.
 */

export { ProviderError, providerPoll, providerRequest };
export const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A request whose answer is a file (audio): bytes and content type. Errors as ProviderError; 429/5xx retried. */
export async function binaryRequest(tool: VideoProviderId, deps: ToolDeps, url: string, init: RequestInit2 = {}): Promise<{ bytes: Uint8Array; mime: string }> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? sleepDefault;
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers["content-type"] ??= "application/json";
    body = JSON.stringify(init.json);
  }
  const attempts = Math.max(1, init.retries ?? 3);
  let last: ProviderError | null = null;
  for (let i = 0; i < attempts; i++) {
    let res: Response;
    try {
      res = await doFetch(withQuery(url, init.query), { method: init.method ?? (body ? "POST" : "GET"), headers, body });
    } catch (err) {
      last = new ProviderError(tool, `network error: ${redact((err as Error).message)}`, undefined, true);
      await sleep(500 * 2 ** i);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      last = new ProviderError(tool, `${res.status} ${redact((await res.text().catch(() => "")).slice(0, 300))}`, res.status, true);
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 1000 * 2 ** i);
      continue;
    }
    if (!res.ok) throw new ProviderError(tool, `${res.status} ${redact((await res.text().catch(() => "")).slice(0, 500))}`, res.status, false);
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream" };
  }
  throw last ?? new ProviderError(tool, "request failed", undefined, true);
}

/**
 * The key check: one cheap, read-only call. 401/403 → the key was not
 * accepted; anything else that fails → couldn't check right now. The key
 * never appears in the message.
 */
export async function checkKey(tool: VideoProviderId, name: string, deps: ToolDeps, url: string, init: RequestInit2): Promise<void> {
  try {
    await providerRequest(tool, { ...deps, sleep: deps.sleep ?? (async () => {}) }, url, { ...init, retries: 1 });
  } catch (err) {
    const status = (err as ProviderError).status;
    if (status === 401 || status === 403) throw new KeyCheckError(`${name} didn't accept this key.`, true);
    throw new KeyCheckError(`Couldn't check the key with ${name} right now${status ? ` (${status})` : ""} — try again in a minute.`, false);
  }
}

/** Splits a data: URI into its base64 payload and type. */
export function dataUriParts(uri: string): { mime: string; base64: string } | null {
  const m = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(uri);
  return m ? { mime: m[1]!.toLowerCase(), base64: m[2]! } : null;
}

/** Spoken words per second used to size a read before it exists. */
export const WORDS_PER_SEC = 2.5;
export const secondsOfScript = (text: string, min = 1) => Math.max(min, Math.ceil((text.trim().split(/\s+/).filter(Boolean).length || 1) / WORDS_PER_SEC));

/** Rounds USD to a tenth of a cent. */
export const usd = (n: number) => Math.round(n * 1000) / 1000;

/** Positive number from env, else the fallback. */
export function envNum(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}
