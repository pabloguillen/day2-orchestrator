import {
  BUILTIN,
  MAX_BATCH_BYTES,
  type ActionContract,
  type Batch,
  type Breadcrumb,
  type Contract,
  type DeviceInfo,
  type Expectation,
  type Failure,
  type FlowContract,
  type GrowthEvent,
  type ScreenContract,
  type SpeedContract,
} from "./types";

/**
 * The platform-neutral engine. A platform adapter (web.ts; React Native
 * next) feeds it what happened — a route change, a tap, a finished request,
 * an error, a timing — and gives it a few read-only lookups. The engine
 * decides, per contract, whether it held, and keeps the counts, failures
 * and growth events until the adapter sends them.
 *
 * Deliberately small: no AI, no DOM recording, no pixels. Each check is one
 * look at state the platform already has.
 */

export type Timer = unknown;

export interface Env {
  now(): number;
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(t: Timer): void;
  /** Current route, already normalised (normalizePath). */
  route(): string;
  /** Is an element (CSS selector on web, testID on mobile) visible on screen now? */
  isVisible(target: string): boolean;
  device(): DeviceInfo;
  /** Hands a batch to the transport. `urgent`: the page is going away. */
  send(batch: Batch, urgent: boolean): void;
  /** Sampled layout look: what doesn't fit the screen. Null when not supported. */
  layout?(): { overflowX: number; wide: string[]; clipped: string[] } | null;
  /** Placeholder text visible on screen ("undefined", "NaN", "[object Object]"…). */
  placeholders?(): string[];
  /** Images on screen that failed to load. */
  brokenImages?(): string[];
}

export type Tap = {
  /** `data-day2-action` value (web) / action name (mobile), when tagged. */
  action?: string;
  /** Internal link target, normalised, when the tap is on a same-site link. */
  linkTo?: string;
  /** Short readable label for breadcrumbs (never typed input). */
  label: string;
  /** Does the tapped element match this CSS selector / testID? */
  matches(target: string): boolean;
};

export type EngineOptions = {
  contracts?: Contract[];
  /** Share of screens that get the heavier layout checks. Default 0.1. */
  layoutSampleRate?: number;
  release?: string;
  random?: () => number;
  /** Ms between sends. Default 10 000. */
  flushEvery?: number;
};

const DEFAULT_WITHIN = 3000;
const DEFAULT_READY = 3000;
const FLOW_WITHIN = 15 * 60_000;
const LOADING_LIMIT = 10_000;
const FREEZE_MS = 2000;
const POLL = 100;
const MAX_FAILURES_PER_CONTRACT = 3;
const MAX_FAILURES_PER_BATCH = 50;
const MAX_CRUMBS = 20;
const LOADING_TARGET = '[aria-busy="true"], [data-day2-loading]';
/** A message telling the user their input was not accepted. */
export const ERROR_SHOWN = '[role="alert"], [aria-invalid="true"], [data-day2-error]';

// ---------------------------------------------------------------------------
// Pure helpers (exported for adapters and tests)
// ---------------------------------------------------------------------------

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,})$/i;

/** Path without origin, query or hash; ids, uuids and tokens become ":id" — so
 * nothing personal leaves the device and routes group together. */
export function normalizePath(input: string): string {
  let p = input;
  const scheme = p.indexOf("://");
  if (scheme !== -1) {
    const slash = p.indexOf("/", scheme + 3);
    p = slash === -1 ? "/" : p.slice(slash);
  }
  p = p.split(/[?#]/)[0] || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  const parts = p.split("/").map((s) => (s && ID_SEGMENT.test(s) ? ":id" : s));
  const out = parts.join("/");
  return out.length > 1 && out.endsWith("/") ? out.slice(0, -1) : out;
}

/** "/orders/:id" matches "/orders/:id" and "/orders/42"; a trailing "*" matches the rest. */
export function matchRoute(pattern: string, path: string): boolean {
  const a = normalizePath(pattern).split("/");
  const b = normalizePath(path).split("/");
  for (let i = 0; i < a.length; i++) {
    const seg = a[i]!;
    if (seg === "*") return true;
    if (i >= b.length) return false;
    if (seg.startsWith(":")) {
      if (!b[i]) return false;
      continue;
    }
    if (seg !== b[i]) return false;
  }
  return a.length === b.length;
}

/** "POST /api/orders" against a finished call. */
export function matchRequest(spec: string, call: { method: string; path: string }): boolean {
  const [method, ...rest] = spec.trim().split(/\s+/);
  const path = rest.join(" ");
  if (!method || !path) return false;
  return method.toUpperCase() === call.method.toUpperCase() && matchRoute(path, call.path);
}

const statusOk = (want: "2xx" | number | undefined, got: number) => (want === undefined || want === "2xx" ? got >= 200 && got < 300 : got === want);

export function describeExpectation(e: Expectation): string {
  if ("screen" in e) return `screen ${e.screen}`;
  if ("request" in e) return `${e.request} → ${e.status ?? "2xx"}`;
  return `visible ${e.visible}`;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

type Call = { method: string; path: string; status: number; ms: number; at: number };

type Pending = {
  contract: ActionContract | { id: string; kind: "action"; target: string; expect: Expectation[]; within?: number; source: "code" };
  startedAt: number;
  startRoute: string;
  calls: Call[];
  errors: string[];
  poll: Timer | null;
  deadline: Timer | null;
};

export class Engine {
  private readonly env: Env;
  private contracts: Contract[];
  private readonly opts: Required<Pick<EngineOptions, "layoutSampleRate" | "flushEvery">> & EngineOptions;
  private readonly random: () => number;

  private passes: Record<string, number> = {};
  private failures: Failure[] = [];
  private failuresBy: Record<string, number> = {};
  private events: GrowthEvent[] = [];
  private crumbs: Breadcrumb[] = [];
  private pending: Pending[] = [];

  private currentRoute = "";
  private routeSince = 0;
  private screenTimers: Timer[] = [];
  private loadingSince: number | null = null;
  private loadingReported = false;
  private flowState = new Map<string, { step: number; startedAt: number; timer: Timer }>();
  private flushTimer: Timer | null = null;
  private tickTimer: Timer | null = null;
  private stopped = false;

  constructor(env: Env, opts: EngineOptions = {}) {
    this.env = env;
    this.contracts = opts.contracts ?? [];
    this.opts = { layoutSampleRate: 0.1, flushEvery: 10_000, ...opts };
    this.random = opts.random ?? Math.random;
  }

  start(): void {
    this.onRoute(this.env.route());
    this.scheduleFlush();
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    for (const t of [this.flushTimer, this.tickTimer, ...this.screenTimers]) if (t) this.env.clearTimeout(t);
    for (const p of this.pending) this.clearPending(p);
    for (const f of this.flowState.values()) this.env.clearTimeout(f.timer);
  }

  setContracts(contracts: Contract[]): void {
    this.contracts = contracts;
  }

  // ---- What adapters report -------------------------------------------------

  onRoute(raw: string): void {
    const route = normalizePath(raw);
    if (route === this.currentRoute) return;
    this.currentRoute = route;
    this.routeSince = this.env.now();
    this.loadingSince = null;
    this.loadingReported = false;
    this.crumb("screen", route);
    for (const t of this.screenTimers) this.env.clearTimeout(t);
    this.screenTimers = [];
    this.checkScreen(route);
    this.advanceFlows(route);
    // A pending action waiting for a screen may be satisfied now.
    for (const p of [...this.pending]) this.evaluate(p, false);
  }

  onTap(tap: Tap): void {
    this.crumb("tap", tap.label);
    const now = this.env.now();
    for (const c of this.contracts) {
      if (c.kind !== "action") continue;
      const hit = c.target.startsWith("action:") ? tap.action === c.target.slice(7) : tap.matches(c.target);
      if (hit) this.begin(c, now);
    }
    if (tap.linkTo && !this.contracts.some((c) => c.kind === "action" && (c.target.startsWith("action:") ? tap.action === c.target.slice(7) : tap.matches(c.target)))) {
      this.begin({ id: `${BUILTIN.link} ${tap.linkTo}`, kind: "action", target: "link", expect: [{ screen: tap.linkTo }], source: "code" }, now);
    }
  }

  onRequest(call: { method: string; url: string; status: number; ms: number }): void {
    const c: Call = { method: call.method.toUpperCase(), path: normalizePath(call.url), status: call.status, ms: Math.round(call.ms), at: this.env.now() };
    this.crumb("request", `${c.method} ${c.path} → ${c.status || "failed"}`);
    for (const p of this.pending) p.calls.push(c);
    if (c.status >= 500 || c.status === 0) {
      this.fail(`${BUILTIN.serverError} ${c.method} ${c.path}`, { status: "2xx" }, { status: c.status || "no response" }, { requests: [{ call: `${c.method} ${c.path}`, status: c.status, ms: c.ms }] });
    }
    for (const p of [...this.pending]) this.evaluate(p, false);
  }

  onError(message: string, fatal = false): void {
    const msg = message.slice(0, 300);
    this.crumb("error", msg);
    for (const p of this.pending) p.errors.push(msg);
    this.fail(fatal ? BUILTIN.crash : BUILTIN.error, "no error", msg, { errors: [msg] });
    if (fatal) this.flush(true);
  }

  /** Main thread blocked for `ms` (long task / hang). */
  onFreeze(ms: number): void {
    if (ms < FREEZE_MS) return;
    this.fail(BUILTIN.freeze, { maxMs: FREEZE_MS }, { ms: Math.round(ms) });
  }

  onLcp(ms: number): void {
    this.checkSpeed("lcp", ms, BUILTIN.lcp, 2500);
  }

  onInteraction(ms: number, label: string): void {
    this.checkSpeed("inp", ms, BUILTIN.inp, 200, { label });
  }

  /** `day2.check(id, ok)` from the app's own code: invariants. */
  check(id: string, ok: boolean, detail?: Record<string, number | boolean>): void {
    if (ok) this.pass(id);
    else this.fail(id, "holds", "broken", detail ? { detail } : undefined);
  }

  /** Growth events: visit, signup, activated, shared, invite_sent… */
  track(type: string, acquisition?: GrowthEvent["acquisition"]): void {
    this.events.push({ type: type.slice(0, 40), at: new Date(this.env.now()).toISOString(), ...(acquisition ? { acquisition } : {}) });
  }

  // ---- Actions ----------------------------------------------------------------

  private begin(contract: Pending["contract"], now: number): void {
    // A repeated tap restarts the same check rather than stacking.
    for (const p of this.pending.filter((x) => x.contract.id === contract.id)) this.clearPending(p);
    this.pending = this.pending.filter((x) => x.contract.id !== contract.id);
    const p: Pending = { contract, startedAt: now, startRoute: this.currentRoute, calls: [], errors: [], poll: null, deadline: null };
    this.pending.push(p);
    p.deadline = this.env.setTimeout(() => this.evaluate(p, true), contract.within ?? DEFAULT_WITHIN);
    if (contract.expect.some((e) => "visible" in e)) {
      const poll = () => {
        if (!this.pending.includes(p)) return;
        this.evaluate(p, false);
        if (this.pending.includes(p)) p.poll = this.env.setTimeout(poll, POLL);
      };
      p.poll = this.env.setTimeout(poll, POLL);
    }
    this.evaluate(p, false);
  }

  private holds(e: Expectation, p: Pending): boolean {
    if ("screen" in e) return matchRoute(e.screen, this.currentRoute);
    if ("request" in e) return p.calls.some((c) => matchRequest(e.request, c) && statusOk(e.status, c.status));
    return this.env.isVisible(e.visible);
  }

  private evaluate(p: Pending, final: boolean): void {
    if (!this.pending.includes(p)) return;
    const met = p.contract.expect.map((e) => this.holds(e, p));
    if (met.every(Boolean)) {
      this.clearPending(p);
      this.pass(p.contract.id);
      return;
    }
    if (!final) return;
    this.clearPending(p);
    // The app rejected the user's input and said so (a 4xx and a visible
    // message): working as designed, counted apart. Rejected without a
    // word, or a 5xx/timeout, is a failure.
    if (p.calls.some((c) => c.status >= 400 && c.status < 500) && !p.calls.some((c) => c.status >= 500 || c.status === 0) && this.env.isVisible(ERROR_SHOWN)) {
      this.passes[`${p.contract.id}#rejected`] = (this.passes[`${p.contract.id}#rejected`] ?? 0) + 1;
      return;
    }
    const missing = p.contract.expect.filter((_, i) => !met[i]);
    const actual: Record<string, unknown> = { screen: this.currentRoute, afterMs: this.env.now() - p.startedAt };
    for (const e of missing) {
      if ("request" in e) {
        const same = p.calls.filter((c) => matchRequest(e.request, c));
        actual[e.request] = same.length ? same.map((c) => c.status) : "not sent";
      }
      if ("visible" in e) actual[e.visible] = "not visible";
    }
    const expected: Record<string, unknown> = {};
    for (const e of p.contract.expect) {
      if ("screen" in e) expected.screen = e.screen;
      else if ("request" in e) expected[e.request] = e.status ?? "2xx";
      else expected[e.visible] = "visible";
    }
    this.fail(
      p.contract.id,
      expected,
      actual,
      { requests: p.calls.slice(0, 8).map((c) => ({ call: `${c.method} ${c.path}`, status: c.status, ms: c.ms })), errors: p.errors.slice(0, 3) },
    );
  }

  private clearPending(p: Pending): void {
    if (p.poll) this.env.clearTimeout(p.poll);
    if (p.deadline) this.env.clearTimeout(p.deadline);
    this.pending = this.pending.filter((x) => x !== p);
  }

  // ---- Screens ------------------------------------------------------------------

  private checkScreen(route: string): void {
    const screens = this.contracts.filter((c): c is ScreenContract => c.kind === "screen" && matchRoute(c.route, route));
    const startedAt = this.routeSince;
    for (const s of screens) {
      const required = s.require ?? [];
      const limit = s.readyWithin ?? DEFAULT_READY;
      const look = () => {
        if (this.currentRoute !== route) return;
        const missing = required.filter((r) => !this.env.isVisible(r));
        const elapsed = this.env.now() - startedAt;
        if (missing.length === 0) {
          this.pass(s.id);
          this.speedOfScreen(route, elapsed);
          return;
        }
        if (elapsed >= limit) {
          this.fail(s.id, { visible: required, withinMs: limit }, { missing, afterMs: elapsed });
          return;
        }
        this.screenTimers.push(this.env.setTimeout(look, POLL));
      };
      look();
    }
    // Built-in looks once the screen has settled.
    this.screenTimers.push(
      this.env.setTimeout(() => {
        if (this.currentRoute !== route) return;
        const holes = this.env.placeholders?.() ?? [];
        if (holes.length) this.fail(`${BUILTIN.placeholder} ${route}`, "no placeholder text", holes.slice(0, 5));
        else this.pass(`${BUILTIN.placeholder} ${route}`);
        const broken = this.env.brokenImages?.() ?? [];
        if (broken.length) this.fail(`${BUILTIN.images} ${route}`, "all images loaded", { failed: broken.slice(0, 5) });
        else this.pass(`${BUILTIN.images} ${route}`);
        if (this.random() < this.opts.layoutSampleRate) {
          const l = this.env.layout?.();
          if (l) {
            if (l.overflowX > 1 || l.wide.length || l.clipped.length) {
              const d = this.env.device();
              this.fail(`${BUILTIN.fits} ${route}`, "fits the screen", { overflowPx: l.overflowX, wider: l.wide.slice(0, 5), clipped: l.clipped.slice(0, 5), viewport: d.viewport });
            } else this.pass(`${BUILTIN.fits} ${route}`);
          }
        }
      }, 1500),
    );
  }

  private speedOfScreen(route: string, ms: number): void {
    for (const c of this.contracts) {
      if (c.kind !== "speed" || c.metric !== "screen_ready" || (c.route && !matchRoute(c.route, route))) continue;
      if (ms <= c.maxMs) this.pass(c.id);
      else this.fail(c.id, { maxMs: c.maxMs }, { ms: Math.round(ms) });
    }
  }

  private checkSpeed(metric: SpeedContract["metric"], ms: number, builtinId: string, builtinMax: number, detail?: Record<string, unknown>): void {
    const route = this.currentRoute;
    const own = this.contracts.filter((c): c is SpeedContract => c.kind === "speed" && c.metric === metric && (!c.route || matchRoute(c.route, route)));
    const rules = own.length ? own.map((c) => ({ id: c.id, max: c.maxMs })) : [{ id: `${builtinId} ${route}`, max: builtinMax }];
    for (const r of rules) {
      if (ms <= r.max) this.pass(r.id);
      else this.fail(r.id, { maxMs: r.max }, { ms: Math.round(ms) }, detail ? { detail } : undefined);
    }
  }

  // ---- Flows ----------------------------------------------------------------------

  private advanceFlows(route: string): void {
    const now = this.env.now();
    for (const f of this.contracts) {
      if (f.kind !== "flow" || f.steps.length < 2) continue;
      const st = this.flowState.get(f.id);
      if (!st) {
        if (matchRoute(f.steps[0]!, route)) {
          const timer = this.env.setTimeout(() => this.flowTimeout(f), f.within ?? FLOW_WITHIN);
          this.flowState.set(f.id, { step: 0, startedAt: now, timer });
        }
        continue;
      }
      const next = f.steps[st.step + 1];
      if (next && matchRoute(next, route)) {
        st.step += 1;
        if (st.step === f.steps.length - 1) {
          this.env.clearTimeout(st.timer);
          this.flowState.delete(f.id);
          this.pass(f.id);
        }
      }
    }
  }

  private flowTimeout(f: FlowContract): void {
    const st = this.flowState.get(f.id);
    if (!st) return;
    this.flowState.delete(f.id);
    this.fail(f.id, { steps: f.steps }, { stoppedAt: f.steps[st.step], completed: st.step + 1, of: f.steps.length });
  }

  // ---- Periodic look: loading that never ends ---------------------------------------

  private tick(): void {
    if (this.stopped) return;
    const now = this.env.now();
    if (this.env.isVisible(LOADING_TARGET)) {
      if (this.loadingSince === null) this.loadingSince = now;
      else if (!this.loadingReported && now - this.loadingSince >= LOADING_LIMIT) {
        this.loadingReported = true;
        this.fail(`${BUILTIN.stuckLoading} ${this.currentRoute}`, { maxMs: LOADING_LIMIT }, { loadingForMs: now - this.loadingSince });
      }
    } else {
      if (this.loadingSince !== null && !this.loadingReported) this.pass(`${BUILTIN.stuckLoading} ${this.currentRoute}`);
      this.loadingSince = null;
    }
    this.tickTimer = this.env.setTimeout(() => this.tick(), 1000);
  }

  // ---- Bookkeeping and sending --------------------------------------------------------

  private crumb(kind: Breadcrumb["kind"], text: string): void {
    this.crumbs.push({ at: this.env.now(), kind, text: text.slice(0, 80) });
    if (this.crumbs.length > MAX_CRUMBS) this.crumbs.shift();
  }

  private pass(id: string): void {
    this.passes[id] = (this.passes[id] ?? 0) + 1;
  }

  private fail(contract: string, expected: unknown, actual: unknown, evidence?: Failure["evidence"]): void {
    const n = this.failuresBy[contract] ?? 0;
    this.failuresBy[contract] = n + 1;
    // Each broken contract is reported a few times per session, then only counted.
    if (n >= MAX_FAILURES_PER_CONTRACT || this.failures.length >= MAX_FAILURES_PER_BATCH) {
      this.passes[`${contract}#failed`] = (this.passes[`${contract}#failed`] ?? 0) + 1;
      return;
    }
    this.failures.push({
      contract,
      at: new Date(this.env.now()).toISOString(),
      route: this.currentRoute,
      expected,
      actual,
      ...(evidence ? { evidence } : {}),
      steps: this.crumbs.map((c) => `${c.kind === "screen" ? "screen" : c.kind} ${c.text}`),
    });
  }

  private scheduleFlush(): void {
    if (this.stopped) return;
    this.flushTimer = this.env.setTimeout(() => {
      this.flush(false);
      this.scheduleFlush();
    }, this.opts.flushEvery);
  }

  /** Sends what's collected. Called on a timer and when the app goes away. */
  flush(urgent: boolean): void {
    if (!this.failures.length && !this.events.length && !Object.keys(this.passes).length) return;
    let batch: Batch = { v: 1, ...(this.opts.release ? { release: this.opts.release } : {}), device: this.env.device(), passes: this.passes, failures: this.failures, events: this.events };
    // Stay under the size limit: drop the oldest failures' steps, then failures.
    while (JSON.stringify(batch).length > MAX_BATCH_BYTES && batch.failures.length) {
      const [, ...rest] = batch.failures;
      batch = { ...batch, failures: rest };
    }
    this.passes = {};
    this.failures = [];
    this.events = [];
    this.env.send(batch, urgent);
  }

  /** For tests and debugging. */
  peek(): { passes: Record<string, number>; failures: Failure[]; events: GrowthEvent[] } {
    return { passes: { ...this.passes }, failures: [...this.failures], events: [...this.events] };
  }
}
