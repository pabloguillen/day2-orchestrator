// day2's inbox at Cloudflare: reports from apps reach day2 even while the
// computer running day2 sleeps. A Cloudflare Worker in front of day2's
// address passes each report on as usual; when day2 can't be reached, it
// keeps the report in a small database (D1) and answers the app "accepted".
// day2 fetches what's waiting when it's back (/__inbox), handles it like any
// report, and confirms (/__inbox/ack), which deletes it here.
//
// Kept the same way: push tokens from apps, and purchase notifications from
// the App Store and Google Play (/api/store-notify/apple|google/<app>). RevenueCat webhooks pass straight
// through: they are authorized by a header the inbox must not keep, and
// RevenueCat retries them itself while day2 is away.
//
// Live settings (GET /api/ingest/<key>/config): passed through; the last good
// answer per key is kept here and served while day2 can't be reached, so
// apps get their settings and experiments while the computer sleeps.
//
// It needs no Anthropic key: it stores, nothing more. Setup: deploy/inbox/setup.sh.

const INGEST = /^\/api\/ingest\/d2k_[A-Za-z0-9_-]{8,64}(\/push)?$/;
const STORE_NOTIFY = /^\/api\/store-notify\/(apple|google)\/[A-Za-z0-9_-]{1,64}$/;
const CONFIG = /^\/api\/ingest\/(d2k_[A-Za-z0-9_-]{8,64})\/config$/;
const MAX_BODY = 66_000; // a report batch (64 kB) and a little room
const MAX_WAITING = 200_000; // reports kept at most; more are refused until day2 is back
const MAX_PER_KEY = 20_000; // per app key (or per store-notify app): one flooded key can't fill the inbox
const KEEP_DAYS = 14;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, if-none-match", "access-control-expose-headers": "etag" };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** True when day2 itself answered (anything but "can't reach the origin"). */
function reached(res) {
  if (!res) return false;
  // 52x / 530: Cloudflare couldn't reach the tunnel; 502-504: nothing behind it.
  return !(res.status >= 520 || res.status === 502 || res.status === 503 || res.status === 504);
}

async function inbox(req, env, url) {
  const auth = req.headers.get("authorization") ?? "";
  if (!env.INBOX_TOKEN || auth !== `Bearer ${env.INBOX_TOKEN}`) return json({ error: "Not allowed." }, 401);
  if (req.method === "GET" && url.pathname === "/__inbox") {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
    // Reports after this id: day2 skips one it can't take yet and goes on with the rest.
    const after = Math.max(0, Math.floor(Number(url.searchParams.get("after")) || 0));
    await env.DB.prepare("DELETE FROM inbox WHERE received_at < ?").bind(Date.now() - KEEP_DAYS * 86_400_000).run();
    const { results } = await env.DB.prepare("SELECT id, path, body, ip, ua, origin, received_at FROM inbox WHERE id > ? ORDER BY id LIMIT ?").bind(after, limit).all();
    const waiting = (await env.DB.prepare("SELECT count(*) AS n FROM inbox").first())?.n ?? 0;
    return json({ reports: results ?? [], waiting });
  }
  if (req.method === "POST" && url.pathname === "/__inbox/ack") {
    const ids = ((await req.json().catch(() => ({}))).ids ?? []).filter((x) => Number.isInteger(x)).slice(0, 500);
    if (ids.length) await env.DB.prepare(`DELETE FROM inbox WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).run();
    return json({ deleted: ids.length });
  }
  return json({ error: "Not found." }, 404);
}

/** Live config: day2's answer when it gives one (kept), else the last kept answer. */
async function liveConfig(req, env, toOrigin, key) {
  let res = null;
  try {
    res = await toOrigin(req);
  } catch {
    res = null;
  }
  if (reached(res)) {
    if (res.status === 200) {
      const body = await res.text();
      const etag = res.headers.get("etag");
      try {
        await env.DB.prepare("INSERT INTO live_config (key, body, etag, saved_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET body = excluded.body, etag = excluded.etag, saved_at = excluded.saved_at")
          .bind(key, body, etag, Date.now())
          .run();
      } catch {
        // Keeping a copy must never break the answer.
      }
      return new Response(body, { status: 200, headers: res.headers });
    }
    return res;
  }
  // day2 is away: the last good config, if there is one.
  const kept = await env.DB.prepare("SELECT body, etag FROM live_config WHERE key = ?")
    .bind(key)
    .first()
    .catch(() => null);
  if (!kept) return new Response(null, { status: 503, headers: CORS });
  const headers = { ...CORS, "content-type": "application/json", "cache-control": "public, max-age=60", "x-day2-kept": "1", ...(kept.etag ? { etag: kept.etag } : {}) };
  if (kept.etag && (req.headers.get("if-none-match") ?? "").split(",").map((t) => t.trim()).includes(kept.etag)) return new Response(null, { status: 304, headers });
  return new Response(kept.body, { status: 200, headers });
}

/** The Worker's logic, with day2's origin passed in (tests use a fake). */
export async function handle(req, env, toOrigin) {
  const url = new URL(req.url);
  if (url.pathname === "/__inbox" || url.pathname === "/__inbox/ack") return inbox(req, env, url);
  const config = req.method === "GET" ? url.pathname.match(CONFIG) : null;
  if (config) return liveConfig(req, env, toOrigin, config[1]);
  const notify = STORE_NOTIFY.test(url.pathname);
  if (req.method !== "POST" || !(INGEST.test(url.pathname) || notify)) {
    // Contracts (GET) and anything else: straight through; nothing to keep.
    return toOrigin(req).catch(() => new Response(null, { status: 503, headers: CORS }));
  }
  const body = await req.text();
  if (body.length > MAX_BODY) return new Response(null, { status: 413, headers: CORS });
  let res = null;
  try {
    res = await toOrigin(new Request(req.url, { method: "POST", headers: req.headers, body }));
  } catch {
    res = null;
  }
  if (reached(res)) return res;
  // day2 is away: keep the report for later.
  const waiting = (await env.DB.prepare("SELECT count(*) AS n FROM inbox").first())?.n ?? 0;
  if (waiting >= MAX_WAITING) return new Response(null, { status: 503, headers: CORS });
  // Per key: /api/ingest/<key> and /api/ingest/<key>/push count together; a store-notify path is its own.
  const base = notify ? url.pathname : url.pathname.replace(/\/push$/, "");
  const mine = (await env.DB.prepare("SELECT count(*) AS n FROM inbox WHERE path = ? OR substr(path, 1, ?) = ?").bind(base, base.length + 1, `${base}/`).first())?.n ?? 0;
  if (mine >= MAX_PER_KEY) return new Response(null, { status: 503, headers: CORS });
  await env.DB.prepare("INSERT INTO inbox (path, body, ip, ua, origin, received_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(url.pathname, body, req.headers.get("cf-connecting-ip"), (req.headers.get("user-agent") ?? "").slice(0, 300), req.headers.get("origin"), Date.now())
    .run();
  // The stores count only 200 as delivered (and would retry); apps take 202.
  return new Response(null, { status: notify ? 200 : 202, headers: CORS });
}

export default {
  fetch: (req, env) => handle(req, env, (r) => fetch(r, { signal: AbortSignal.timeout(8000) })),
};
