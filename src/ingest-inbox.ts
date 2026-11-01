/**
 * Fetches the reports day2's inbox at Cloudflare kept while day2 couldn't be
 * reached (deploy/inbox/worker.js), and handles each like a report that just
 * arrived. A report is deleted there only once day2 has taken it (or
 * refused it for good); rate-limited ones wait for the next round.
 */

export type InboxReport = { id: number; path: string; body: string; ip: string | null; ua: string | null; origin: string | null; received_at: number };

export type DrainResult = { taken: number; refused: number; waiting: number; stoppedAt: string | null };

/** Pure. A kept report as the request it was. */
export function asRequest(r: InboxReport): Request {
  const headers: Record<string, string> = { "content-type": "text/plain", "x-day2-inbox": String(r.received_at) };
  if (r.ip) headers["x-forwarded-for"] = r.ip;
  if (r.ua) headers["user-agent"] = r.ua;
  if (r.origin) headers.origin = r.origin;
  return new Request(`http://inbox.local${r.path}`, { method: "POST", headers, body: r.body });
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
  const out: DrainResult = { taken: 0, refused: 0, waiting: 0, stoppedAt: null };
  const max = o.max ?? 2000;
  while (out.taken + out.refused < max) {
    const res = await doFetch(`${base}/__inbox?limit=200`, { headers: auth, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`the inbox answered ${res.status}`);
    const { reports, waiting } = (await res.json()) as { reports: InboxReport[]; waiting: number };
    out.waiting = waiting;
    if (!reports.length) break;
    const done: number[] = [];
    let stop = false;
    for (const r of reports) {
      const answer = await o.handle(asRequest(r));
      if (answer.status === 429 || answer.status >= 500) {
        // Busy or failing here: keep it there, try again next round.
        out.stoppedAt = `report ${r.id}: ${answer.status}`;
        stop = true;
        break;
      }
      if (answer.ok) out.taken++;
      else out.refused++; // malformed or unknown key: no point keeping it
      done.push(r.id);
    }
    if (done.length) await doFetch(`${base}/__inbox/ack`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ ids: done }), signal: AbortSignal.timeout(20_000) });
    out.waiting = Math.max(0, out.waiting - done.length);
    if (stop || reports.length < 200) break;
  }
  return out;
}
