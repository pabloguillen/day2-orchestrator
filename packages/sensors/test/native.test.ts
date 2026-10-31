import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { Batch } from "../src/types";

/**
 * The React Native adapter against a fake react-native: what an app does
 * (navigate, press, call the backend, show a mark, crash, go to the
 * background) and what day2 receives.
 */

const sent: Batch[] = [];
const appState: Array<(s: string) => void> = [];
let errorHandler: ((e: unknown, fatal?: boolean) => void) | null = null;
const effects: Array<() => void | (() => void)> = [];

mock.module("react", () => ({
  useRef: <T>(v: T) => ({ current: v }),
  useEffect: (fn: () => void | (() => void)) => effects.push(fn),
}));
mock.module("react-native", () => ({
  Platform: { OS: "ios", Version: "18.1" },
  Dimensions: { get: () => ({ width: 390, height: 844 }) },
  Appearance: { getColorScheme: () => "dark" },
  PixelRatio: { getFontScale: () => 1.3 },
  Linking: { getInitialURL: async () => "buddy://go/split?d2=B-4.tiktok.v1&ttclid=E.C.P.abc123" },
  AppState: {
    addEventListener: (_t: string, cb: (s: string) => void) => {
      appState.push(cb);
      return { remove() {} };
    },
  },
}));

/** A tiny XHR that "calls" a fake backend, like React Native's own. */
class FakeXHR {
  status = 0;
  private listeners: Array<() => void> = [];
  private url = "";
  open(_m: string, url: string) {
    this.url = url;
  }
  addEventListener(_e: string, cb: () => void) {
    this.listeners.push(cb);
  }
  send() {
    this.status = this.url.includes("/api/cart/validate") ? 500 : 200;
    setTimeout(() => this.listeners.forEach((l) => l()), 5);
  }
}

let day2: import("../src/native").Day2Native;
let mod: typeof import("../src/native");
const realFetch = globalThis.fetch;

beforeAll(async () => {
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXHR;
  (globalThis as { ErrorUtils?: unknown }).ErrorUtils = {
    getGlobalHandler: () => () => {},
    setGlobalHandler: (h: (e: unknown, fatal?: boolean) => void) => {
      errorHandler = h;
    },
  };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/contracts")) return new Response(JSON.stringify({ version: 1, generatedAt: "", contracts: [] }), { status: 200 });
    if (init?.method === "POST") sent.push(JSON.parse(String(init.body)) as Batch);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  mod = await import("../src/native");
  day2 = mod.startDay2({
    key: "d2k_native",
    endpoint: "https://day2.example",
    release: "3.0.0",
    model: "iPhone 15",
    fetchContracts: false,
    adClickIds: "after_consent",
    contracts: [
      { id: "cart.continue", kind: "action", target: "action:cart.continue", expect: [{ screen: "Checkout" }], within: 300, source: "code" },
      { id: "screen:Checkout", kind: "screen", route: "Checkout", require: ['[data-day2-require="total"]'], readyWithin: 300, source: "code" },
    ],
  });
});
afterAll(() => {
  day2.stop();
  globalThis.fetch = realFetch;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failures = () => sent.flatMap((b) => b.failures);

describe("React Native / Expo", () => {
  test("a press that should lead to Checkout but stays on Cart, with the failed call — sent when the app goes to the background", async () => {
    let nav: () => void = () => {};
    let current = "Cart";
    day2.trackNavigation({ getCurrentRoute: () => ({ name: current }), addListener: (_e, cb) => ((nav = cb), () => {}) });
    const onContinue = day2.action("cart.continue", () => {
      const x = new XMLHttpRequest();
      x.open("POST", "https://api.buddy.app/api/cart/validate?token=abc");
      x.send();
    });
    onContinue();
    await wait(400);
    appState.forEach((cb) => cb("background"));
    const f = failures().find((x) => x.contract === "cart.continue");
    expect(f).toMatchObject({
      route: "/Cart",
      expected: { screen: "Checkout" },
      actual: { screen: "/Cart" },
      evidence: { requests: [{ call: "POST /api/cart/validate", status: 500 }] },
      steps: ["screen /Cart", "tap cart.continue", "request POST /api/cart/validate → 500"],
    });
    const b = sent.at(-1)!;
    expect(b.device).toMatchObject({ platform: "ios", os: "iOS 18.1", model: "iPhone 15", viewport: { w: 390, h: 844 }, theme: "dark", textScale: 1.3 });
    expect(b.release).toBe("3.0.0");
    expect(JSON.stringify(sent)).not.toContain("token=abc");

    // Navigating to Checkout with the total marked: the screen contract holds.
    current = "Checkout";
    nav();
    const mark = mod.useDay2Mark("total");
    mark.onLayout({ nativeEvent: { layout: { width: 120, height: 20 } } });
    await wait(150);
    day2.flush();
    const passes = sent.reduce<Record<string, number>>((acc, x) => ({ ...acc, ...x.passes }), {});
    expect(passes["screen:Checkout"]).toBe(1);
    // An unmounted mark no longer counts.
    for (const e of effects) e()?.();
    expect(mod.markVisible('[data-day2-require="total"]')).toBe(false);
  });

  test("crashes are reported; the visit carries the campaign from the link that opened the app", async () => {
    errorHandler!(new Error("undefined is not an object (evaluating 'cart.items')"), true);
    await wait(10);
    expect(failures().find((f) => f.contract === "builtin:stability.crash")).toMatchObject({ actual: "undefined is not an object (evaluating 'cart.items')" });
    day2.flush();
    expect(sent.flatMap((b) => b.events)).toContainEqual(expect.objectContaining({ type: "visit", acquisition: { campaignId: "B-4.tiktok.v1", channel: "paid" } }));
    expect(day2.cameFrom()).toEqual({ experiment: "B-4", platform: "tiktok", ad: "v1" });
  });

  test("the ad's click id stays on the device until the user agrees, then goes once", async () => {
    expect(JSON.stringify(sent)).not.toContain("E.C.P.abc123");
    day2.allowAdTracking();
    day2.allowAdTracking();
    day2.flush();
    const clicks = sent.flatMap((b) => b.events).filter((e) => e.type === "ad_click");
    expect(clicks).toEqual([expect.objectContaining({ acquisition: { campaignId: "B-4.tiktok.v1", channel: "paid", click: { param: "ttclid", value: "E.C.P.abc123" } } })]);
  });
});
