import type { EventLike } from "./metrics/types";

/**
 * Reads an app's usage events from the app itself (docs/growth-events.md):
 * `GET <appBaseUrl>/api/day2-events?since=<iso>` → `{ events: EventLike[] }`.
 * When the app protects the endpoint, day2 sends the token the owner saved
 * (`Authorization: Bearer <token>`).
 *
 * Returns null when the app doesn't offer the endpoint (yet) — callers say
 * "not measured", never "zero".
 */

const MAX_EVENTS = 200_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchAppEvents(
  appBaseUrl: string | undefined,
  sinceIso: string,
  opts: { token?: string; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<EventLike[] | null> {
  if (!appBaseUrl) return null;
  const url = `${appBaseUrl.replace(/\/+$/, "")}/api/day2-events?since=${encodeURIComponent(sinceIso)}`;
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, {
      headers: { accept: "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { events?: unknown } | null;
  if (!body || !Array.isArray(body.events)) return null;
  return (body.events as EventLike[])
    .filter((e) => e && typeof e.type === "string" && typeof e.at === "string" && typeof e.deviceId === "string")
    .slice(0, MAX_EVENTS);
}
