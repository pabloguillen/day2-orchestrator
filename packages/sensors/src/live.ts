import { sha256 } from "./lifecycle";
import type { AdCap, Audience, Json, LiveAd, LiveConfig, LiveExperiment, LiveMessage } from "./types";

/**
 * Live: settings and experiments from day2, inside the app (docs/live.md).
 *
 * Pure and platform-neutral: the native and web adapters give it storage,
 * fetch, a clock and a few lookups. No dependencies, no React. The same
 * assignment and audience rules run on day2's server (src/live/), so both
 * sides agree on who is in which variant.
 *
 * Rules:
 *  - The cached config is used at once on launch; a fresh one is fetched in
 *    the background and takes effect on the next launch, so values never
 *    change during a session. On the very first launch (nothing cached) the
 *    first fetch is waited for, at most 1.5 s.
 *  - Refetched when the app comes to the foreground, at most every 15 min.
 *  - The unit of assignment is the hashed user, else the device id when the
 *    app keeps one (identity "device"), else none: defaults, no experiments.
 *  - The first read of an experiment's key in a session sends `exposure`.
 */

export const FIRST_LAUNCH_WAIT_MS = 1500;
export const REFETCH_EVERY_MS = 15 * 60_000;
const DAY = 86_400_000;
const CONFIG_KEY = "day2.live";
const STATE_KEY = "day2.live.state";

// ---------------------------------------------------------------------------
// Shared with day2's server
// ---------------------------------------------------------------------------

/** Deterministic weighted assignment: the same unit always gets the same variant (src/experiments.ts assignVariant). */
export function assignVariant(unit: string, experiment: { name: string; variants: Array<{ name: string; weight: number }> }): string {
  const vs = experiment.variants;
  if (!vs.length) throw new Error(`experiment "${experiment.name}" has no variants`);
  const total = vs.reduce((s, v) => s + v.weight, 0);
  if (!(total > 0)) throw new Error(`experiment "${experiment.name}" has no positive-weight variants`);
  const fraction = parseInt(sha256(`${experiment.name}:${unit}`).slice(0, 8), 16) / 0x1_0000_0000;
  let cum = 0;
  for (const v of vs) {
    cum += v.weight / total;
    if (fraction < cum) return v.name;
  }
  return vs[vs.length - 1]!.name;
}

/** A stable number in [0, 100) for a unit and a salt (audience percent). */
export function bucketOf(unit: string, salt: string): number {
  return (parseInt(sha256(`${salt}:${unit}:percent`).slice(0, 8), 16) / 0x1_0000_0000) * 100;
}

/** "1.4.0(23)@3f2a9c1e" → [1, 4, 0]. */
export function versionParts(release: string | null | undefined): number[] | null {
  const m = (release ?? "").match(/^(\d+(?:\.\d+)*)/);
  return m ? m[1]!.split(".").map(Number) : null;
}

export function versionAtLeast(release: string | null | undefined, min: string): boolean {
  const a = versionParts(release);
  const b = versionParts(min);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export type AudienceContext = {
  platform: "ios" | "android" | "web";
  locale?: string | null;
  /** First launch with day2 on this device (ms). */
  installedAt?: number | null;
  now: number;
  fromAds?: boolean;
  release?: string | null;
  /** Needed for `percent`; without a unit, a percent audience never matches. */
  unit?: string | null;
};

const localeMatches = (want: string, have: string) => {
  const w = want.toLowerCase();
  const h = have.toLowerCase().replace("_", "-");
  return w.includes("-") ? h === w : h === w || h.startsWith(`${w}-`);
};

/** Whether an audience includes this unit. `salt` keeps percent buckets independent per experiment, ad or message. */
export function inAudience(a: Audience | undefined, ctx: AudienceContext, salt = ""): boolean {
  if (!a) return true;
  if (a.platforms?.length && (ctx.platform === "web" || !a.platforms.includes(ctx.platform))) return false;
  if (a.locales?.length && !(ctx.locale && a.locales.some((l) => localeMatches(l, ctx.locale!)))) return false;
  if (a.newWithinDays !== undefined && !(ctx.installedAt && ctx.now - ctx.installedAt <= a.newWithinDays * DAY)) return false;
  if (a.fromAds !== undefined && Boolean(ctx.fromAds) !== a.fromAds) return false;
  if (a.minRelease && !versionAtLeast(ctx.release, a.minRelease)) return false;
  if (a.percent !== undefined && a.percent < 100 && !(ctx.unit && bucketOf(ctx.unit, salt) < a.percent)) return false;
  return true;
}

/** A UUID (version-4 shaped) for a user of this app: Apple's appAccountToken, Google's obfuscatedAccountId. day2 recomputes it from the hashed user. */
export function purchaseTokenFor(appKey: string, hashedUser: string): string {
  const h = sha256(`${appKey}:purchase:${hashedUser}`);
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The variant an experiment gives a unit, or null when the unit isn't in it. */
export function variantFor(exp: LiveExperiment, unit: string | null | undefined, ctx: AudienceContext): string | null {
  if (!unit || !exp.variants.length) return null;
  if (!inAudience(exp.audience, { ...ctx, unit }, exp.id)) return null;
  return assignVariant(unit, { name: exp.id, variants: exp.variants });
}

/** Picks the texts for the user's locale: exact ("pt-BR"), then language ("pt"), then the default. */
export function localized(m: LiveMessage, locale: string | null | undefined): { title: string; body: string; cta?: string } {
  const texts = m.locale ?? {};
  const l = (locale ?? "").replace("_", "-");
  const exact = Object.keys(texts).find((k) => k.toLowerCase() === l.toLowerCase());
  const lang = Object.keys(texts).find((k) => k.toLowerCase() === l.split("-")[0]!.toLowerCase());
  const t = (exact && texts[exact]) || (lang && texts[lang]) || null;
  return t ? { title: t.title, body: t.body, ...(t.cta ? { cta: t.cta } : {}) } : { title: m.title, body: m.body, ...(m.cta ? { cta: m.cta.label } : {}) };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export type Day2Message = { id: string; title: string; body: string; cta?: { label: string; route?: string; url?: string } };
export type AdPlacement = { show: boolean; unitId: string | null; format: LiveAd["format"] | null };
export type Revenue = { kind: "subscription" | "purchase" | "ad"; amount: number; currency: string; productId?: string; placement?: string };

export type LiveStorage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };

export type LiveEnv = {
  key: string;
  /** e.g. https://day2.example/api/ingest/d2k_… */
  ingest: string;
  platform: "ios" | "android" | "web";
  release?: string | null;
  locale?: string | null;
  storage?: LiveStorage | null;
  fetch: typeof fetch;
  now(): number;
  /** The hashed user, when the app identified one. */
  user(): string | null;
  /** The device id when the app keeps one across launches (identity "device"), else null. */
  device(): string | null;
  /**
   * The id field batches carry (`device.id`, also when it isn't kept across
   * launches): sent with push tokens, which day2 binds to the device that
   * registered them — only that device can replace or clear its token.
   */
  pushDevice?(): string | null;
  /** Sends an event (props / value) through the engine. */
  track(type: string, extra?: { props?: Record<string, string | number | boolean>; value?: { amount: number; currency: string } }): void;
  /** Stamps the exposure on every following batch (Batch.variants). */
  setVariant(experiment: string, variant: string): void;
  /** Crashes or broken checks in this session. */
  problems(): number;
  fromAds?(): boolean;
  /** Time zone for push (Intl), if known. */
  timeZone?: string | null;
  setTimeout?(fn: () => void, ms: number): unknown;
};

/** Counters kept across launches (in `storage`, else for this launch only). */
type LiveCounters = {
  installedAt: number;
  ads: Record<string, { day: string; today: number; last: number }>;
  messages: Record<string, { total: number; day: string; today: number }>;
  events: Record<string, number>;
  reviewAskedAt: number | null;
  push: string | null;
};

export type Live = {
  value<T>(key: string, fallback: T): T;
  variant(experimentId: string): string | null;
  revenue(r: Revenue): void;
  purchaseToken(): string | null;
  adPlacement(id: string): AdPlacement;
  adShown(id: string): void;
  setPushToken(token: string | null): void;
  message(trigger: string): Day2Message | null;
  messageEvent(id: string, what: "shown" | "tapped" | "dismissed"): void;
  shouldAskForReview(): boolean;
  /** Whether this session's config is settled (cached, fetched on first launch, or given up after 1.5 s). */
  ready(): boolean;
  /** Called once when the session's config settles (useDay2Value re-renders). */
  onReady(cb: () => void): () => void;
  /** The app came to the foreground: refetch for next launch (at most every 15 minutes). */
  foreground(): void;
  /** An event the app tracked (for the review moment). */
  counted(type: string): void;
  /** The user changed (identify): sends a waiting push token. */
  identified(): void;
  /** Resolves when the config settled; for tests and the first render. */
  settled: Promise<void>;
};

const today = (now: number) => new Date(now).toISOString().slice(0, 10);
const sameType = (fallback: unknown, v: unknown) =>
  fallback === null || fallback === undefined || (Array.isArray(fallback) ? Array.isArray(v) : typeof v === typeof fallback && Array.isArray(v) === Array.isArray(fallback));

function validConfig(x: unknown): x is LiveConfig {
  if (!x || typeof x !== "object") return false;
  const c = x as LiveConfig;
  return c.v === 1 && typeof c.version === "number" && !!c.values && typeof c.values === "object" && Array.isArray(c.experiments);
}

export function startLive(env: LiveEnv): Live {
  const mem = new Map<string, string>();
  const store: LiveStorage = env.storage ?? { getItem: async (k) => mem.get(k) ?? null, setItem: async (k, v) => void mem.set(k, v) };
  const later = env.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));

  let active: LiveConfig | null = null;
  let isReady = false;
  let lastFetch = 0;
  let etag: number | null = null;
  const listeners = new Set<() => void>();
  const exposed = new Map<string, string>();
  const sessionAds = new Map<string, number>();
  let pendingPush: { token: string | null } | null = null;
  const counters: LiveCounters = { installedAt: env.now(), ads: {}, messages: {}, events: {}, reviewAskedAt: null, push: null };
  let saveQueued = false;

  const save = () => {
    if (saveQueued) return;
    saveQueued = true;
    later(() => {
      saveQueued = false;
      void store.setItem(STATE_KEY, JSON.stringify(counters)).catch(() => {});
    }, 0);
  };

  const settle = (cfg: LiveConfig | null) => {
    if (isReady) return;
    isReady = true;
    active = cfg;
    for (const l of listeners) l();
    listeners.clear();
  };

  const fetchConfig = async (): Promise<LiveConfig | null> => {
    lastFetch = env.now();
    const q = `p=${env.platform}${env.release ? `&r=${encodeURIComponent(env.release)}` : ""}`;
    try {
      const res = await env.fetch(`${env.ingest}/config?${q}`, etag !== null ? { headers: { "if-none-match": `"${etag}"` } } : undefined);
      if (res.status === 304 || !res.ok) return null;
      const body = (await res.json()) as unknown;
      if (!validConfig(body)) return null;
      etag = body.version;
      // Kept for the next launch.
      await store.setItem(CONFIG_KEY, JSON.stringify(body)).catch(() => {});
      return body;
    } catch {
      return null;
    }
  };

  const ctx = (unit: string | null): AudienceContext => ({
    platform: env.platform,
    locale: env.locale ?? null,
    installedAt: counters.installedAt,
    now: env.now(),
    fromAds: env.fromAds?.() ?? false,
    release: env.release ?? null,
    unit,
  });
  const unit = () => env.user() ?? env.device();

  const settled = (async () => {
    const [cached, saved] = await Promise.all([store.getItem(CONFIG_KEY).catch(() => null), store.getItem(STATE_KEY).catch(() => null)]);
    if (saved) {
      try {
        const s = JSON.parse(saved) as Partial<LiveCounters>;
        Object.assign(counters, {
          installedAt: typeof s.installedAt === "number" ? s.installedAt : counters.installedAt,
          ads: s.ads ?? {},
          messages: s.messages ?? {},
          events: { ...(s.events ?? {}), ...counters.events },
          reviewAskedAt: s.reviewAskedAt ?? null,
          push: s.push ?? null,
        });
      } catch {
        /* a broken state file starts over */
      }
    } else save();
    let cfg: LiveConfig | null = null;
    if (cached) {
      try {
        const c = JSON.parse(cached) as unknown;
        if (validConfig(c)) cfg = c;
      } catch {
        cfg = null;
      }
    }
    if (cfg) {
      etag = cfg.version;
      settle(cfg);
      // Fresh copy for next launch.
      void fetchConfig();
      return;
    }
    // First launch: wait for the first fetch, at most 1.5 s.
    const fetched = fetchConfig();
    const timeout = new Promise<null>((r) => later(() => r(null), FIRST_LAUNCH_WAIT_MS));
    settle(await Promise.race([fetched, timeout]));
  })();

  const expose = (exp: LiveExperiment, variant: string) => {
    if (exposed.get(exp.id) === variant) return;
    exposed.set(exp.id, variant);
    env.setVariant(exp.id, variant);
    env.track("exposure", { props: { exp: exp.id, variant } });
  };

  const sendPush = () => {
    if (!pendingPush) return;
    const user = env.user();
    if (!user) return;
    const token = pendingPush.token;
    const device = env.pushDevice?.() ?? null;
    if (!device) return;
    const sig = `${user}:${device}:${token ?? ""}`;
    pendingPush = null;
    if (counters.push === sig) return;
    void env
      .fetch(`${env.ingest}/push`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ user, device, token, platform: env.platform, tz: env.timeZone ?? null, locale: env.locale ?? null }),
      })
      .then((r) => {
        if (r.ok) {
          counters.push = sig;
          save();
        }
      })
      .catch(() => {});
  };

  const capAllows = (id: string, cap: AdCap, now: number): boolean => {
    const c = counters.ads[id];
    const day = today(now);
    if (cap.perSession !== undefined && (sessionAds.get(id) ?? 0) >= cap.perSession) return false;
    if (cap.perDay !== undefined && c && c.day === day && c.today >= cap.perDay) return false;
    if (cap.minSecondsBetween !== undefined && c && now - c.last < cap.minSecondsBetween * 1000) return false;
    return true;
  };

  const live: Live = {
    value<T>(key: string, fallback: T): T {
      const cfg = active;
      if (!cfg) return fallback;
      const u = unit();
      for (const exp of cfg.experiments) {
        if (!exp.keys.includes(key)) continue;
        const v = variantFor(exp, u, ctx(u));
        if (!v) continue;
        expose(exp, v);
        const vals = exp.variants.find((x) => x.name === v)?.values ?? {};
        if (key in vals && sameType(fallback, vals[key])) return vals[key] as T;
        break;
      }
      const d = cfg.values[key];
      return d !== undefined && sameType(fallback, d) ? (d as T) : fallback;
    },
    variant(experimentId) {
      const exp = active?.experiments.find((e) => e.id === experimentId);
      if (!exp) return null;
      const u = unit();
      const v = variantFor(exp, u, ctx(u));
      if (v) expose(exp, v);
      return v;
    },
    revenue(r) {
      if (!r || !(typeof r.amount === "number" && r.amount >= 0 && r.amount < 10_000) || typeof r.currency !== "string" || !/^[A-Z]{3}$/.test(r.currency)) return;
      const props: Record<string, string> = { kind: r.kind };
      if (r.productId) props.product = String(r.productId).slice(0, 80);
      if (r.placement) props.placement = String(r.placement).slice(0, 80);
      env.track("revenue", { value: { amount: r.amount, currency: r.currency }, props });
    },
    purchaseToken() {
      const u = env.user();
      return u ? purchaseTokenFor(env.key, u) : null;
    },
    adPlacement(id) {
      const ad = active?.ads?.[id];
      if (!ad) return { show: false, unitId: null, format: null };
      const unitId = (env.platform === "ios" ? ad.unitId.ios : env.platform === "android" ? ad.unitId.android : undefined) ?? null;
      const u = unit();
      // An experiment on this placement (key "ads.<id>") may switch it on/off or change its caps.
      const o = live.value<{ enabled?: unknown; cap?: unknown }>(`ads.${id}`, {});
      const enabled = typeof o.enabled === "boolean" ? o.enabled : ad.enabled;
      const cap = o.cap && typeof o.cap === "object" ? (o.cap as AdCap) : (ad.cap ?? {});
      const show = enabled && Boolean(unitId) && inAudience(ad.audience, ctx(u), `ad:${id}`) && capAllows(id, cap, env.now());
      return { show, unitId, format: ad.format };
    },
    adShown(id) {
      const now = env.now();
      const day = today(now);
      const c = counters.ads[id];
      counters.ads[id] = { day, today: c && c.day === day ? c.today + 1 : 1, last: now };
      sessionAds.set(id, (sessionAds.get(id) ?? 0) + 1);
      save();
      env.track("ad_shown", { props: { placement: id.slice(0, 80) } });
    },
    setPushToken(token) {
      if (token !== null && (typeof token !== "string" || !token || token.length > 256)) return;
      pendingPush = { token };
      sendPush();
    },
    message(trigger) {
      const cfg = active;
      if (!cfg?.messages?.length) return null;
      const now = env.now();
      const day = today(now);
      const u = unit();
      for (const m of cfg.messages) {
        if (m.trigger !== trigger) continue;
        const c = counters.messages[m.id];
        if (c && c.total >= m.cap.total) continue;
        if (c && c.day === day && c.today >= m.cap.perDay) continue;
        if (!inAudience(m.audience, ctx(u), `msg:${m.id}`)) continue;
        const t = localized(m, env.locale);
        return { id: m.id, title: t.title, body: t.body, ...(m.cta ? { cta: { ...m.cta, label: t.cta ?? m.cta.label } } : {}) };
      }
      return null;
    },
    messageEvent(id, what) {
      if (what === "shown") {
        const now = env.now();
        const day = today(now);
        const c = counters.messages[id];
        counters.messages[id] = { total: (c?.total ?? 0) + 1, day, today: c && c.day === day ? c.today + 1 : 1 };
        save();
      }
      env.track(`message_${what}`, { props: { message: id.slice(0, 80) } });
    },
    shouldAskForReview() {
      const r = active?.review;
      if (!r) return false;
      const now = env.now();
      if (r.notAfterProblem && env.problems() > 0) return false;
      if (now - counters.installedAt < r.minDaysSinceInstall * DAY) return false;
      if (counters.reviewAskedAt !== null && now - counters.reviewAskedAt < r.minDaysBetween * DAY) return false;
      for (const [type, n] of Object.entries(r.afterEvents ?? {})) if ((counters.events[type] ?? 0) < n) return false;
      counters.reviewAskedAt = now;
      save();
      env.track("review_prompt");
      return true;
    },
    ready: () => isReady,
    onReady(cb) {
      if (isReady) {
        cb();
        return () => {};
      }
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    foreground() {
      if (env.now() - lastFetch >= REFETCH_EVERY_MS) void fetchConfig();
    },
    counted(type) {
      if (type === "exposure" || type.startsWith("message_") || type === "ad_shown" || type === "revenue") return;
      counters.events[type] = (counters.events[type] ?? 0) + 1;
      save();
    },
    identified() {
      sendPush();
    },
    settled,
  };
  return live;
}

export type { Audience, Json, LiveConfig };

/** A Live that always gives the fallback (disabled, web without config, tests). */
export const NOOP_LIVE: Live = {
  value: (_k, f) => f,
  variant: () => null,
  revenue() {},
  purchaseToken: () => null,
  adPlacement: () => ({ show: false, unitId: null, format: null }),
  adShown() {},
  setPushToken() {},
  message: () => null,
  messageEvent() {},
  shouldAskForReview: () => false,
  ready: () => true,
  onReady: (cb) => (cb(), () => {}),
  foreground() {},
  counted() {},
  identified() {},
  settled: Promise.resolve(),
};
