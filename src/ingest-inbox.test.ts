import { describe, expect, test } from "bun:test";
// @ts-expect-error — plain JS Worker module (deploy/inbox/worker.js)
import { handle } from "../deploy/inbox/worker.js";
import { asRequest, drainInbox, type InboxReport } from "./ingest-inbox";

/** Just enough of Cloudflare D1 for the Worker's statements. */
function fakeD1() {
  const rows: InboxReport[] = [];
  let next = 1;
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    async run() {
      if (sql.startsWith("INSERT")) {
        const [path, body, ip, ua, origin, received_at] = args as [string, string, string | null, string | null, string | null, number];
        rows.push({ id: next++, path, body, ip, ua, origin, received_at });
      } else if (sql.startsWith("DELETE FROM inbox WHERE id IN")) {
        for (const id of args as number[]) rows.splice(rows.findIndex((r) => r.id === id) >>> 0, rows.some((r) => r.id === id) ? 1 : 0);
      } else if (sql.startsWith("DELETE FROM inbox WHERE received_at")) {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.received_at < (args[0] as number)) rows.splice(i, 1);
      }
      return {};
    },
    async first() {
      return { n: rows.length };
    },
    async all() {
      return { results: rows.slice(0, args[0] as number) };
    },
  });
  return { rows, prepare: (sql: string) => stmt(sql) };
}

const KEY = "d2k_qodmrFihh_VU5JJgYrl-Nrns";
const report = (n: number) => new Request(`https://app.gora8.com/api/ingest/${KEY}`, { method: "POST", body: JSON.stringify({ v: 1, n }), headers: { "content-type": "text/plain", "cf-connecting-ip": "203.0.113.7", "user-agent": "Dotty/1.0 iOS" } });

describe("day2's inbox at Cloudflare", () => {
  test("day2 reachable: reports go straight through, nothing is kept", async () => {
    const env = { DB: fakeD1(), INBOX_TOKEN: "t" };
    const res = await handle(report(1), env, async () => new Response(null, { status: 204 }));
    expect(res.status).toBe(204);
    expect(env.DB.rows).toEqual([]);
  });

  test("day2 asleep (tunnel down, 530): the report is kept and the app hears “accepted”", async () => {
    const env = { DB: fakeD1(), INBOX_TOKEN: "t" };
    const res = await handle(report(1), env, async () => new Response("error 1033", { status: 530 }));
    expect(res.status).toBe(202);
    expect(env.DB.rows).toMatchObject([{ path: `/api/ingest/${KEY}`, body: '{"v":1,"n":1}', ip: "203.0.113.7", ua: "Dotty/1.0 iOS" }]);
    // Network failure counts the same.
    expect((await handle(report(2), env, async () => Promise.reject(new Error("timeout")))).status).toBe(202);
    expect(env.DB.rows.length).toBe(2);
  });

  test("day2 answered with its own error: that answer stands, nothing kept", async () => {
    const env = { DB: fakeD1(), INBOX_TOKEN: "t" };
    expect((await handle(report(1), env, async () => new Response(null, { status: 429 }))).status).toBe(429);
    expect((await handle(report(1), env, async () => new Response(null, { status: 500 }))).status).toBe(500);
    expect(env.DB.rows).toEqual([]);
  });

  test("only reports are kept: other paths, junk keys and oversized bodies are not", async () => {
    const env = { DB: fakeD1(), INBOX_TOKEN: "t" };
    const down = async () => new Response(null, { status: 530 });
    expect((await handle(new Request("https://app.gora8.com/api/ingest/not-a-key", { method: "POST", body: "x" }), env, down)).status).toBe(530);
    expect((await handle(new Request(`https://app.gora8.com/api/ingest/${KEY}`, { method: "POST", body: "x".repeat(70_000) }), env, down)).status).toBe(413);
    expect(env.DB.rows).toEqual([]);
  });

  test("fetching what's waiting needs the token", async () => {
    const env = { DB: fakeD1(), INBOX_TOKEN: "secret" };
    expect((await handle(new Request("https://app.gora8.com/__inbox"), env, async () => new Response())).status).toBe(401);
    expect((await handle(new Request("https://app.gora8.com/__inbox", { headers: { authorization: "Bearer wrong" } }), env, async () => new Response())).status).toBe(401);
  });

  test("day2 wakes up: it takes everything kept, in order, and the inbox is empty afterwards", async () => {
    const env = { DB: fakeD1(), INBOX_TOKEN: "secret" };
    for (let n = 1; n <= 3; n++) await handle(report(n), env, async () => new Response(null, { status: 530 }));
    const seen: Array<{ body: string; ip: string | null; ua: string | null; path: string }> = [];
    // day2's fetches go to the Worker itself.
    const viaWorker = ((u: string | URL | Request, init?: RequestInit) => handle(new Request(String(u), init), env, async () => new Response())) as typeof fetch;
    const r = await drainInbox({
      url: "https://app.gora8.com",
      token: "secret",
      doFetch: viaWorker,
      handle: async (req) => {
        seen.push({ body: await req.text(), ip: req.headers.get("x-forwarded-for"), ua: req.headers.get("user-agent"), path: new URL(req.url).pathname });
        return new Response(null, { status: 204 });
      },
    });
    expect(r).toEqual({ taken: 3, refused: 0, waiting: 0, stoppedAt: null });
    expect(seen.map((s) => JSON.parse(s.body).n)).toEqual([1, 2, 3]);
    expect(seen[0]).toMatchObject({ ip: "203.0.113.7", ua: "Dotty/1.0 iOS", path: `/api/ingest/${KEY}` });
    expect(env.DB.rows).toEqual([]);
  });

  test("day2 busy (rate limit): the rest waits for the next round", async () => {
    const env = { DB: fakeD1(), INBOX_TOKEN: "secret" };
    for (let n = 1; n <= 3; n++) await handle(report(n), env, async () => new Response(null, { status: 530 }));
    const viaWorker = ((u: string | URL | Request, init?: RequestInit) => handle(new Request(String(u), init), env, async () => new Response())) as typeof fetch;
    let calls = 0;
    const r = await drainInbox({ url: "https://app.gora8.com", token: "secret", doFetch: viaWorker, handle: async () => new Response(null, { status: ++calls === 2 ? 429 : 204 }) });
    expect(r).toMatchObject({ taken: 1, waiting: 2, stoppedAt: "report 2: 429" });
    expect(env.DB.rows.map((x) => x.id)).toEqual([2, 3]);
  });

  test("a kept report becomes the request it was", async () => {
    const req = asRequest({ id: 1, path: `/api/ingest/${KEY}`, body: "{}", ip: "1.2.3.4", ua: "UA", origin: "https://dotty.example", received_at: 5 });
    expect(new URL(req.url).pathname).toBe(`/api/ingest/${KEY}`);
    expect([req.headers.get("x-forwarded-for"), req.headers.get("origin"), req.headers.get("x-day2-inbox")]).toEqual(["1.2.3.4", "https://dotty.example", "5"]);
  });
});
