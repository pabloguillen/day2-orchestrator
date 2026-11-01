// day2's inbox at Cloudflare: reports from apps reach day2 even while the
// computer running day2 sleeps. A Cloudflare Worker in front of day2's
// address passes each report on as usual; when day2 can't be reached, it
// keeps the report in a small database (D1) and answers the app "accepted".
// day2 fetches what's waiting when it's back (/__inbox), handles it like any
// report, and confirms (/__inbox/ack), which deletes it here.
//
// Only reports are kept — nothing else goes through this Worker. It needs no
// Anthropic key: it stores, nothing more. Setup: deploy/inbox/setup.sh.

const INGEST = /^\/api\/ingest\/d2k_[A-Za-z0-9_-]{8,64}$/;
const MAX_BODY = 66_000; // a report batch (64 kB) and a little room
const MAX_WAITING = 200_000; // reports kept at most; more are refused until day2 is back
const KEEP_DAYS = 14;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };

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
    await env.DB.prepare("DELETE FROM inbox WHERE received_at < ?").bind(Date.now() - KEEP_DAYS * 86_400_000).run();
    const { results } = await env.DB.prepare("SELECT id, path, body, ip, ua, origin, received_at FROM inbox ORDER BY id LIMIT ?").bind(limit).all();
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

/** The Worker's logic, with day2's origin passed in (tests use a fake). */
export async function handle(req, env, toOrigin) {
  const url = new URL(req.url);
  if (url.pathname === "/__inbox" || url.pathname === "/__inbox/ack") return inbox(req, env, url);
  if (req.method !== "POST" || !INGEST.test(url.pathname)) {
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
  await env.DB.prepare("INSERT INTO inbox (path, body, ip, ua, origin, received_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(url.pathname, body, req.headers.get("cf-connecting-ip"), (req.headers.get("user-agent") ?? "").slice(0, 300), req.headers.get("origin"), Date.now())
    .run();
  return new Response(null, { status: 202, headers: CORS });
}

export default {
  fetch: (req, env) => handle(req, env, (r) => fetch(r, { signal: AbortSignal.timeout(8000) })),
};
