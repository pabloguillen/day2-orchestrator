import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { chromiumPath, PROFILES, safeAction, simulate } from "./simulation";
import type { Contract } from "../packages/sensors/src/types";

/**
 * The simulation against a small app with known bugs:
 *  - /wide overflows on phones (not on desktop)
 *  - "Go to B" leads to /a instead of /b
 *  - /flaky shows "undefined" only on its very first load (must not be recorded)
 *  - a link to /missing that 404s
 *  - "Place order" writes (POST) — must never be clicked on a live app
 */

const EXE = chromiumPath();
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let orders = 0;
let flakyHits = 0;

const page = (body: string) =>
  new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>t</title></head><body>${body}
<script>
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]");
  if (go) { e.preventDefault(); history.pushState({}, "", go.getAttribute("data-go")); document.body.insertAdjacentHTML("beforeend", "<p>moved</p>"); }
  if (e.target.id === "order") fetch("/api/orders", { method: "POST" });
});
</script></body></html>`, { headers: { "content-type": "text/html" } });

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/orders") {
        orders++;
        return new Response(null, { status: 201 });
      }
      if (u.pathname === "/") return page('<h1>Home</h1><button data-day2-action="go.b" data-go="/a">Go to B</button><button id="order" data-day2-action="order.place">Place order</button><a href="/wide">Wide</a> <a href="/missing">Missing</a>');
      if (u.pathname === "/wide") return page('<h1>Wide</h1><div style="width:600px;height:20px;background:#ccc">promo</div>');
      if (u.pathname === "/flaky") return page(`<h1>Flaky</h1><p>${flakyHits++ === 0 ? "Hello undefined" : "Hello Sam"}</p>`);
      if (u.pathname === "/a" || u.pathname === "/b") return page(`<h1>${u.pathname}</h1>`);
      return new Response("not found", { status: 404 });
    },
  });
  if (EXE) browser = await chromium.launch({ executablePath: EXE });
});
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const contracts: Contract[] = [
  { id: "screen:/", kind: "screen", route: "/", source: "code" },
  { id: "screen:/wide", kind: "screen", route: "/wide", source: "code" },
  { id: "screen:/flaky", kind: "screen", route: "/flaky", source: "code" },
  { id: "screen:/orders/:id", kind: "screen", route: "/orders/:id", source: "code" },
  { id: "go.b", kind: "action", target: "action:go.b", expect: [{ screen: "/b" }], within: 800, source: "code" },
  { id: "order.place", kind: "action", target: "action:order.place", expect: [{ request: "POST /api/orders" }, { screen: "/receipt" }], source: "code" },
];

describe("what may run on a live app", () => {
  test("only actions that read", () => {
    expect(contracts.filter(safeAction).map((c) => c.id)).toEqual(["go.b"]);
  });
});

describe.skipIf(!EXE)("the daily simulation in a real browser", () => {
  test("finds the bugs, confirms each on a second try, never writes, drops the flaky one", async () => {
    const profiles = PROFILES.filter((p) => p.id === "small-android" || p.id === "desktop");
    const { batches, run } = await simulate({ baseUrl: `http://localhost:${server.port}`, contracts, profiles, browser });

    expect(orders).toBe(0); // "Place order" was never clicked
    expect(run).toMatchObject({ profiles: ["Small Android, German, dark", "Desktop"], skipped: ["1 action that write data (not run on the live app)"] });
    expect(run.flaky).toBeGreaterThanOrEqual(1);

    const phone = batches.find((b) => b.device.id === "sim-small-android")!;
    const desk = batches.find((b) => b.device.id === "sim-desktop")!;
    expect(phone.device).toMatchObject({ platform: "web", model: "day2 simulation: Small Android, German, dark", viewport: { w: 360, h: 740 }, locale: "de-DE", theme: "dark" });

    const ids = (b: typeof phone) => b.failures.map((f) => f.contract);
    // Overflow on the phone only.
    expect(ids(phone)).toContain("builtin:screen.fits /wide");
    expect(ids(desk)).not.toContain("builtin:screen.fits /wide");
    // The wrong navigation, everywhere, with expected vs. actual.
    expect(phone.failures.find((f) => f.contract === "go.b")).toMatchObject({ expected: { screen: "/b" }, actual: { screen: "/a" }, evidence: { detail: { simulated: true, reproduced: true } } });
    // The flaky placeholder isn't recorded.
    expect([...ids(phone), ...ids(desk)].some((c) => c.startsWith("builtin:screen.placeholder"))).toBe(false);
    // The dead link, found on the desktop pass.
    expect(desk.failures.find((f) => f.contract === "builtin:action.link /missing")).toMatchObject({ actual: { status: 404 } });
    // Things that held are counted.
    expect(desk.passes["builtin:action.link /wide"]).toBe(1);
    // No growth events from the simulation.
    expect(batches.every((b) => b.events.length === 0)).toBe(true);
  }, 120_000);
});
