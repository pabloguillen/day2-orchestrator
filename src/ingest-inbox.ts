/**
 * Fetches the reports day2's inbox at Cloudflare kept while day2 couldn't be
 * reached (deploy/inbox/worker.js), and handles each like a report that just
 * arrived. A report is deleted there only once day2 has taken it (or
 * refused it for good); one that's busy or failing is skipped for this
 * round and tried again in the next.
 */

export type InboxReport = { id: number; path: string; body: string; ip: string | null; ua: string | null; origin: string | null; received_at: number };

export type DrainResult = { taken: number; refused: number; waiting: number; skipped: number; lastError: string | null };

/** Store notifications (App Store, Google Play) kept like reports; replayed to their own path. */
export const STORE_NOTIFY_PATH = /^\/api\/store-notify\/(apple|google)\/[A-Za-z0-9_-]{1,64}$/;

/** What day2 knows about a replayed request: when the Worker received it, and from where. */
export type Replay = { receivedAt: number; ip: string | null };

/**
 * Replays are marked in-process, on the Request object itself — never by a
 * header, so nothing that arrives over HTTP can pass for one (any
 * `x-day2-inbox*` header is simply ignored).
 */
const replays = new WeakMap<Request, Replay>();

/** The replay mark of a request built by asRequest, or null for anything that came over HTTP. */
export function replayOf(req: Request): Replay | null {
  return replays.get(req) ?? null;
}

/**
 * A kept report as the request it was, marked as a replay (see replayOf).
 * Authorization headers are never kept, so a store notification's own
 * signature (Apple's signed payload) or a lookup with the store must prove
 * it, not the header.
 */
export function asRequest(r: InboxReport): Request {
  const headers: Record<string, string> = { "content-type": STORE_NOTIFY_PATH.test(r.path) ? "application/json" : "text/plain" };
  if (r.ua) headers["user-agent"] = r.ua;
  if (r.origin) headers.origin = r.origin;
  const req = new Request(`http://inbox.local${r.path}`, { method: "POST", headers, body: r.body });
  replays.set(req, { receivedAt: r.received_at, ip: r.ip });
  return req;
}

export async function drainInbox(o: {
  url: string;
  token: string;
  /** day2's own handler for /api/ingest/… */
  handle: (req: Request) => Promise<Response>;
  doFetch?: typeof fetch;
  max?: number;
}): Promise<DrainResult> {
  const doFetch = o.doFetch ?? fetch;
  const base = o.url.replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${o.token}` };
  const out: DrainResult = { taken: 0, refused: 0, waiting: 0, skipped: 0, lastError: null };
  const max = o.max ?? 2000;
  const seen = new Set<number>();
  let after = 0;
  while (out.taken + out.refused + out.skipped < max) {
    const res = await doFetch(`${base}/__inbox?limit=200&after=${after}`, { headers: auth, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`the inbox answered ${res.status}`);
    const { reports, waiting } = (await res.json()) as { reports: InboxReport[]; waiting: number };
    out.waiting = waiting;
    const fresh = reports.filter((r) => !seen.has(r.id));
    if (!fresh.length) break; // nothing new (or an older Worker that ignores `after`)
    const done: number[] = [];
    for (const r of fresh) {
      seen.add(r.id);
      after = Math.max(after, r.id);
      let status: number;
      try {
        status = (await o.handle(asRequest(r))).status;
      } catch {
        status = 500;
      }
      // Busy or failing here — or a store notification nobody handles yet (404): keep it there, go on with the rest.
      if (status === 429 || status >= 500 || (status === 404 && STORE_NOTIFY_PATH.test(r.path))) {
        out.skipped++;
        out.lastError = `report ${r.id}: ${status}`;
        continue;
      }
      if (status >= 200 && status < 300) out.taken++;
      else out.refused++; // malformed or unknown key: no point keeping it
      done.push(r.id);
    }
    if (done.length) await doFetch(`${base}/__inbox/ack`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ ids: done }), signal: AbortSignal.timeout(20_000) });
    out.waiting = Math.max(0, out.waiting - done.length);
    if (reports.length < 200) break;
  }
  return out;
}
