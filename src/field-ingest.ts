import { MAX_BATCH_BYTES, type Batch, type DeviceInfo, type Failure, type GrowthEvent, type LiveConfig } from "../packages/sensors/src/types";
import { INGEST_KEY_RE, type FieldStore, type IngestKeys } from "./field-store";
import { replayOf } from "./ingest-inbox";
import { createLimiter, requestIp } from "./rate-limit";

/**
 * Where apps send what they observe on users' devices:
 *
 *   POST /api/ingest/<key>            a batch (text/plain JSON — no CORS preflight, works with sendBeacon)
 *   GET  /api/ingest/<key>/contracts  the latest contracts day2 generated for the app
 *   GET  /api/ingest/<key>/config     the app's Live config (src/live/, docs/live.md), with an etag
 *   POST /api/ingest/<key>/push       a push token for a hashed user (stored by Messages, never in events)
 *
 * The key is in the app's code, so it's public: it can only send reports
 * for its one app, and nothing can be read with it except the contracts
 * (no user data). Everything is size-limited, re-shaped field by field
 * (unknown fields dropped) and rate-limited per address first, then per
 * known key (push registrations also per hashed user). A browser request
 * from another site than the app's own address is refused. Reports the
 * inbox Worker kept while day2 was away are replayed in-process
 * (ingest-inbox.ts) with their own, larger allowance per key.
 */

export type IngestDeps = {
  keys: IngestKeys;
  store: FieldStore;
  /** The app's live address, to check where browser requests come from. */
  appBaseUrl: (appId: string, accountId: string) => Promise<string | null>;
  /** The app's Live config (src/live/config.ts serveConfig); absent = an empty config. */
  liveConfig?: (owner: { appId: string; accountId: string }) => Promise<LiveConfig>;
  /** Push tokens per hashed user (the Messages module); absent = accepted, nothing stored. */
  pushTokens?: { save(appId: string, t: PushTokenRecord): Promise<void> };
  now?: () => Date;
};

/**
 * A push registration. `device` is the library's device id (the field-batch
 * `device.id`) that sent it: the token is bound to that device, and only it
 * can replace or clear that user's token on it (src/messages/tokens.ts).
 */
export type PushTokenRecord = { user: string; device: string; token: string | null; platform: "ios" | "android"; tz: string | null; locale?: string | null; at: string };

const PER_KEY_PER_MIN = 120;
/** Config and contracts are read on every launch: their own, larger allowance. */
const READS_PER_KEY_PER_MIN = 1200;
const PER_IP_PER_MIN = 300;
/** Replays from the inbox (a backlog arriving at once): per key, no per-address limit. */
const REPLAYS_PER_KEY_PER_MIN = 6000;
/** Push registrations per hashed user and hour (a device sends one per token change). */
const PUSH_PER_USER_PER_HOUR = 20;
const CHANNELS = new Set(["paid", "shared_link", "invite", "search", "ai_assistant", "referral", "direct"]);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, if-none-match",
  "access-control-expose-headers": "etag",
  "access-control-max-age": "86400",
};

const reply = (status: number, body?: unknown, extra: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { ...CORS, ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra } });

// ---- Rate limits (per process; one API server in production) ----

const limiter = createLimiter(50_000);
export const resetRateLimits = () => limiter.reset();
/** For tests: how many rate-limit buckets exist. */
export const rateLimitBuckets = () => limiter.size();

// ---- Re-shaping what came in ----

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined);
const int = (v: unknown, max: number): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : undefined);

/** Small JSON only; anything larger is replaced by a note. */
function small(v: unknown, maxBytes: number): unknown {
  if (v === undefined) return undefined;
  try {
    const s = JSON.stringify(v);
    return s.length <= maxBytes ? JSON.parse(s) : "(too large)";
  } catch {
    return "(unreadable)";
  }
}

function time(v: unknown, now: Date): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  // Device clocks drift; a report more than a day off is dated to arrival.
  return Math.abs(t - now.getTime()) > 86_400_000 ? now.toISOString() : new Date(t).toISOString();
}

const CLICK_PARAMS = new Set(["fbclid", "ttclid", "gclid", "gbraid", "wbraid", "li_fat_id", "ScCid", "epik", "rdt_cid", "twclid"]);

/** An ad platform's click id, if it's one day2 knows and looks like an id. */
function clickOf(v: unknown): { param: string; value: string } | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  if (typeof c.param !== "string" || !CLICK_PARAMS.has(c.param) || typeof c.value !== "string") return null;
  const value = c.value.trim().slice(0, 500);
  return /^[A-Za-z0-9._~%:=-]{4,500}$/.test(value) ? { param: c.param, value } : null;
}

const PROP_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const CURRENCY = /^[A-Z]{3}$/;
const VARIANT_ID = /^[A-Za-z0-9_.:-]{1,40}$/;

/** Event props: ≤ 8 keys of `^[a-z][a-z0-9_]{0,31}$`, strings ≤ 80 characters, finite numbers, booleans. Anything else is dropped. */
export function cleanProps(v: unknown): Record<string, string | number | boolean> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (Object.keys(out).length >= 8) break;
    if (!PROP_KEY.test(k)) continue;
    if (typeof x === "string") out[k] = x.slice(0, 80);
    else if (typeof x === "number" && Number.isFinite(x)) out[k] = x;
    else if (typeof x === "boolean") out[k] = x;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Money on an event: 0 ≤ amount < 10 000 (rounded to 1/10 000), an ISO 4217 code. Otherwise dropped. */
export function cleanValue(v: unknown): { amount: number; currency: string } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const x = v as Record<string, unknown>;
  if (typeof x.amount !== "number" || !Number.isFinite(x.amount) || x.amount < 0 || x.amount >= 10_000) return undefined;
  if (typeof x.currency !== "string" || !CURRENCY.test(x.currency)) return undefined;
  return { amount: Math.round(x.amount * 10_000) / 10_000, currency: x.currency };
}

/** Experiment id → variant, ≤ 20 entries, short ids only. */
export function cleanVariants(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (Object.keys(out).length >= 20) break;
    if (VARIANT_ID.test(k) && typeof x === "string" && VARIANT_ID.test(x)) out[k] = x;
  }
  return Object.keys(out).length ? out : undefined;
}

export function cleanBatch(raw: unknown, now: Date): Batch | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  const d = (r.device ?? {}) as Record<string, unknown>;
  const id = str(d.id, 64);
  const platform = d.platform === "web" || d.platform === "ios" || d.platform === "android" ? d.platform : null;
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id) || !platform) return null;
  const vp = d.viewport as Record<string, unknown> | undefined;
  const device: DeviceInfo = {
    id,
    platform,
    ...(str(d.os, 40) ? { os: str(d.os, 40) } : {}),
    ...(str(d.browser, 40) ? { browser: str(d.browser, 40) } : {}),
    ...(str(d.model, 60) ? { model: str(d.model, 60) } : {}),
    ...(vp && int(vp.w, 10000) !== undefined && int(vp.h, 10000) !== undefined ? { viewport: { w: int(vp.w, 10000)!, h: int(vp.h, 10000)! } } : {}),
    ...(str(d.locale, 20) ? { locale: str(d.locale, 20) } : {}),
    ...(d.theme === "light" || d.theme === "dark" ? { theme: d.theme } : {}),
    ...(int(d.textScale, 10) !== undefined ? { textScale: int(d.textScale, 10) } : {}),
    ...(str(d.network, 20) ? { network: str(d.network, 20) } : {}),
  };

  const passes: Record<string, number> = {};
  if (r.passes && typeof r.passes === "object") {
    for (const [k, v] of Object.entries(r.passes as Record<string, unknown>).slice(0, 500)) {
      const n = int(v, 100_000);
      if (k.length <= 300 && n) passes[k] = n;
    }
  }

  const failures: Failure[] = [];
  for (const f of (Array.isArray(r.failures) ? r.failures : []).slice(0, 50)) {
    if (!f || typeof f !== "object") continue;
    const x = f as Record<string, unknown>;
    const contract = str(x.contract, 300);
    const at = time(x.at, now);
    if (!contract || !at) continue;
    const ev = x.evidence as Record<string, unknown> | undefined;
    failures.push({
      contract,
      at,
      route: str(x.route, 200) ?? "/",
      expected: small(x.expected, 2000),
      actual: small(x.actual, 2000),
      ...(ev && typeof ev === "object" ? { evidence: small(ev, 4000) as Failure["evidence"] } : {}),
      steps: (Array.isArray(x.steps) ? x.steps : []).slice(-20).flatMap((s) => (typeof s === "string" ? [s.slice(0, 120)] : [])),
    });
  }

  const events: GrowthEvent[] = [];
  const USER_RE = /^u_[0-9a-f]{32}$/;
  for (const e of (Array.isArray(r.events) ? r.events : []).slice(0, 200)) {
    if (!e || typeof e !== "object") continue;
    const x = e as Record<string, unknown>;
    const type = str(x.type, 40);
    const at = time(x.at, now);
    if (!type || !/^[A-Za-z0-9_.-]+$/.test(type) || !at) continue;
    const a = x.acquisition as Record<string, unknown> | undefined;
    const acquisition =
      a && typeof a === "object"
        ? {
            ...(str(a.campaignId, 40) ? { campaignId: str(a.campaignId, 40) } : {}),
            ...(typeof a.channel === "string" && CHANNELS.has(a.channel) ? { channel: a.channel } : {}),
            ...(clickOf(a.click) ? { click: clickOf(a.click)! } : {}),
          }
        : undefined;
    // Users arrive hashed by the library (hashUser); anything else is dropped.
    const user = typeof x.user === "string" && USER_RE.test(x.user) ? x.user : undefined;
    const props = cleanProps(x.props);
    const value = cleanValue(x.value);
    events.push({ type, at, ...(user ? { user } : {}), ...(acquisition && Object.keys(acquisition).length ? { acquisition } : {}), ...(props ? { props } : {}), ...(value ? { value } : {}) });
  }
  const variants = cleanVariants(r.variants);

  return { v: 1, ...(str(r.release, 60) ? { release: str(r.release, 60) } : {}), device, passes, failures, events, ...(variants ? { variants } : {}) };
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;

function originAllowed(origin: string | null, appBaseUrl: string | null): boolean {
  if (!origin || !appBaseUrl) return true; // mobile apps send no Origin; no address set yet
  try {
    const o = new URL(origin).hostname;
    const a = new URL(appBaseUrl).hostname;
    return o === a || o.endsWith(`.${a}`) || LOCAL_HOST.test(o);
  } catch {
    return false;
  }
}

type Owner = { appId: string; accountId: string };
type SubRoute = { method: "GET" | "POST"; handle: (req: Request, owner: Owner, deps: IngestDeps, now: Date) => Promise<Response> };
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const USER_ID_RE = /^u_[0-9a-f]{32}$/;

/** `/api/ingest/<key>/<sub>`: one small handler each (docs/self-improving-app.md, "Ingest sub-routes"). */
const SUB_ROUTES: Record<string, SubRoute> = {
  contracts: {
    method: "GET",
    async handle(_req, owner, deps, now) {
      const c = await deps.store.contracts(owner.appId);
      return reply(200, c?.file ?? { version: 1, generatedAt: now.toISOString(), contracts: [] }, { "cache-control": "public, max-age=300" });
    },
  },
  config: {
    method: "GET",
    async handle(req, owner, deps) {
      const config: LiveConfig = deps.liveConfig ? await deps.liveConfig(owner) : { v: 1, version: 0, values: {}, experiments: [] };
      const etag = `"${config.version}"`;
      const headers = { "cache-control": "public, max-age=60", etag };
      const have = (req.headers.get("if-none-match") ?? "").split(",").map((t) => t.trim().replace(/^W\//, ""));
      if (have.includes(etag)) return reply(304, undefined, headers);
      return reply(200, config, headers);
    },
  },
  push: {
    method: "POST",
    async handle(req, owner, deps, now) {
      const text = await req.text();
      if (text.length > 2000) return reply(413, { error: "Too large." });
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return reply(400, { error: "Not JSON." });
      }
      if (!raw || typeof raw !== "object") return reply(400, { error: "Not JSON." });
      const user = typeof raw.user === "string" && USER_ID_RE.test(raw.user) ? raw.user : null;
      const device = typeof raw.device === "string" && DEVICE_ID_RE.test(raw.device) ? raw.device : null;
      const token = raw.token === null ? null : typeof raw.token === "string" && /^[\x21-\x7e]{8,256}$/.test(raw.token) ? raw.token : undefined;
      const platform = raw.platform === "ios" || raw.platform === "android" ? raw.platform : null;
      const tz = typeof raw.tz === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(raw.tz) ? raw.tz : null;
      const locale = typeof raw.locale === "string" && /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8}){0,2}$/.test(raw.locale) ? raw.locale : null;
      if (!user || !device || token === undefined || !platform) return reply(400, { error: "Needs user (hashed), device, token and platform." });
      if (!limiter.allow(`p:${owner.appId}:${user}`, PUSH_PER_USER_PER_HOUR, now.getTime(), 3_600_000)) return reply(429, { error: "Too many push registrations for this user." }, { "retry-after": "3600" });
      const replay = replayOf(req);
      const at = replay ? new Date(replay.receivedAt) : now;
      if (deps.pushTokens) await deps.pushTokens.save(owner.appId, { user, device, token, platform, tz, locale, at: (Number.isNaN(at.getTime()) ? now : at).toISOString() });
      return reply(204);
    },
  },
};

export async function handleIngest(req: Request, deps: IngestDeps): Promise<Response> {
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/api\/ingest\/([^/]+)(?:\/([a-z]+))?$/);
  if (!m) return reply(404, { error: "Not found." });
  const sub = m[2] ? SUB_ROUTES[m[2]] : null;
  if (m[2] && !sub) return reply(404, { error: "Not found." });
  if (req.method === "OPTIONS") return reply(204);
  const key = decodeURIComponent(m[1]!);
  if (!INGEST_KEY_RE.test(key)) return reply(404, { error: "Unknown key." });
  const now = deps.now?.() ?? new Date();
  const t = now.getTime();
  // A replay of what the inbox Worker kept: marked in-process by drainInbox, never by a header.
  const replay = replayOf(req);
  const ip = (replay ? replay.ip : requestIp(req)) ?? "?";
  const busy = () => reply(429, { error: "Too many reports — slow down." }, { "retry-after": "60" });
  // The address first, so junk keys can't create buckets; then only keys that exist get one.
  if (!replay && !limiter.allow(`i:${ip}`, PER_IP_PER_MIN, t)) return busy();
  const owner = await deps.keys.resolve(key);
  if (!owner) return reply(404, { error: "Unknown key." });
  const read = sub?.method === "GET";
  const [bucket, keyLimit] = replay ? [`R:${key}`, REPLAYS_PER_KEY_PER_MIN] : read ? [`r:${key}`, READS_PER_KEY_PER_MIN] : [`k:${key}`, PER_KEY_PER_MIN];
  if (!limiter.allow(bucket, keyLimit, t)) return busy();

  if (sub) {
    if (req.method !== sub.method) return reply(405, { error: `Use ${sub.method}.` });
    return sub.handle(req, owner, deps, now);
  }

  if (req.method !== "POST") return reply(405, { error: "Use POST." });
  if (!originAllowed(req.headers.get("origin"), await deps.appBaseUrl(owner.appId, owner.accountId))) return reply(403, { error: "Reports must come from the app's own address." });
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BATCH_BYTES + 2048) return reply(413, { error: "Batch too large." });
  const text = await req.text();
  if (text.length > MAX_BATCH_BYTES + 2048) return reply(413, { error: "Batch too large." });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return reply(400, { error: "Not JSON." });
  }
  const batch = cleanBatch(raw, now);
  if (!batch) return reply(400, { error: "Not a day2 batch." });
  // Ad platforms match conversions by click id plus the visitor's IP and
  // browser. Kept only on visits that came from an ad, and removed after
  // 7 days (field-store prune) — it's only needed to send the conversion.
  const ua = (req.headers.get("user-agent") ?? "").slice(0, 300);
  // Web visits only: from mobile apps day2 never keeps the IP address or device
  // details for ads, so the store privacy answers need no location data.
  if (ip !== "?" && batch.device.platform === "web") for (const e of batch.events) if (e.acquisition?.click) e.acquisition.click = { ...e.acquisition.click, ip: ip.slice(0, 64), ...(ua ? { ua } : {}) };
  await deps.store.record(owner.appId, batch, now);
  return reply(204);
}
