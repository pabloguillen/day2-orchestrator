import { useEffect, useRef, useState } from "react";
import { AppState, Appearance, Dimensions, Linking, PixelRatio, Platform } from "react-native";
import { acquisitionFrom, cameFromTag, type CameFrom } from "./acquisition";
import { arm, hashUser } from "./lifecycle";
import { Engine, ERROR_SHOWN, LOADING_TARGET, normalizePath, type Env } from "./core";
import { NOOP_LIVE, startLive, type AdPlacement, type Day2Message, type Live, type Revenue } from "./live";
import type { Batch, Contract, ContractFile, DeviceInfo } from "./types";

export type { AdPlacement, Day2Message, Revenue } from "./live";

/**
 * day2 field contracts for React Native and Expo — the same engine as the
 * web, fed from what a React Native app has:
 *
 *   import { startDay2 } from "./day2/native";
 *   export const day2 = startDay2({ key: "d2k_…", endpoint: "https://day2.example" });
 *
 *   // screens: React Navigation…
 *   <NavigationContainer ref={navigationRef} onReady={() => day2.trackNavigation(navigationRef)}>
 *   // …or Expo Router
 *   const pathname = usePathname(); useEffect(() => day2.route(pathname), [pathname]);
 *
 *   // actions: the handler's contract is checked
 *   <Pressable onPress={day2.action("cart.continue", onContinue)}>
 *
 *   // what a screen needs to show; loading and error states
 *   <Text {...useDay2Mark("total")}>…</Text>
 *   <ActivityIndicator {...useDay2Mark("loading")} />
 *
 *   // Live settings and experiments (docs/live.md), set from day2 over the air
 *   const title = useDay2Value("onboarding.title", "Welcome");
 *   if (day2.adPlacement("home_banner").show) …
 *
 * Network calls are seen through XMLHttpRequest (React Native's fetch runs
 * on it), errors through the global error handler, freezes through a
 * JS-thread heartbeat. Nothing typed by the user, no query strings.
 */

export type NativeOptions = {
  key: string;
  endpoint: string;
  release?: string;
  contracts?: Contract[] | ContractFile;
  fetchContracts?: boolean;
  /**
   * "session" (default): a new random id each launch. "device": kept across
   * launches in `storage` (e.g. AsyncStorage) — only after consent where
   * the law requires it.
   */
  identity?: "session" | "device";
  storage?: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
  /** Device model, e.g. from expo-device's `Device.modelName`. */
  model?: string;
  /**
   * The ad platform's click id (from the ad link that opened the app), for
   * telling the platform which ad brought a sign-up. "off" (default): never
   * sent — nothing counts as tracking. "after_consent": kept on the device
   * and sent only when you call allowAdTracking() (on iOS after the App
   * Tracking Transparency prompt returns "granted").
   */
  adClickIds?: "off" | "after_consent";
  enabled?: boolean;
};

type NavRef = {
  addListener(event: "state", cb: () => void): () => void;
  getCurrentRoute(): { name: string } | undefined;
};

export type Day2Native = {
  track(type: string): void;
  check(id: string, ok: boolean, detail?: Record<string, number | boolean>): void;
  /** The current screen: a route name or an Expo Router pathname. */
  route(name: string): void;
  /** Follows a React Navigation container; returns a function that stops following. */
  trackNavigation(ref: NavRef): () => void;
  /** Wraps a press handler so its contract (`action:<name>`) is checked. */
  action<A extends unknown[], R>(name: string, handler?: (...args: A) => R, opts?: { testID?: string; label?: string }): (...args: A) => R | undefined;
  /** The signed-in user (day2 only receives a salted hash), or null on sign-out. After consent where required. */
  identify(userId: string | null): void;
  /** Whether this user gets a retention treatment ("on") or is held out to measure it. */
  treatment(id: string, holdout?: number): "on" | "holdout";
  /** Where this person first came from, when it was a day2 link (e.g. an ad), so the app can continue its promise. */
  cameFrom(): CameFrom | null;
  /** The user agreed to ad measurement (iOS: ATT "granted"): sends the ad's click id, once. Needs adClickIds: "after_consent". */
  allowAdTracking(): void;
  /** A Live setting for this user (an experiment's variant wins over the default); the fallback when there's none. Fixed for the session. */
  value<T>(key: string, fallback: T): T;
  /** "control", a variant name, or null when this user isn't in the experiment. */
  variant(experimentId: string): string | null;
  /** Money the app earned from this user (shown in day2, judged per experiment). */
  revenue(r: Revenue): void;
  /** A UUID for this user's purchases (Apple appAccountToken / Google obfuscatedAccountId), once identified; day2 can match it to the hashed user. */
  purchaseToken(): string | null;
  /** Whether to show an ad here now (enabled, audience, frequency caps), and its unit id for this platform. */
  adPlacement(id: string): AdPlacement;
  /** An ad was shown: counts toward its caps. */
  adShown(id: string): void;
  /** The Expo push token (or null when the user turned push off). Sent to day2 for the identified user, never in events. */
  setPushToken(token: string | null): void;
  /** The in-app message to show now for this trigger, honoring its caps; texts in the user's language when given. */
  message(trigger: string): Day2Message | null;
  messageEvent(id: string, what: "shown" | "tapped" | "dismissed"): void;
  /** True at a good moment to call expo-store-review's requestReview() (then remembered, so it isn't asked again too soon). */
  shouldAskForReview(): boolean;
  flush(): void;
  stop(): void;
};

export { arm, hashUser, mayNudge, stateOf } from "./lifecycle";

/**
 * The release to report: store version and build, plus the over-the-air
 * update the app runs (expo-updates), so day2 can tell each update's crash
 * rate from the one before — and roll it back. E.g.
 * releaseTag(Application.nativeApplicationVersion, Application.nativeBuildVersion, Updates.isEmbeddedLaunch ? null : Updates.updateId)
 * → "1.4.0(23)@3f2a9c1e"; the store build itself → "1.4.0(23)".
 */
export function releaseTag(version: string | null | undefined, build: string | null | undefined, updateId: string | null | undefined): string {
  const v = `${version ?? "0"}${build ? `(${build})` : ""}`;
  return (updateId ? `${v}@${updateId.replace(/-/g, "").slice(0, 8)}` : v).slice(0, 60);
}

const NOOP: Day2Native = {
  track() {},
  check() {},
  route() {},
  trackNavigation: () => () => {},
  action: (_n, h) => (...a) => h?.(...a),
  identify() {},
  treatment: () => "on",
  cameFrom: () => null,
  allowAdTracking() {},
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
  flush() {},
  stop() {},
};

const FREEZE_BEAT = 500;

// ---------------------------------------------------------------------------
// Marks: what's on screen (React Native has no DOM to ask)
// ---------------------------------------------------------------------------

type Mark = { id: string; route: string; w: number; h: number };
const marks = new Map<number, Mark>();
let nextMark = 1;
let currentRoute = "";

/** The mark ids a contract target stands for. */
function idsFor(target: string): string[] {
  if (target === LOADING_TARGET) return ["loading"];
  if (target === ERROR_SHOWN) return ["error"];
  const attr = target.match(/^\[data-(?:day2-require|testid)="([^"]+)"\]$/);
  if (attr) return [attr[1]!];
  if (target.startsWith("#")) return [target.slice(1)];
  return [target];
}

export function markVisible(target: string): boolean {
  const ids = idsFor(target);
  for (const m of marks.values()) if (ids.includes(m.id) && m.route === currentRoute && m.w > 0 && m.h > 0) return true;
  return false;
}

/**
 * Marks an element a screen contract may require (also "loading" for
 * spinners and "error" for input error messages). Spread the result on the
 * component: `<Text {...useDay2Mark("total")}>`.
 */
export function useDay2Mark(id: string): { onLayout: (e: { nativeEvent: { layout: { width: number; height: number } } }) => void } {
  const token = useRef<number>(0);
  if (!token.current) token.current = nextMark++;
  useEffect(() => {
    const t = token.current;
    return () => {
      marks.delete(t);
    };
  }, []);
  return {
    onLayout: (e) => {
      const { width, height } = e.nativeEvent.layout;
      marks.set(token.current, { id, route: currentRoute, w: width, h: height });
    },
  };
}

// ---------------------------------------------------------------------------
// Live values in components
// ---------------------------------------------------------------------------

let live: Live = NOOP_LIVE;

/**
 * A Live setting in a component. Values never change during a session; on
 * the very first launch the component re-renders once when the first config
 * arrives (at most 1.5 s after start).
 */
export function useDay2Value<T>(key: string, fallback: T): T {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (live.ready()) return undefined;
    return live.onReady(() => setTick((n) => n + 1));
  }, []);
  return live.value(key, fallback);
}

// ---------------------------------------------------------------------------

const randomId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
};

function deviceInfo(id: string, model: string | undefined): DeviceInfo {
  const win = Dimensions.get("window");
  let locale: string | undefined;
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    locale = undefined;
  }
  const scheme = Appearance.getColorScheme();
  return {
    id,
    platform: Platform.OS === "ios" ? "ios" : "android",
    os: `${Platform.OS === "ios" ? "iOS" : "Android"} ${String(Platform.Version)}`,
    ...(model ? { model } : {}),
    viewport: { w: Math.round(win.width), h: Math.round(win.height) },
    ...(locale ? { locale } : {}),
    ...(scheme === "dark" || scheme === "light" ? { theme: scheme } : {}),
    textScale: Math.round(PixelRatio.getFontScale() * 100) / 100,
  };
}

let active: Day2Native | null = null;

export function startDay2(opts: NativeOptions): Day2Native {
  if (opts.enabled === false || (Platform.OS !== "ios" && Platform.OS !== "android")) return NOOP;
  if (active) return active;
  const endpoint = opts.endpoint.replace(/\/+$/, "");
  const ingest = `${endpoint}/api/ingest/${encodeURIComponent(opts.key)}`;
  const isOwn = (url: string) => url.startsWith(endpoint);
  let deviceId = randomId();
  if (opts.identity === "device" && opts.storage) {
    const s = opts.storage;
    void s
      .getItem("day2.id")
      .then(async (have) => {
        if (have) deviceId = have;
        else await s.setItem("day2.id", deviceId);
      })
      .catch(() => {});
  }

  const env: Env = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    route: () => currentRoute,
    isVisible: markVisible,
    device: () => deviceInfo(deviceId, opts.model),
    send(batch: Batch) {
      void fetch(ingest, { method: "POST", body: JSON.stringify(batch), headers: { "content-type": "text/plain" } }).catch(() => {});
    },
  };

  let locale: string | null = null;
  let timeZone: string | null = null;
  try {
    const o = Intl.DateTimeFormat().resolvedOptions();
    locale = o.locale ?? null;
    timeZone = o.timeZone ?? null;
  } catch {
    /* no Intl */
  }

  const bundled = Array.isArray(opts.contracts) ? opts.contracts : (opts.contracts?.contracts ?? []);
  const engine = new Engine(env, { contracts: bundled, ...(opts.release ? { release: opts.release } : {}) });
  const undo: Array<() => void> = [];
  let from: string | null = null;
  live = startLive({
    key: opts.key,
    ingest,
    platform: Platform.OS === "ios" ? "ios" : "android",
    release: opts.release ?? null,
    locale,
    timeZone,
    storage: opts.storage ?? null,
    fetch: (u, init) => fetch(u, init),
    now: () => Date.now(),
    user: () => engine.userId,
    device: () => (opts.identity === "device" && opts.storage ? deviceId : null),
    pushDevice: () => deviceId,
    track: (type, extra) => engine.track(type, extra),
    setVariant: (exp, v) => engine.setVariant(exp, v),
    problems: () => engine.problemCount,
    fromAds: () => Boolean(from),
  });

  // Network: XMLHttpRequest sees every call, fetch included.
  const XHR = (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (this: XMLHttpRequest & { __d2?: { method: string; url: string } }, method: string, url: string | URL, ...rest: unknown[]) {
      this.__d2 = { method, url: String(url) };
      return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (this: XMLHttpRequest & { __d2?: { method: string; url: string } }, body?: Document | XMLHttpRequestBodyInit | null) {
      const meta = this.__d2;
      if (meta && !isOwn(meta.url)) {
        const started = Date.now();
        this.addEventListener("loadend", () => engine.onRequest({ method: meta.method, url: meta.url, status: this.status, ms: Date.now() - started }));
      }
      return send.call(this, body);
    };
    undo.push(() => {
      XHR.prototype.open = open;
      XHR.prototype.send = send;
    });
  }

  // Errors: React Native's global handler (kept chained).
  type Handler = (e: unknown, fatal?: boolean) => void;
  const EU = (globalThis as { ErrorUtils?: { getGlobalHandler(): Handler; setGlobalHandler(h: Handler): void } }).ErrorUtils;
  if (EU) {
    const prev = EU.getGlobalHandler();
    EU.setGlobalHandler((e, fatal) => {
      const msg = e instanceof Error ? e.message : String(e);
      engine.onError(msg, Boolean(fatal));
      prev?.(e, fatal);
    });
    undo.push(() => EU.setGlobalHandler(prev));
  }

  // Freezes: a heartbeat on the JS thread that arrives late means it was blocked.
  let last = Date.now();
  const beat = setInterval(() => {
    const now = Date.now();
    const late = now - last - FREEZE_BEAT;
    last = now;
    if (late > 0) engine.onFreeze(late);
  }, FREEZE_BEAT);
  undo.push(() => clearInterval(beat));

  // Send when the app goes to the background.
  const sub = AppState.addEventListener("change", (state) => {
    if (state === "background" || state === "inactive") engine.flush(true);
    if (state === "active") {
      last = Date.now();
      engine.touch();
      live.foreground();
    }
  });
  undo.push(() => sub.remove());

  // The visit, with where it came from (the link that opened the app).
  let pendingClick: { campaignId: string; click: { param: string; value: string } } | null = null;
  let clickSent = false;
  if (opts.identity === "device" && opts.storage) void opts.storage.getItem("day2.from").then((v) => (from = from ?? v)).catch(() => {});
  void Linking.getInitialURL()
    .then((url) => {
      const full = url ? acquisitionFrom(url, "", "") : { channel: "direct" as const };
      // The click id never leaves the device unless the user agrees (allowAdTracking).
      const { click, ...acq } = (full ?? {}) as NonNullable<typeof full> & { click?: { param: string; value: string } };
      if (click && opts.adClickIds === "after_consent" && acq.campaignId) pendingClick = { campaignId: acq.campaignId, click };
      engine.track("visit", full ? { acquisition: acq } : undefined);
      if (acq?.campaignId && !from) {
        from = acq.campaignId;
        if (opts.identity === "device") void opts.storage?.setItem("day2.from", from).catch(() => {});
      }
    })
    .catch(() => engine.track("visit"));

  if (opts.fetchContracts !== false) {
    void fetch(`${ingest}/contracts`)
      .then((r) => (r.ok ? (r.json() as Promise<ContractFile>) : null))
      .then((file) => {
        if (!file?.contracts) return;
        const ids = new Set(bundled.map((c) => c.id));
        engine.setContracts([...bundled, ...file.contracts.filter((c) => !ids.has(c.id))]);
      })
      .catch(() => {});
  }

  const setRoute = (name: string | undefined) => {
    if (!name) return;
    currentRoute = normalizePath(name);
    engine.onRoute(name);
  };

  engine.start();

  active = {
    track: (type) => {
      engine.track(type);
      live.counted(type);
    },
    check: (id, ok, detail) => engine.check(id, ok, detail),
    route: setRoute,
    trackNavigation(ref) {
      setRoute(ref.getCurrentRoute()?.name);
      const off = ref.addListener("state", () => setRoute(ref.getCurrentRoute()?.name));
      undo.push(off);
      return off;
    },
    action(name, handler, o) {
      return (...args) => {
        engine.onTap({
          action: name,
          label: o?.label ?? name,
          matches: (t) => Boolean(o?.testID) && (t === `[data-testid="${o!.testID}"]` || t === `#${o!.testID}`),
        });
        return handler?.(...args);
      };
    },
    identify: (userId) => {
      engine.identify(userId ? hashUser(opts.key, userId) : null);
      live.identified();
    },
    treatment: (id, holdout) => arm(engine.userId, id, holdout),
    cameFrom: () => cameFromTag(from),
    allowAdTracking() {
      if (opts.adClickIds !== "after_consent" || clickSent || !pendingClick) return;
      clickSent = true;
      engine.track("ad_click", { acquisition: { campaignId: pendingClick.campaignId, channel: "paid", click: pendingClick.click } });
    },
    value: (key, fallback) => live.value(key, fallback),
    variant: (id) => live.variant(id),
    revenue: (r) => live.revenue(r),
    purchaseToken: () => live.purchaseToken(),
    adPlacement: (id) => live.adPlacement(id),
    adShown: (id) => live.adShown(id),
    setPushToken: (token) => live.setPushToken(token),
    message: (trigger) => live.message(trigger),
    messageEvent: (id, what) => live.messageEvent(id, what),
    shouldAskForReview: () => live.shouldAskForReview(),
    flush: () => engine.flush(false),
    stop() {
      engine.flush(true);
      engine.stop();
      for (const u of undo.reverse()) u();
      active = null;
      live = NOOP_LIVE;
    },
  };
  return active;
}
