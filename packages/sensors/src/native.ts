import { useEffect, useRef } from "react";
import { AppState, Appearance, Dimensions, Linking, PixelRatio, Platform } from "react-native";
import { acquisitionFrom } from "./acquisition";
import { arm, hashUser } from "./lifecycle";
import { Engine, ERROR_SHOWN, LOADING_TARGET, normalizePath, type Env } from "./core";
import type { Batch, Contract, ContractFile, DeviceInfo } from "./types";

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
  flush(): void;
  stop(): void;
};

export { arm, hashUser, mayNudge, stateOf } from "./lifecycle";

const NOOP: Day2Native = {
  track() {},
  check() {},
  route() {},
  trackNavigation: () => () => {},
  action: (_n, h) => (...a) => h?.(...a),
  identify() {},
  treatment: () => "on",
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

  const bundled = Array.isArray(opts.contracts) ? opts.contracts : (opts.contracts?.contracts ?? []);
  const engine = new Engine(env, { contracts: bundled, ...(opts.release ? { release: opts.release } : {}) });
  const undo: Array<() => void> = [];

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
    }
  });
  undo.push(() => sub.remove());

  // The visit, with where it came from (the link that opened the app).
  void Linking.getInitialURL()
    .then((url) => engine.track("visit", url ? acquisitionFrom(url, "", "") : { channel: "direct" }))
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
    track: (type) => engine.track(type),
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
    identify: (userId) => engine.identify(userId ? hashUser(opts.key, userId) : null),
    treatment: (id, holdout) => arm(engine.userId, id, holdout),
    flush: () => engine.flush(false),
    stop() {
      engine.flush(true);
      engine.stop();
      for (const u of undo.reverse()) u();
      active = null;
    },
  };
  return active;
}
