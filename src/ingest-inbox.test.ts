import { describe, expect, test } from "bun:test";
// @ts-expect-error — plain JS Worker module (deploy/inbox/worker.js)
import { handle } from "../deploy/inbox/worker.js";
import { asRequest, drainInbox, replayOf, type InboxReport } from "./ingest-inbox";

/** Just enough of Cloudflare D1 for the Worker's statements. */
function fakeD1() {
  const rows: InboxReport[] = [];
  const configs = new Map<string, { body: string; etag: string | null; saved_at: number }>();
  let next = 1;
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    async run() {
      if (sql.startsWith("INSERT INTO live_config")) {
        const [key, body, etag, saved_at] = args as [string, string, string | null, number];
        configs.set(key, { body, etag, saved_at });
      } else if (sql.startsWith("INSERT")) {
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
      if (sql.startsWith("SELECT body, etag FROM live_config")) return configs.get(args[0] as string) ?? null;
      if (sql.includes("WHERE path = ?")) {
        const [base, , prefix] = args as [string, number, string];
        return { n: rows.filter((r) => r.path === base || r.path.startsWith(prefix)).length };
      }
      return { n: rows.length };
    },
    async all() {
      const [after, limit] = args as [number, number];
      return { results: rows.filter((r) => r.id > after).slice(0, limit) };
    },
  });
  return { rows, configs, prepare: (sql: string) => stmt(sql) };
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
        seen.push({ body: await req.text(), ip: replayOf(req)?.ip ?? null, ua: req.headers.get("user-agent"), path: new URL(req.url).pathname });
        return new Response(null, { status: 204 });
      },
    });
    expect(r).toEqual({ taken: 3, refused: 0, waiting: 0, skipped: 0, lastError: null });
    expect(seen.map((s) => JSON.parse(s.body).n)).toEqual([1, 2, 3]);
    expect(seen[0]).toMatchObject({ ip: "203.0.113.7", ua: "Dotty/1.0 iOS", path: `/api/ingest/${KEY}` });
    expect(env.DB.rows).toEqual([]);
  });

  test("one report busy or failing (rate limit, error): skipped for this round, the rest is taken", async () => {
    const env = { DB: fakeD1(), INBOX_TOKEN: "secret" };
    for (let n = 1; n <= 4; n++) await handle(report(n), env, async () => new Response(null, { status: 530 }));
    const viaWorker = ((u: string | URL | Request, init?: RequestInit) => handle(new Request(String(u), init), env, async () => new Response())) as typeof fetch;
    let calls = 0;
    const r = await drainInbox({
      url: "https://app.gora8.com",
      token: "secret",
      doFetch: viaWorker,
      handle: async () => {
        calls++;
        if (calls === 3) throw new Error("boom");
        return new Response(null, { status: calls === 2 ? 429 : 204 });
      },
    });
    expect(r).toMatchObject({ taken: 2, skipped: 2, waiting: 2, lastError: "report 3: 500" });
    expect(env.DB.rows.map((x) => x.id)).toEqual([2, 3]);
    // Next round: they're tried again.
    const again = await drainInbox({ url: "https://app.gora8.com", token: "secret", doFetch: viaWorker, handle: async () => new Response(null, { status: 204 }) });
    expect(again).toMatchObject({ taken: 2, skipped: 0 });
    expect(env.DB.rows).toEqual([]);
  });

  test("a full page of failing reports doesn't stall the drain: it goes on past them", async () => {
    const env = { DB: fakeD1(), INBOX_TOKEN: "secret" };
    for (let n = 1; n <= 250; n++) await handle(report(n), env, async () => new Response(null, { status: 530 }));
    const viaWorker = ((u: string | URL | Request, init?: RequestInit) => handle(new Request(String(u), init), env, async () => new Response())) as typeof fetch;
    const r = await drainInbox({ url: "https://app.gora8.com", token: "secret", doFetch: viaWorker, handle: async (req) => new Response(null, { status: JSON.parse(await req.text()).n <= 200 ? 429 : 204 }) });
    expect(r).toMatchObject({ taken: 50, skipped: 200 });
    expect(env.DB.rows).toHaveLength(200);
  });

  test("a kept report becomes the request it was, marked as a replay in-process only", async () => {
    const req = asRequest({ id: 1, path: `/api/ingest/${KEY}`, body: "{}", ip: "1.2.3.4", ua: "UA", origin: "https://dotty.example", received_at: 5 });
    expect(new URL(req.url).pathname).toBe(`/api/ingest/${KEY}`);
    expect(req.headers.get("origin")).toBe("https://dotty.example");
    expect(replayOf(req)).toEqual({ receivedAt: 5, ip: "1.2.3.4" });
    // Nothing a client can send makes a request a replay.
    const forged = new Request(`http://x/api/store-notify/google/app_dotty`, { method: "POST", headers: { "x-day2-inbox": "5", "x-day2-inbox-sig": "x" }, body: "{}" });
    expect(replayOf(forged)).toBeNull();
    expect(replayOf(new Request(req))).toBeNull();
  });

  test("per key, at most so many reports are kept; other keys still are", async () => {
    const env = { DB: fakeD1(), INBOX_TOKEN: "t" };
    const down = async () => new Response(null, { status: 530 });
    const base = { id: 0, body: "{}", ip: null, ua: null, origin: null, received_at: Date.now() };
    for (let i = 0; i < 20_000; i++) env.DB.rows.push({ ...base, id: i + 1, path: i % 2 ? `/api/ingest/${KEY}` : `/api/ingest/${KEY}/push` });
    expect((await handle(report(1), env, down)).status).toBe(503);
    const other = new Request("https://app.gora8.com/api/ingest/d2k_otherKEYotherKEYother", { method: "POST", body: "{}" });
    expect((await handle(other, env, down)).status).toBe(202);
    // A key that merely starts the same isn't counted with it.
    const longer = new Request(`https://app.gora8.com/api/ingest/${KEY}x`, { method: "POST", body: "{}" });
    expect((await handle(longer, env, down)).status).toBe(202);
  });

  test("Live config: passed through and kept; served from the kept copy while day2 is away", async () => {
    const env = { DB: fakeD1(), INBOX_TOKEN: "t" };
    const get = (headers: Record<string, string> = {}) => new Request(`https://app.gora8.com/api/ingest/${KEY}/config?p=ios`, { headers });
    const body = JSON.stringify({ v: 1, version: 4, values: { "onboarding.title": "Hi" }, experiments: [] });
    const up = async () => new Response(body, { status: 200, headers: { etag: '"4"', "content-type": "application/json" } });
    const res = await handle(get(), env, up);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
    expect(env.DB.configs.get(KEY)).toMatchObject({ body, etag: '"4"' });
    // day2 asleep: the kept copy, with its etag (and 304 when the app has it).
    const down = async () => new Response(null, { status: 530 });
    const kept = await handle(get(), env, down);
    expect(kept.status).toBe(200);
    expect(kept.headers.get("x-day2-kept")).toBe("1");
    expect(kept.headers.get("etag")).toBe('"4"');
    expect(await kept.json()).toMatchObject({ version: 4 });
    expect((await handle(get({ "if-none-match": '"4"' }), env, down)).status).toBe(304);
    // day2's own 304 passes through; nothing kept for an unknown key.
    expect((await handle(get({ "if-none-match": '"4"' }), env, async () => new Response(null, { status: 304 }))).status).toBe(304);
    const other = new Request("https://app.gora8.com/api/ingest/d2k_otherKEYotherKEYother/config", {});
    expect((await handle(other, env, down)).status).toBe(503);
    expect(env.DB.rows).toEqual([]);
  });

  test("push tokens and store notifications are kept like reports; the stores hear 200", async () => {
    const env = { DB: fakeD1(), INBOX_TOKEN: "secret" };
    const down = async () => new Response(null, { status: 530 });
    const push = new Request(`https://app.gora8.com/api/ingest/${KEY}/push`, { method: "POST", body: '{"user":"u_x","token":"t"}' });
    expect((await handle(push, env, down)).status).toBe(202);
    const apple = new Request("https://app.gora8.com/api/store-notify/apple/app_dotty", { method: "POST", body: '{"signedPayload":"eyJ..."}', headers: { "content-type": "application/json", authorization: "Bearer x" } });
    expect((await handle(apple, env, down)).status).toBe(200);
    const google = new Request("https://app.gora8.com/api/store-notify/google/app_dotty", { method: "POST", body: '{"message":{"data":"e30="}}', headers: { "content-type": "application/json" } });
    expect((await handle(google, env, down)).status).toBe(200);
    // Not a store day2 knows: straight through, nothing kept.
    expect((await handle(new Request("https://app.gora8.com/api/store-notify/amazon/app_dotty", { method: "POST", body: "{}" }), env, down)).status).toBe(530);
    expect(env.DB.rows.map((r) => r.path)).toEqual([`/api/ingest/${KEY}/push`, "/api/store-notify/apple/app_dotty", "/api/store-notify/google/app_dotty"]);

    // day2 is back: each goes to its own path, store notifications as JSON, without the authorization header.
    const seen: Array<{ path: string; type: string | null; auth: string | null; body: string }> = [];
    const viaWorker = ((u: string | URL | Request, init?: RequestInit) => handle(new Request(String(u), init), env, async () => new Response())) as typeof fetch;
    const r = await drainInbox({
      url: "https://app.gora8.com",
      token: "secret",
      doFetch: viaWorker,
      handle: async (req) => {
        seen.push({ path: new URL(req.url).pathname, type: req.headers.get("content-type"), auth: req.headers.get("authorization"), body: await req.text() });
        return new Response(null, { status: 200 });
      },
    });
    expect(r.taken).toBe(3);
    expect(seen.map((x) => [x.path, x.type])).toEqual([
      [`/api/ingest/${KEY}/push`, "text/plain"],
      ["/api/store-notify/apple/app_dotty", "application/json"],
      ["/api/store-notify/google/app_dotty", "application/json"],
    ]);
    expect(seen[1]).toMatchObject({ auth: null, body: '{"signedPayload":"eyJ..."}' });
  });
});

test("a store notification nobody handles yet (404) waits in the inbox instead of being dropped", async () => {
  const env = { DB: fakeD1(), INBOX_TOKEN: "secret" };
  await handle(new Request("https://app.gora8.com/api/store-notify/apple/app_dotty", { method: "POST", body: "{}" }), env, async () => new Response(null, { status: 530 }));
  const viaWorker = ((u: string | URL | Request, init?: RequestInit) => handle(new Request(String(u), init), env, async () => new Response())) as typeof fetch;
  const r = await drainInbox({ url: "https://app.gora8.com", token: "secret", doFetch: viaWorker, handle: async () => new Response(null, { status: 404 }) });
  expect(r).toMatchObject({ taken: 0, refused: 0, skipped: 1, lastError: "report 1: 404" });
  expect(env.DB.rows).toHaveLength(1);
});
