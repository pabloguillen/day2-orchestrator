import { MAX_BATCH_BYTES, type Batch, type DeviceInfo, type Failure, type GrowthEvent } from "../packages/sensors/src/types";
import { INGEST_KEY_RE, type FieldStore, type IngestKeys } from "./field-store";

/**
 * Where apps send what they observe on users' devices:
 *
 *   POST /api/ingest/<key>            a batch (text/plain JSON — no CORS preflight, works with sendBeacon)
 *   GET  /api/ingest/<key>/contracts  the latest contracts day2 generated for the app
 *
 * The key is in the app's code, so it's public: it can only send reports
 * for its one app, and nothing can be read with it except the contracts
 * (no user data). Everything is size-limited, re-shaped field by field
 * (unknown fields dropped) and rate-limited per key and per address. A
 * browser request from another site than the app's own address is refused.
 */

export type IngestDeps = {
  keys: IngestKeys;
  store: FieldStore;
  /** The app's live address, to check where browser requests come from. */
  appBaseUrl: (appId: string, accountId: string) => Promise<string | null>;
  now?: () => Date;
};

const PER_KEY_PER_MIN = 120;
const PER_IP_PER_MIN = 300;
const CHANNELS = new Set(["paid", "shared_link", "invite", "search", "ai_assistant", "referral", "direct"]);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

const reply = (status: number, body?: unknown, extra: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { ...CORS, ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra } });

// ---- Rate limits (per process; one API server in production) ----

const windows = new Map<string, { start: number; n: number }>();
function allowed(bucket: string, limit: number, now: number): boolean {
  const w = windows.get(bucket);
  if (!w || now - w.start >= 60_000) {
    windows.set(bucket, { start: now, n: 1 });
    if (windows.size > 50_000) windows.clear();
    return true;
  }
  w.n += 1;
  return w.n <= limit;
}
export const resetRateLimits = () => windows.clear();

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
          }
        : undefined;
    events.push({ type, at, ...(acquisition && Object.keys(acquisition).length ? { acquisition } : {}) });
  }

  return { v: 1, ...(str(r.release, 60) ? { release: str(r.release, 60) } : {}), device, passes, failures, events };
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

export async function handleIngest(req: Request, deps: IngestDeps): Promise<Response> {
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/api\/ingest\/([^/]+)(\/contracts)?$/);
  if (!m) return reply(404, { error: "Not found." });
  if (req.method === "OPTIONS") return reply(204);
  const key = decodeURIComponent(m[1]!);
  if (!INGEST_KEY_RE.test(key)) return reply(404, { error: "Unknown key." });
  const now = deps.now?.() ?? new Date();
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "?";
  if (!allowed(`k:${key}`, PER_KEY_PER_MIN, now.getTime()) || !allowed(`i:${ip}`, PER_IP_PER_MIN, now.getTime())) return reply(429, { error: "Too many reports — slow down." }, { "retry-after": "60" });

  const owner = await deps.keys.resolve(key);
  if (!owner) return reply(404, { error: "Unknown key." });

  if (m[2]) {
    if (req.method !== "GET") return reply(405, { error: "Use GET." });
    const c = await deps.store.contracts(owner.appId);
    return reply(200, c?.file ?? { version: 1, generatedAt: now.toISOString(), contracts: [] }, { "cache-control": "public, max-age=300" });
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
  await deps.store.record(owner.appId, batch, now);
  return reply(204);
}
