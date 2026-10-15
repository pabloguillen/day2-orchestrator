import { afterAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "./apps-registry";
import { emptyBacklog, findTicket, loadBacklog, saveBacklog } from "./backlog";
import { backlogFile, runTicket, tick } from "./backlog-work";
import { fileFieldStore, type ContractHealth } from "./field-store";
import { appEvents, contractSignals, describeBroken, fieldSignals, INSTALL_KEY, installItem, pageHealth, placeLibrary, refreshContracts } from "./field-work";
import type { PipelineDeps } from "./pipeline";
import type { Batch } from "../packages/sensors/src/types";

const ROOT = mkdtempSync(join(tmpdir(), "day2-fieldwork-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const REPO = join(ROOT, "app");
mkdirSync(join(REPO, "src"), { recursive: true });
writeFileSync(join(REPO, "package.json"), '{"dependencies":{"react-router-dom":"6"}}');
writeFileSync(
  join(REPO, "src/Cart.tsx"),
  `export function Cart() { return <button data-day2-action="cart.continue" onClick={async () => { const r = await fetch("/api/cart/validate", { method: "POST" }); if (r.ok) navigate("/checkout"); }}>Continue</button>; }
   export function Old() { return <button onClick={() => navigate("/orders")}>Orders</button>; }`,
);
writeFileSync(join(REPO, "src/main.tsx"), `const r = createBrowserRouter([{ path: "/cart" }, { path: "/checkout" }]);`);
execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init && git remote add origin https://github.com/example/buddy", { cwd: REPO });

const app: AppEntry = { id: "app_f", name: "buddy", repoPath: REPO, connectionMethod: "local_path", appBaseUrl: "https://buddy.example", addedAt: "2026-10-01T00:00:00Z" };
const store = fileFieldStore(join(ROOT, "field"));
const NOW = new Date("2026-10-15T12:00:00Z");

const failure = (over: Partial<Batch["failures"][number]> = {}): Batch["failures"][number] => ({
  contract: "cart.continue",
  at: "2026-10-15T11:00:00Z",
  route: "/cart",
  expected: { screen: "/checkout", "POST /api/cart/validate": "2xx" },
  actual: { screen: "/cart", afterMs: 3000, "POST /api/cart/validate": [500] },
  evidence: { requests: [{ call: "POST /api/cart/validate", status: 500, ms: 240 }], errors: [] },
  steps: ["screen /cart", "tap cart.continue", "request POST /api/cart/validate → 500"],
  ...over,
});
const batch = (id: string, failures: Batch["failures"], passes: Record<string, number> = {}): Batch => ({
  v: 1,
  release: "2.0.1",
  device: { id, platform: "web", os: "iOS", browser: "Safari", viewport: { w: 390, h: 844 }, locale: "de-DE" },
  passes,
  failures,
  events: [],
});

describe("field contracts in day2's loops", () => {
  test("contracts follow the code: generated once per commit", async () => {
    const first = await refreshContracts(app, store, NOW);
    expect(first).toMatchObject({ changed: true, screens: 2, actions: 1 });
    expect(first.candidates.map((c) => c.name)).toEqual(["cart.orders"]);
    expect((await refreshContracts(app, store, NOW)).changed).toBe(false);
    writeFileSync(join(REPO, "src/main.tsx"), `const r = createBrowserRouter([{ path: "/cart" }, { path: "/checkout" }, { path: "/receipt" }]);`);
    execSync("git -c user.email=t@t -c user.name=t commit -qam routes", { cwd: REPO });
    expect(await refreshContracts(app, store, NOW)).toMatchObject({ changed: true, screens: 3 });
  });

  test("a broken contract becomes a bug ticket with expected, actual, steps, devices and the code location", async () => {
    await store.record(app.id, batch("dev-aaaaaaaa", [failure()], { "cart.continue": 20 }), NOW);
    await store.record(app.id, batch("dev-bbbbbbbb", [failure()]), NOW);
    // One-off noise on one device stays out.
    await store.record(app.id, batch("dev-cccccccc", [failure({ contract: "builtin:screen.placeholder /cart", expected: "no placeholder text", actual: ['p: "undefined"'] })]), NOW);
    const signals = await fieldSignals(app, store, NOW);
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s).toMatchObject({ id: "field:cart.continue", source: "field-contract", occurrences: 2, affectedUsers: 2, path: "/cart" });
    expect(s.finding).toBe("Tap “cart.continue” on /cart should lead to /checkout — stayed on /cart (POST /api/cart/validate → 500)");
    expect(s.suggestedAction).toContain("Steps to reproduce (from the user's session):\n1. screen /cart\n2. tap cart.continue\n3. request POST /api/cart/validate → 500");
    expect(s.suggestedAction).toContain("Seen on: web, iOS, Safari, 390×844, de-DE, release 2.0.1");
    expect(s.suggestedAction).toContain("Where in the code: src/Cart.tsx:1");
    expect(s.suggestedAction).toContain("(9% of checks)");

    saveBacklog(backlogFile(app), emptyBacklog());
    await tick(app, { gatherSignals: () => fieldSignals(app, store, NOW), now: NOW });
    const t = loadBacklog(backlogFile(app)).tickets.find((x) => x.source.key === "field:cart.continue")!;
    expect(t).toMatchObject({ type: "bug", source: { kind: "health_check" } });
    expect(t.description).toContain("Expected: screen /checkout");
  });

  test("built-in checks read as plain sentences", () => {
    const h = (contract: string, actual: unknown, expected: unknown = {}): ContractHealth => ({
      contract,
      passes: 0,
      failures: 3,
      rejected: 0,
      devices: 2,
      firstFailureAt: null,
      lastFailureAt: null,
      sample: { contract, at: "", route: "/checkout", expected, actual, steps: [], deviceId: "d", release: null, device: { id: "d", platform: "web" } },
    });
    expect(describeBroken(h("builtin:screen.fits /checkout", { overflowPx: 40, wider: ["div#promo"], clipped: [], viewport: { w: 375, h: 700 } }), undefined)).toBe(
      "/checkout doesn't fit a 375 px wide screen (div#promo too wide)",
    );
    expect(describeBroken(h("builtin:speed.lcp /checkout", { ms: 4100 }, { maxMs: 2500 }), undefined)).toBe("/checkout takes 4100 ms to show its main content (budget 2500 ms)");
    expect(describeBroken(h("builtin:stability.server_error POST /api/orders", { status: 502 }), undefined)).toBe("POST /api/orders fails with 502");
    expect(contractSignals("a", [{ ...h("builtin:stability.crash", "boom"), failures: 1, devices: 1 }], null, NOW)).toHaveLength(1);
  });

  test("install: a ticket with the key and endpoint; day2 places the library in the working copy itself", async () => {
    const item = installItem(app, { key: "d2k_testtesttesttesttest", endpoint: "https://day2.example", candidates: (await store.contracts(app.id))!.candidates })!;
    expect(item).toMatchObject({ source: { kind: "day2_proposal", key: INSTALL_KEY }, type: "task", title: "Install day2 field checks" });
    expect(item.description).toContain('startDay2({ key: "d2k_testtesttesttesttest", endpoint: "https://day2.example"');
    expect(item.description).toContain('src/Cart.tsx:2 "Orders" → data-day2-action="cart.orders"');
    expect(installItem({ ...app, repoPath: ROOT }, { key: "k", endpoint: "e", candidates: [] })).toBeNull(); // not a web app

    const dir = await placeLibrary(join(ROOT, "copy"));
    expect(readFileSync(join(dir, "sensors.js"), "utf-8")).toContain("startDay2");
    expect(existsSync(join(dir, "sensors.d.ts"))).toBe(true);

    // The install ticket's run gets the files before the agent starts.
    saveBacklog(backlogFile(app), emptyBacklog());
    await tick(app, { extraItems: async () => [item], now: NOW });
    const t = loadBacklog(backlogFile(app)).tickets.find((x) => x.source.key === INSTALL_KEY)!;
    let seen = false;
    const clone = join(ROOT, "clone");
    mkdirSync(clone, { recursive: true });
    const ok = { finalText: "done", isError: false, costUsd: 0, numTurns: 1 };
    const deps: Partial<PipelineDeps> = {
      cloneIsolatedWorkspace: async () => clone,
      createFixBranch: async () => "day2-fix-x",
      runFixAgent: async (cwd) => {
        seen = existsSync(join(cwd, "day2", "sensors.js"));
        return ok;
      },
      hasChanges: async () => true,
      diffStat: async () => " src/main.tsx | 3 +\n src/day2/day2.test.ts | 12 +",
      commitAll: async () => {},
      runVerifierAgent: async () => ({ ...ok, finalText: "VERDICT: APPROVE" }),
      pushBranch: async () => {},
      openFixPr: async () => "https://github.com/example/buddy/pull/7",
      removeWorkspace: () => {},
    };
    process.env.DAY2_CREDITS = "off";
    await runTicket(app, t.id, deps);
    delete process.env.DAY2_CREDITS;
    expect(seen).toBe(true);
    expect(findTicket(loadBacklog(backlogFile(app)), t.id)!.state).toBe("to_approve");
  });

  test("growth reads events from the field; pages with broken checks aren't fit for ads", async () => {
    await store.record(app.id, { ...batch("dev-dddddddd", []), events: [{ type: "visit", at: "2026-10-15T10:00:00Z", acquisition: { campaignId: "B-1", channel: "paid" } }] }, NOW);
    const ev = await appEvents(app, "2026-10-14T00:00:00Z", store);
    expect(ev).toEqual([{ type: "visit", at: "2026-10-15T10:00:00Z", deviceId: "dev-dddddddd", acquisition: { campaignId: "B-1", channel: "paid" } }]);

    await store.record(app.id, batch("dev-eeeeeeee", [failure({ contract: "builtin:screen.fits /go/split", route: "/go/split", expected: "fits the screen", actual: { overflowPx: 30, wider: ["img"], clipped: [], viewport: { w: 360, h: 740 } } })]), NOW);
    await store.record(app.id, batch("dev-ffffffff", [failure({ contract: "builtin:screen.fits /go/split", route: "/go/split", expected: "fits the screen", actual: { overflowPx: 30, wider: ["img"], clipped: [], viewport: { w: 360, h: 740 } } })]), NOW);
    expect(await pageHealth(app, "/go/split", store, NOW)).toEqual({ ok: false, reason: "/go/split doesn't fit a 360 px wide screen (img too wide)" });
    expect(await pageHealth(app, "/go/other", store, NOW)).toEqual({ ok: true, reason: "" });
  });
});
