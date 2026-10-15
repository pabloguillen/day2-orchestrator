import { beforeEach, describe, expect, test } from "bun:test";
import { Engine, matchRequest, matchRoute, normalizePath, type Env, type Tap } from "../src/core";
import type { Batch, Contract } from "../src/types";

/** A fake device: a manual clock, a route, a set of visible elements. */
class FakeEnv implements Env {
  t = 0;
  path = "/";
  visible = new Set<string>();
  sent: Batch[] = [];
  layoutResult: ReturnType<NonNullable<Env["layout"]>> = { overflowX: 0, wide: [], clipped: [] };
  holes: string[] = [];
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private next = 1;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = this.next++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(id: unknown) {
    this.timers = this.timers.filter((x) => x.id !== id);
  }
  route() {
    return this.path;
  }
  isVisible(target: string) {
    return this.visible.has(target);
  }
  device() {
    return { id: "dev-1", platform: "web" as const, viewport: { w: 375, h: 812 } };
  }
  send(b: Batch) {
    this.sent.push(b);
  }
  layout() {
    return this.layoutResult;
  }
  placeholders() {
    return this.holes;
  }
  brokenImages() {
    return [];
  }
  /** Moves the clock, firing timers in order. */
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = end;
  }
}

const tap = (over: Partial<Tap> = {}): Tap => ({ label: "Continue", matches: () => false, ...over });

let env: FakeEnv;
const engine = (contracts: Contract[], layoutSampleRate = 0, flushEvery = 1e9) => {
  const e = new Engine(env, { contracts, layoutSampleRate, random: () => 0.5, flushEvery });
  e.start();
  return e;
};

beforeEach(() => {
  env = new FakeEnv();
  env.path = "/cart";
});

describe("helpers", () => {
  test("paths lose query, hash and anything personal", () => {
    expect(normalizePath("https://app.example/orders/123?x=1#y")).toBe("/orders/:id");
    expect(normalizePath("/u/3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90/settings/")).toBe("/u/:id/settings");
    expect(normalizePath("/reset/eyJhbGciOiJIUzI1NiJ9abc123")).toBe("/reset/:id");
    expect(normalizePath("/checkout")).toBe("/checkout");
  });
  test("route and request patterns", () => {
    expect(matchRoute("/orders/:id", "/orders/42")).toBe(true);
    expect(matchRoute("/orders/:id", "/orders")).toBe(false);
    expect(matchRoute("/docs/*", "/docs/a/b")).toBe(true);
    expect(matchRequest("POST /api/orders", { method: "post", path: "/api/orders" })).toBe(true);
    expect(matchRequest("POST /api/orders", { method: "GET", path: "/api/orders" })).toBe(false);
  });
});

describe("action contracts: expected vs. actual", () => {
  const cont: Contract = { id: "cart.continue", kind: "action", target: "action:cart.continue", expect: [{ screen: "/checkout" }], source: "code" };

  test("holds: the tap leads to the expected screen", () => {
    const e = engine([cont]);
    e.onTap(tap({ action: "cart.continue" }));
    env.advance(400);
    env.path = "/checkout";
    e.onRoute("/checkout");
    expect(e.peek().passes["cart.continue"]).toBe(1);
    expect(e.peek().failures).toEqual([]);
  });

  test("broken: stays on Cart, the validation call failed — reported with the evidence and steps", () => {
    const e = engine([cont]);
    e.onTap(tap({ action: "cart.continue" }));
    e.onRequest({ method: "POST", url: "https://app.example/api/cart/validate?x=1", status: 422, ms: 180 });
    env.advance(3000);
    const [f] = e.peek().failures;
    expect(f).toMatchObject({
      contract: "cart.continue",
      route: "/cart",
      expected: { screen: "/checkout" },
      actual: { screen: "/cart", afterMs: 3000 },
      evidence: { requests: [{ call: "POST /api/cart/validate", status: 422, ms: 180 }], errors: [] },
    });
    expect(f!.steps).toEqual(["screen /cart", "tap Continue", "request POST /api/cart/validate → 422"]);
  });

  test("request and visible expectations; a repeated tap restarts the same check", () => {
    const pay: Contract = { id: "pay", kind: "action", target: "#pay", expect: [{ request: "POST /api/orders" }, { visible: "#receipt" }], within: 5000, source: "declared" };
    const e = engine([pay]);
    const t = tap({ label: "Pay", matches: (s) => s === "#pay" });
    e.onTap(t);
    env.advance(500);
    e.onTap(t);
    e.onRequest({ method: "POST", url: "/api/orders", status: 201, ms: 300 });
    env.advance(300);
    env.visible.add("#receipt");
    env.advance(200);
    expect(e.peek().passes.pay).toBe(1);
    expect(e.peek().failures).toEqual([]);

    e.onTap(t);
    e.onRequest({ method: "POST", url: "/api/orders", status: 500, ms: 90 });
    env.advance(5000);
    const fails = e.peek().failures.filter((f) => f.contract === "pay");
    expect(fails[0]!.actual).toMatchObject({ "POST /api/orders": [500] });
  });

  test("input the app rejected and said so is not a bug; rejected without a word is", () => {
    const e = engine([cont]);
    e.onTap(tap({ action: "cart.continue" }));
    e.onRequest({ method: "POST", url: "/api/cart/validate", status: 422, ms: 50 });
    env.visible.add('[role="alert"], [aria-invalid="true"], [data-day2-error]');
    env.advance(3000);
    expect(e.peek().failures).toEqual([]);
    expect(e.peek().passes["cart.continue#rejected"]).toBe(1);
    env.visible.clear();
    e.onTap(tap({ action: "cart.continue" }));
    e.onRequest({ method: "POST", url: "/api/cart/validate", status: 422, ms: 50 });
    env.advance(3000);
    expect(e.peek().failures).toHaveLength(1);
  });

  test("internal links check themselves without any contract file", () => {
    const e = engine([]);
    e.onTap(tap({ label: "Orders", linkTo: "/orders" }));
    env.advance(3000);
    expect(e.peek().failures[0]).toMatchObject({ contract: "builtin:action.link /orders", expected: { screen: "/orders" }, actual: { screen: "/cart" } });
  });
});

describe("screens, speed, flows, stability", () => {
  test("required elements must appear in time; screen-ready speed is measured", () => {
    const e = engine([
      { id: "checkout.screen", kind: "screen", route: "/checkout", require: ["#total", "#pay"], readyWithin: 2000, source: "code" },
      { id: "checkout.fast", kind: "speed", metric: "screen_ready", route: "/checkout", maxMs: 1000, source: "declared" },
    ]);
    env.path = "/checkout";
    e.onRoute("/checkout");
    env.visible.add("#total");
    env.advance(1200);
    env.visible.add("#pay");
    env.advance(100);
    expect(e.peek().passes["checkout.screen"]).toBe(1);
    expect(e.peek().failures.find((f) => f.contract === "checkout.fast")).toMatchObject({ expected: { maxMs: 1000 }, actual: { ms: 1300 } });

    env.visible.clear();
    env.path = "/cart";
    e.onRoute("/cart");
    env.path = "/checkout";
    e.onRoute("/checkout");
    env.advance(2100);
    expect(e.peek().failures.find((f) => f.contract === "checkout.screen")).toMatchObject({ actual: { missing: ["#total", "#pay"] } });
  });

  test("built-in screen looks: placeholder text, and layout on sampled screens", () => {
    env.holes = ["undefined"];
    env.layoutResult = { overflowX: 48, wide: ["div.banner"], clipped: [] };
    const e = engine([], 1);
    env.advance(1600);
    const ids = e.peek().failures.map((f) => f.contract);
    expect(ids).toContain("builtin:screen.placeholder /cart");
    expect(ids).toContain("builtin:screen.fits /cart");
    expect(e.peek().failures.find((f) => f.contract.startsWith("builtin:screen.fits"))!.actual).toMatchObject({ overflowPx: 48, viewport: { w: 375 } });
  });

  test("a flow must complete in order", () => {
    const flow: Contract = { id: "signup", kind: "flow", name: "Sign-up", steps: ["/signup", "/signup/profile", "/welcome"], within: 60_000, source: "declared" };
    const e = engine([flow]);
    for (const p of ["/signup", "/signup/profile", "/welcome"]) {
      env.path = p;
      e.onRoute(p);
    }
    expect(e.peek().passes.signup).toBe(1);
    env.path = "/signup";
    e.onRoute("/signup");
    env.advance(60_000);
    expect(e.peek().failures.find((f) => f.contract === "signup")!.actual).toEqual({ stoppedAt: "/signup", completed: 1, of: 3 });
  });

  test("errors, freezes, server errors, endless loading, slow taps", () => {
    const e = engine([]);
    e.onError("TypeError: cannot read 'total' of undefined");
    e.onFreeze(2600);
    e.onFreeze(300);
    e.onRequest({ method: "GET", url: "/api/items", status: 503, ms: 40 });
    e.onInteraction(450, "Add to cart");
    env.visible.add('[aria-busy="true"], [data-day2-loading]');
    env.advance(11_000);
    const ids = e.peek().failures.map((f) => f.contract);
    expect(ids).toEqual(
      expect.arrayContaining([
        "builtin:stability.error",
        "builtin:stability.freeze",
        "builtin:stability.server_error GET /api/items",
        "builtin:speed.inp /cart",
        "builtin:speed.loading /cart",
      ]),
    );
    expect(ids.filter((i) => i === "builtin:stability.freeze")).toHaveLength(1);
  });

  test("invariants from the app's own code", () => {
    const e = engine([]);
    e.check("receipt.total", true);
    e.check("receipt.total", false, { total: 30, sum: 32 });
    expect(e.peek().passes["receipt.total"]).toBe(1);
    expect(e.peek().failures[0]).toMatchObject({ contract: "receipt.total", evidence: { detail: { total: 30, sum: 32 } } });
  });
});

describe("sending", () => {
  test("batches on a timer; a broken contract is reported a few times, then only counted", () => {
    const e = engine([], 0, 10_000);
    for (let i = 0; i < 6; i++) e.onError("boom");
    e.track("signup", { campaignId: "B-3" });
    env.advance(10_000);
    const b = env.sent.at(-1)!;
    expect(b.failures.filter((f) => f.contract === "builtin:stability.error")).toHaveLength(3);
    expect(b.passes["builtin:stability.error#failed"]).toBe(3);
    expect(b.events).toEqual([{ type: "signup", at: expect.any(String), acquisition: { campaignId: "B-3" } }]);
    expect(b.device.id).toBe("dev-1");
    env.advance(10_000);
    expect(env.sent.length).toBeGreaterThanOrEqual(1);
  });
});
