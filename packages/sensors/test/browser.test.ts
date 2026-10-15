import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Batch } from "../src/types";

/**
 * The library in a real browser: a tiny single-page app where "Continue"
 * should lead to /checkout but stays on /cart when validation fails, and a
 * fake day2 that collects what the library sends.
 */

const EXE = [process.env.PW_CHROMIUM_PATH, "/opt/pw-browsers/chromium", (() => {
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
})()].find((p): p is string => Boolean(p && existsSync(p)));

const received: Batch[] = [];
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let bundle = "";

const APP = (port: number) => `<!doctype html><html><head><meta charset="utf-8"><title>shop</title></head><body>
<main id="app"></main>
<script type="module">
import { startDay2 } from "/sensors.js";
const day2 = startDay2({
  key: "d2k_test", endpoint: "http://localhost:${port}", release: "1.2.3", layoutSampleRate: 1,
  contracts: [
    { id: "cart.continue", kind: "action", target: "action:cart.continue", expect: [{ screen: "/checkout" }], within: 1500, source: "code" },
    { id: "checkout.ready", kind: "screen", route: "/checkout", require: ["#total"], readyWithin: 1000, source: "code" }
  ],
  fetchContracts: false
});
window.day2 = day2;
const render = () => {
  const p = location.pathname;
  const app = document.getElementById("app");
  if (p === "/cart") app.innerHTML = '<h1>Cart</h1><button data-day2-action="cart.continue" id="continue">Continue</button><a href="/help" id="help">Help</a><button id="ok">OK flow</button>';
  else if (p === "/checkout") app.innerHTML = '<h1>Checkout</h1><p id="total">Total 30</p>';
  else if (p === "/broken") app.innerHTML = '<h1>Broken</h1><p>Hello undefined</p><div style="width:2000px;height:10px;background:red"></div>';
  else app.innerHTML = '<h1>' + p + '</h1>';
};
render();
document.addEventListener("click", async (e) => {
  if (e.target.id === "continue") {
    const r = await fetch("/api/cart/validate?session=abc", { method: "POST" });
    if (r.ok) { history.pushState({}, "", "/checkout"); render(); }
  }
  if (e.target.id === "ok") { history.pushState({}, "", "/checkout"); render(); }
  if (e.target.id === "help") { e.preventDefault(); }
});
</script></body></html>`;

beforeAll(async () => {
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "../src/index.ts")], target: "browser", format: "esm" });
  bundle = await built.outputs[0]!.text();
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/sensors.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      if (url.pathname.startsWith("/api/ingest/")) {
        received.push(JSON.parse(await req.text()) as Batch);
        return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
      }
      if (url.pathname === "/api/cart/validate") return Response.json({ error: "postcode" }, { status: 422 });
      return new Response(APP(server.port!), { headers: { "content-type": "text/html" } });
    },
  });
  if (EXE) browser = await chromium.launch({ executablePath: EXE });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const failures = () => received.flatMap((b) => b.failures);

// Needs a Chromium; skipped where none is installed.
describe.skipIf(!EXE)("in a real browser", () => {
  test("expected Checkout, actually stayed on Cart — with the failed call and the steps", async () => {
    const page = await browser.newPage({ viewport: { width: 375, height: 700 } });
    await page.goto(`http://localhost:${server.port}/cart?utm=x`);
    await page.click("#continue");
    await page.waitForTimeout(1700);
    await page.evaluate(() => (window as unknown as { day2: { flush(): void } }).day2.flush());
    await page.waitForTimeout(300);
    const f = failures().find((x) => x.contract === "cart.continue");
    expect(f).toMatchObject({
      route: "/cart",
      expected: { screen: "/checkout" },
      actual: { screen: "/cart" },
      evidence: { requests: [{ call: "POST /api/cart/validate", status: 422 }] },
    });
    expect(f!.steps).toEqual(["screen /cart", "tap cart.continue", "request POST /api/cart/validate → 422"]);
    const batch = received.find((b) => b.failures.length)!;
    expect(batch.release).toBe("1.2.3");
    expect(batch.device).toMatchObject({ platform: "web", viewport: { w: 375, h: 700 }, browser: "Chrome" });
    // The visit, with no query string anywhere.
    expect(received.flatMap((b) => b.events)).toContainEqual(expect.objectContaining({ type: "visit", acquisition: { channel: "direct" } }));
    expect(JSON.stringify(received)).not.toContain("session=abc");
    expect(JSON.stringify(received)).not.toContain("utm");
    await page.close();
  });

  test("a screen that holds is counted; a link that goes nowhere and a broken page are reported", async () => {
    received.length = 0;
    const page = await browser.newPage({ viewport: { width: 375, height: 700 } });
    await page.goto(`http://localhost:${server.port}/cart`);
    await page.click("#ok");
    await page.waitForSelector("#total");
    await page.waitForTimeout(300);
    await page.goto(`http://localhost:${server.port}/cart`);
    await page.click("#help");
    await page.waitForTimeout(3200);
    await page.evaluate(() => {
      history.pushState({}, "", "/broken");
      document.getElementById("app")!.innerHTML = '<h1>Broken</h1><p>Hello undefined</p><div style="width:2000px;height:10px;background:red"></div>';
    });
    await page.waitForTimeout(1800);
    await page.evaluate(() => (window as unknown as { day2: { flush(): void } }).day2.flush());
    await page.waitForTimeout(300);
    const passes = received.reduce<Record<string, number>>((acc, b) => {
      for (const [k, v] of Object.entries(b.passes)) acc[k] = (acc[k] ?? 0) + v;
      return acc;
    }, {});
    const ids = failures().map((f) => f.contract);
    expect(ids).toContain("builtin:action.link /help");
    expect(ids).toContain("builtin:screen.placeholder /broken");
    expect(ids).toContain("builtin:screen.fits /broken");
    expect(failures().find((f) => f.contract === "builtin:screen.fits /broken")!.actual).toMatchObject({ overflowPx: expect.any(Number), wider: ["div"] });
    // The checkout screen contract held after the working flow.
    expect(passes["checkout.ready"]).toBeGreaterThanOrEqual(1);
    await page.close();
  }, 20_000);

  test("an uncaught error is reported at once", async () => {
    received.length = 0;
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.port}/cart`);
    await page.evaluate(() => setTimeout(() => {
      throw new Error("cannot read total of undefined");
    }, 0));
    await page.waitForTimeout(200);
    await page.evaluate(() => (window as unknown as { day2: { flush(): void } }).day2.flush());
    await page.waitForTimeout(300);
    expect(failures().find((f) => f.contract === "builtin:stability.error")).toMatchObject({ actual: expect.stringContaining("cannot read total of undefined") });
    await page.close();
  });
});
