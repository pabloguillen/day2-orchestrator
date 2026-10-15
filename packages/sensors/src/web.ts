import { Engine, normalizePath, type Env, type Tap } from "./core";
import type { Batch, Contract, ContractFile, DeviceInfo, GrowthEvent } from "./types";

/**
 * day2 field contracts for the web — one call at startup:
 *
 *   import { startDay2 } from "@day2/sensors";
 *   startDay2({ key: "d2k_…", endpoint: "https://day2.example" });
 *
 * Hooks only what the browser already exposes: the History API, fetch and
 * XHR, error events, performance entries, and — when a contract asks — one
 * lookup of an element. Sends small JSON batches to day2. Nothing typed by
 * the user, no URLs' query strings, no screen recording.
 */

export type StartOptions = {
  /** The app's send-only key from day2. */
  key: string;
  /** day2's address, e.g. "https://day2.example". */
  endpoint: string;
  /** The app's version or commit, so failures are tied to a release. */
  release?: string;
  /** Contracts shipped with the app (day2.contracts.json); day2 also serves the latest. */
  contracts?: Contract[] | ContractFile;
  /** Fetch the latest contracts from day2 at startup. Default true. */
  fetchContracts?: boolean;
  /**
   * "session" (default): a random id per browser session, nothing kept.
   * "device": kept across visits (localStorage) — only after the user's
   * consent where the law requires it (e.g. the EU).
   */
  identity?: "session" | "device";
  /** Share of screens that get layout checks. Default 0.1. */
  layoutSampleRate?: number;
  /** Turn everything off (e.g. until consent). Default true. */
  enabled?: boolean;
};

export type Day2 = {
  /** Growth events: "signup", "activated", "shared", "invite_sent"… */
  track(type: string): void;
  /** An invariant from the app's own code, e.g. check("receipt.total", total === sum). */
  check(id: string, ok: boolean, detail?: Record<string, number | boolean>): void;
  /** Switch identity after consent changes. */
  setIdentity(identity: "session" | "device"): void;
  /** Send what's collected now. */
  flush(): void;
  stop(): void;
};

const NOOP: Day2 = { track() {}, check() {}, setIdentity() {}, flush() {}, stop() {} };

const SEARCH = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|yahoo\.[a-z.]+|ecosia\.org|baidu\.com|yandex\.[a-z.]+|startpage\.com|qwant\.com)$/;
const AI = /(^|\.)(chatgpt\.com|chat\.openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|copilot\.microsoft\.com|you\.com)$/;

/** Where a visitor came from, from the URL and the referrer. */
export function acquisitionFrom(url: string, referrer: string, ownHost: string): GrowthEvent["acquisition"] {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    params = new URLSearchParams();
  }
  const d2 = params.get("d2");
  if (d2) return { campaignId: d2.slice(0, 40), channel: "paid" };
  if (params.get("ref") === "share") return { channel: "shared_link" };
  if (params.has("invite")) return { channel: "invite" };
  if (!referrer) return { channel: "direct" };
  let host = "";
  try {
    host = new URL(referrer).hostname;
  } catch {
    return { channel: "direct" };
  }
  if (host === ownHost) return undefined;
  if (AI.test(host)) return { channel: "ai_assistant" };
  if (SEARCH.test(host)) return { channel: "search" };
  return { channel: "referral" };
}

const store = (kind: "session" | "local") => {
  try {
    return kind === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
};

const randomId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
};

function idFor(identity: "session" | "device"): string {
  const s = store(identity === "device" ? "local" : "session");
  const key = "day2.id";
  try {
    const have = s?.getItem(key);
    if (have) return have;
    const id = randomId();
    s?.setItem(key, id);
    return id;
  } catch {
    return randomId();
  }
}

/** A short label for breadcrumbs: the tag name, an action name or an accessible name — digits masked. */
function labelOf(el: Element): string {
  const action = el.getAttribute("data-day2-action");
  if (action) return action;
  const name = el.getAttribute("aria-label") ?? (el.tagName === "INPUT" ? (el as HTMLInputElement).value : el.textContent) ?? "";
  const text = name.replace(/\s+/g, " ").trim().slice(0, 40).replace(/\d/g, "#");
  return text || el.tagName.toLowerCase();
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0;
}

const PLACEHOLDER = /\b(undefined|NaN)\b|\[object Object\]|lorem ipsum/i;
const SKIP_TEXT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEXTAREA", "TEMPLATE"]);

function deviceInfo(id: string): DeviceInfo {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : undefined;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : undefined;
  const conn = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection;
  return {
    id,
    platform: "web",
    ...(os ? { os } : {}),
    ...(browser ? { browser } : {}),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    locale: navigator.language,
    theme: window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    ...(conn?.effectiveType ? { network: conn.effectiveType } : {}),
  };
}

export function startDay2(opts: StartOptions): Day2 {
  if (typeof window === "undefined" || typeof document === "undefined" || opts.enabled === false) return NOOP;
  const endpoint = opts.endpoint.replace(/\/+$/, "");
  const ingest = `${endpoint}/api/ingest/${encodeURIComponent(opts.key)}`;
  let identity = opts.identity ?? "session";
  let deviceId = idFor(identity);
  const originalFetch = window.fetch.bind(window);
  const isOwn = (url: string) => url.startsWith(endpoint);

  const env: Env = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (t) => window.clearTimeout(t as number),
    route: () => normalizePath(location.pathname),
    isVisible(target) {
      try {
        for (const el of Array.from(document.querySelectorAll(target)).slice(0, 20)) if (visible(el)) return true;
      } catch {
        // An invalid selector in a contract never breaks the app.
      }
      return false;
    },
    device: () => deviceInfo(deviceId),
    send(batch: Batch, urgent: boolean) {
      const body = JSON.stringify(batch);
      if (urgent && navigator.sendBeacon?.(ingest, new Blob([body], { type: "text/plain" }))) return;
      void originalFetch(ingest, { method: "POST", body, keepalive: true, headers: { "content-type": "text/plain" } }).catch(() => {});
    },
    layout() {
      const vw = document.documentElement.clientWidth;
      const overflowX = Math.max(0, document.documentElement.scrollWidth - vw);
      const wide: string[] = [];
      const all = document.body ? document.body.getElementsByTagName("*") : [];
      for (let i = 0; i < Math.min(all.length, 1500) && wide.length < 5; i++) {
        const el = all[i]!;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || (r.right <= vw + 1 && r.left >= -1)) continue;
        // Content inside a scroll container (a carousel) is meant to extend.
        let scrolls = false;
        for (let p = el.parentElement, d = 0; p && d < 12; p = p.parentElement, d++) {
          const ox = getComputedStyle(p).overflowX;
          if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") {
            scrolls = true;
            break;
          }
        }
        if (!scrolls) wide.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}`);
      }
      const clipped = Array.from(document.querySelectorAll("[data-day2-label]"))
        .filter((el) => (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1 && visible(el))
        .slice(0, 5)
        .map((el) => el.getAttribute("data-day2-label") || el.tagName.toLowerCase());
      return { overflowX, wide, clipped };
    },
    placeholders() {
      const out: string[] = [];
      if (!document.body) return out;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n = 0;
      for (let node = walker.nextNode(); node && n < 3000 && out.length < 5; node = walker.nextNode(), n++) {
        const parent = node.parentElement;
        if (!parent || SKIP_TEXT.has(parent.tagName)) continue;
        const m = node.textContent?.match(PLACEHOLDER);
        if (m && visible(parent)) out.push(`${parent.tagName.toLowerCase()}: "${m[0]}"`);
      }
      return out;
    },
    brokenImages() {
      return Array.from(document.images)
        .filter((img) => img.complete && img.naturalWidth === 0 && img.currentSrc && visible(img))
        .slice(0, 5)
        .map((img) => normalizePath(img.currentSrc));
    },
  };

  const bundled = Array.isArray(opts.contracts) ? opts.contracts : (opts.contracts?.contracts ?? []);
  const engine = new Engine(env, { contracts: bundled, ...(opts.release ? { release: opts.release } : {}), ...(opts.layoutSampleRate !== undefined ? { layoutSampleRate: opts.layoutSampleRate } : {}) });
  const undo: Array<() => void> = [];

  // Routes: the History API covers every client-side router.
  const onRoute = () => engine.onRoute(location.pathname);
  const push = history.pushState;
  const replace = history.replaceState;
  history.pushState = function (...args: Parameters<History["pushState"]>) {
    const r = push.apply(this, args);
    onRoute();
    return r;
  };
  history.replaceState = function (...args: Parameters<History["replaceState"]>) {
    const r = replace.apply(this, args);
    onRoute();
    return r;
  };
  window.addEventListener("popstate", onRoute);
  undo.push(() => {
    history.pushState = push;
    history.replaceState = replace;
    window.removeEventListener("popstate", onRoute);
  });

  // Taps.
  const onClick = (ev: MouseEvent) => {
    const el = (ev.target as Element | null)?.closest?.("[data-day2-action], a[href], button, [role='button'], input[type='submit']");
    if (!el) return;
    let linkTo: string | undefined;
    if (el.tagName === "A" && !el.hasAttribute("data-day2-action")) {
      const a = el as HTMLAnchorElement;
      const same = a.origin === location.origin && !a.target && !a.hasAttribute("download") && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.button === 0;
      if (same && a.pathname !== location.pathname) linkTo = normalizePath(a.pathname);
    }
    const tap: Tap = {
      label: labelOf(el),
      ...(el.getAttribute("data-day2-action") ? { action: el.getAttribute("data-day2-action")! } : {}),
      ...(linkTo ? { linkTo } : {}),
      matches(target) {
        try {
          return Boolean(el.closest(target));
        } catch {
          return false;
        }
      },
    };
    engine.onTap(tap);
  };
  document.addEventListener("click", onClick, true);
  undo.push(() => document.removeEventListener("click", onClick, true));

  // Network: fetch and XHR, method + path + status + time only.
  const wrapped = async function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const started = performance.now();
    if (isOwn(url)) return originalFetch(input, init);
    try {
      const res = await originalFetch(input, init);
      engine.onRequest({ method, url, status: res.status, ms: performance.now() - started });
      return res;
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) engine.onRequest({ method, url, status: 0, ms: performance.now() - started });
      throw err;
    }
  };
  window.fetch = Object.assign(wrapped, { preconnect: (window.fetch as typeof fetch & { preconnect?: unknown }).preconnect }) as typeof fetch;
  undo.push(() => {
    window.fetch = originalFetch;
  });
  const xopen = XMLHttpRequest.prototype.open;
  const xsend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { __d2?: { method: string; url: string } }, method: string, url: string | URL, ...rest: unknown[]) {
    this.__d2 = { method, url: String(url) };
    return (xopen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { __d2?: { method: string; url: string } }, body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = this.__d2;
    if (meta && !isOwn(meta.url)) {
      const started = performance.now();
      this.addEventListener("loadend", () => engine.onRequest({ method: meta.method, url: meta.url, status: this.status, ms: performance.now() - started }));
    }
    return xsend.call(this, body);
  };
  undo.push(() => {
    XMLHttpRequest.prototype.open = xopen;
    XMLHttpRequest.prototype.send = xsend;
  });

  // Errors (resource load errors are covered by the image check).
  const onError = (ev: ErrorEvent) => {
    if (ev.target && ev.target !== window) return;
    engine.onError(ev.message || String(ev.error ?? "Error"));
  };
  const onRejection = (ev: PromiseRejectionEvent) => {
    const r = ev.reason as { message?: string } | undefined;
    engine.onError(`Unhandled rejection: ${r?.message ?? String(ev.reason)}`);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  undo.push(() => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  });

  // Speed and freezes, where the browser supports it.
  const types = (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes) || [];
  const observe = (type: string, cb: (entries: PerformanceEntry[]) => void, extra: Record<string, unknown> = {}) => {
    if (!types.includes(type)) return;
    try {
      const o = new PerformanceObserver((list) => cb(list.getEntries()));
      o.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      undo.push(() => o.disconnect());
    } catch {
      // Not supported here.
    }
  };
  observe("longtask", (es) => es.forEach((e) => engine.onFreeze(e.duration)));
  let lcp = 0;
  let lcpSent = false;
  observe("largest-contentful-paint", (es) => {
    const last = es.at(-1);
    if (last) lcp = last.startTime;
  });
  const sendLcp = () => {
    if (lcpSent || !lcp) return;
    lcpSent = true;
    engine.onLcp(lcp);
  };
  observe(
    "event",
    (es) => {
      for (const e of es as Array<PerformanceEntry & { interactionId?: number; target?: Element | null }>) {
        if (!e.interactionId) continue;
        sendLcp();
        if (e.duration > 200) engine.onInteraction(e.duration, e.target ? labelOf(e.target) : e.name);
      }
    },
    { durationThreshold: 104 },
  );

  // Send when the page goes away.
  const onHide = () => {
    if (document.visibilityState === "hidden") {
      sendLcp();
      engine.flush(true);
    }
  };
  const onPageHide = () => {
    sendLcp();
    engine.flush(true);
  };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onPageHide);
  undo.push(() => {
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onPageHide);
  });

  // The visit, with where it came from — once per session.
  try {
    const ss = store("session");
    if (!ss?.getItem("day2.visit")) {
      ss?.setItem("day2.visit", "1");
      engine.track("visit", acquisitionFrom(location.href, document.referrer, location.hostname));
    }
  } catch {
    engine.track("visit");
  }

  // The latest contracts from day2 (cached for the session).
  if (opts.fetchContracts !== false) {
    const cacheKey = "day2.contracts";
    const apply = (list: Contract[]) => {
      const ids = new Set(bundled.map((c) => c.id));
      engine.setContracts([...bundled, ...list.filter((c) => !ids.has(c.id))]);
    };
    try {
      const cached = store("session")?.getItem(cacheKey);
      if (cached) apply((JSON.parse(cached) as ContractFile).contracts ?? []);
    } catch {
      // Ignore a broken cache.
    }
    void originalFetch(`${ingest}/contracts`)
      .then((r) => (r.ok ? (r.json() as Promise<ContractFile>) : null))
      .then((file) => {
        if (!file?.contracts) return;
        apply(file.contracts);
        try {
          store("session")?.setItem(cacheKey, JSON.stringify(file));
        } catch {
          // Storage full or blocked: fine.
        }
      })
      .catch(() => {});
  }

  engine.start();

  return {
    track: (type) => engine.track(type),
    check: (id, ok, detail) => engine.check(id, ok, detail),
    setIdentity(next) {
      identity = next;
      deviceId = idFor(identity);
    },
    flush: () => engine.flush(false),
    stop() {
      engine.flush(true);
      engine.stop();
      for (const u of undo.reverse()) u();
    },
  };
}
