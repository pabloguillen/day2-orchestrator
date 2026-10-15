import { join } from "node:path";
import { existsSync } from "node:fs";
import { chromium, devices, type Browser, type BrowserContext, type Page } from "playwright";
import { normalizePath } from "../packages/sensors/src/core";
import type { Batch, Contract, Failure } from "../packages/sensors/src/types";
import { SIM_DEVICE_PREFIX, type SimulationRun } from "./field-store";

/**
 * day2's scheduled simulation: every day, day2 opens the app's live pages in
 * a real browser as different people would — a small Android phone in German
 * and dark mode, an iPhone, a phone on a slow network with large text, a
 * desktop — and runs the same field contracts the library runs on users'
 * devices (it's injected into each page). So a bug is found before users
 * hit it, in the same words: "expected X, actual Y", with the steps.
 *
 * Safe on a live app: it only visits pages and runs actions whose contracts
 * read (navigation, GET). Nothing is submitted or written, nothing typed.
 * Every failure is tried a second time; only failures that reproduce are
 * recorded (as simulated devices, "sim-…"), so they become tickets at once
 * without flaky noise. Its requests carry "day2-simulation" in the user
 * agent so the app can leave them out of its analytics.
 */

export type SimProfile = {
  id: string;
  label: string;
  viewport: { width: number; height: number };
  mobile: boolean;
  locale: string;
  theme: "light" | "dark";
  /** Root font scale, as with a phone's larger text setting. */
  textScale?: number;
  network?: "slow-3g";
};

export const PROFILES: SimProfile[] = [
  { id: "small-android", label: "Small Android, German, dark", viewport: { width: 360, height: 740 }, mobile: true, locale: "de-DE", theme: "dark" },
  { id: "iphone", label: "iPhone", viewport: { width: 390, height: 844 }, mobile: true, locale: "en-US", theme: "light" },
  { id: "slow-phone", label: "Phone on slow 3G, large text", viewport: { width: 390, height: 844 }, mobile: true, locale: "en-US", theme: "light", textScale: 1.5, network: "slow-3g" },
  { id: "desktop", label: "Desktop", viewport: { width: 1280, height: 800 }, mobile: false, locale: "en-US", theme: "light" },
];

const SINK = "https://day2-simulation.invalid";
const SETTLE_MS = 3500;
const MAX_SCREENS = 25;
const MAX_ACTIONS_PER_SCREEN = 8;
const MAX_LINKS = 40;
const DEFAULT_BUDGET_MS = 5 * 60_000;

let bundle: string | null = null;
async function simBundle(): Promise<string> {
  if (bundle) return bundle;
  const out = await Bun.build({ entrypoints: [join(import.meta.dir, "../packages/sensors/src/sim-entry.ts")], target: "browser", format: "iife", minify: true });
  if (!out.success) throw new Error(`Couldn't build the simulation script: ${out.logs.map((l) => l.message).join("; ")}`);
  bundle = await out.outputs[0]!.text();
  return bundle;
}

/** A Chromium this server can run, or null (simulation is then skipped). */
export function chromiumPath(): string | null {
  for (const p of [process.env.PW_CHROMIUM_PATH, "/opt/pw-browsers/chromium"]) if (p && existsSync(p)) return p;
  try {
    const p = chromium.executablePath();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

const target = (c: Contract & { kind: "action" }) => (c.target.startsWith("action:") ? `[data-day2-action="${c.target.slice(7)}"]` : c.target);

/** Actions safe to run on a live app: every request they expect only reads. */
export const safeAction = (c: Contract): c is Contract & { kind: "action" } =>
  c.kind === "action" && c.expect.every((e) => !("request" in e) || /^GET\s/i.test(e.request.trim()));

const visitable = (route: string) => route.startsWith("/") && !route.includes(":") && !route.includes("*");

type Capture = { passes: Record<string, number>; failures: Failure[] };

/** One unit of work (a screen visit or an action) and what the library saw. */
async function runUnit(page: Page, sink: Capture[], work: () => Promise<void>): Promise<Capture> {
  const before = sink.length;
  await work();
  await page.evaluate(() => (window as unknown as { __day2i?: { flush(): void } }).__day2i?.flush()).catch(() => {});
  await page.waitForTimeout(250);
  const got = sink.slice(before);
  const passes: Record<string, number> = {};
  for (const c of got) for (const [k, n] of Object.entries(c.passes)) passes[k] = (passes[k] ?? 0) + n;
  return { passes, failures: got.flatMap((c) => c.failures) };
}

let desktopAgent: string | null = null;

/** The browser's own desktop user agent (headless marker removed), once. */
async function desktopUserAgent(browser: Browser): Promise<string> {
  if (desktopAgent) return desktopAgent;
  const c = await browser.newContext();
  const pg = await c.newPage();
  desktopAgent = (await pg.evaluate(() => navigator.userAgent)).replace("HeadlessChrome", "Chrome");
  await c.close();
  return desktopAgent;
}

async function openContext(browser: Browser, p: SimProfile, contracts: Contract[], sink: Capture[]): Promise<{ ctx: BrowserContext; page: Page }> {
  const agent = p.mobile ? devices["iPhone 13"]!.userAgent : await desktopUserAgent(browser);
  const ctx = await browser.newContext({
    viewport: p.viewport,
    isMobile: p.mobile,
    hasTouch: p.mobile,
    locale: p.locale,
    colorScheme: p.theme,
    bypassCSP: true,
    userAgent: `${agent} day2-simulation`,
  });
  return finishContext(ctx, p, contracts, sink);
}

async function finishContext(ctx: BrowserContext, p: SimProfile, contracts: Contract[], sink: Capture[]) {
  await ctx.route(`${SINK}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      try {
        const b = JSON.parse(req.postData() ?? "{}") as Batch;
        sink.push({ passes: b.passes ?? {}, failures: b.failures ?? [] });
      } catch {
        // Ignore a malformed batch.
      }
    }
    await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
  });
  const script = await simBundle();
  const start = `window.__day2i = window.__day2.startDay2(${JSON.stringify({ key: "d2k_simulation", endpoint: SINK, contracts, fetchContracts: false, layoutSampleRate: 1 })});`;
  const scale = p.textScale ? `document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = "${Math.round(p.textScale * 100)}%"; });` : "";
  await ctx.addInitScript({ content: `${script}\n${start}\n${scale}` });
  const page = await ctx.newPage();
  if (p.network === "slow-3g") {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 });
  }
  return { ctx, page };
}

export type SimInput = {
  baseUrl: string;
  contracts: Contract[];
  profiles?: SimProfile[];
  browser?: Browser;
  budgetMs?: number;
  now?: () => Date;
};

export type SimOutput = { batches: Batch[]; run: SimulationRun };

export async function simulate(input: SimInput): Promise<SimOutput> {
  const startedAt = Date.now();
  const now = input.now ?? (() => new Date());
  const budget = input.budgetMs ?? DEFAULT_BUDGET_MS;
  const base = input.baseUrl.replace(/\/+$/, "");
  const origin = new URL(base).origin;
  const profiles = input.profiles ?? PROFILES;
  const skipped: string[] = [];
  const screens = [...new Set(input.contracts.filter((c) => c.kind === "screen").map((c) => (c as { route: string }).route).filter(visitable))].slice(0, MAX_SCREENS);
  if (!screens.includes("/")) screens.unshift("/");
  const actions = input.contracts.filter(safeAction);
  const unsafe = input.contracts.filter((c) => c.kind === "action" && !safeAction(c)).length;
  if (unsafe) skipped.push(`${unsafe} action${unsafe === 1 ? "" : "s"} that write data (not run on the live app)`);

  const exe = input.browser ? null : chromiumPath();
  if (!input.browser && !exe) throw new Error("No Chromium on this server — simulation needs one (the Docker image installs it).");
  const browser = input.browser ?? (await chromium.launch({ executablePath: exe! }));
  const batches: Batch[] = [];
  let screensRun = 0;
  let actionsRun = 0;
  let linksRun = 0;
  let confirmed = 0;
  let flaky = 0;
  const out = () => Date.now() - startedAt > budget;

  try {
    for (const p of profiles) {
      if (out()) {
        skipped.push(`profile ${p.id}: out of time`);
        continue;
      }
      const sink: Capture[] = [];
      const { ctx, page } = await openContext(browser, p, input.contracts, sink);
      const passes: Record<string, number> = {};
      const keep: Failure[] = [];
      const add = (c: Capture) => {
        for (const [k, n] of Object.entries(c.passes)) passes[k] = (passes[k] ?? 0) + n;
      };
      /** Runs a unit; failures must happen again on a second try to count. */
      const confirm = async (unit: () => Promise<void>) => {
        const first = await runUnit(page, sink, unit);
        add(first);
        if (!first.failures.length) return;
        const again = await runUnit(page, sink, unit);
        const twice = new Set(again.failures.map((f) => f.contract));
        for (const f of again.failures) if (first.failures.some((x) => x.contract === f.contract)) keep.push(f);
        const flakyHere = first.failures.filter((f) => !twice.has(f.contract)).length;
        flaky += flakyHere;
      };
      const visit = async (route: string) => {
        const res = await page.goto(`${base}${route}`, { waitUntil: "load", timeout: 30_000 }).catch(() => null);
        if (res && res.status() >= 400) {
          sink.push({
            passes: {},
            failures: [{ contract: `screen:${route}`, at: now().toISOString(), route: normalizePath(route), expected: "the page loads", actual: { status: res.status() }, steps: [`open ${route}`] }],
          });
        }
        await page.waitForTimeout(SETTLE_MS);
      };

      const internal = new Set<string>();
      for (const route of screens) {
        if (out()) break;
        await confirm(() => visit(route));
        screensRun++;
        // Actions present on this screen.
        let ran = 0;
        for (const a of actions) {
          if (ran >= MAX_ACTIONS_PER_SCREEN || out()) break;
          const sel = target(a);
          const here = await page
            .locator(sel)
            .first()
            .isVisible()
            .catch(() => false);
          if (!here) continue;
          ran++;
          actionsRun++;
          await confirm(async () => {
            await visit(route);
            await page
              .locator(sel)
              .first()
              .click({ timeout: 3000 })
              .catch(() => {});
            await page.waitForTimeout((a.within ?? 3000) + 500);
          });
        }
        if (!p.mobile) {
          const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href)).catch(() => [] as string[]);
          for (const h of hrefs) {
            try {
              const u = new URL(h);
              if (u.origin === origin && !u.hash) internal.add(u.pathname);
            } catch {
              // Not a URL.
            }
          }
        }
      }

      // Links that lead nowhere (desktop pass only: one look is enough).
      for (const path of [...internal].slice(0, MAX_LINKS)) {
        if (out()) break;
        linksRun++;
        const res = await page.request.get(`${origin}${path}`, { timeout: 15_000 }).catch(() => null);
        const id = `builtin:action.link ${normalizePath(path)}`;
        if (res && res.status() < 400) passes[id] = (passes[id] ?? 0) + 1;
        else {
          const again = await page.request.get(`${origin}${path}`, { timeout: 15_000 }).catch(() => null);
          if (!again || again.status() >= 400) {
            keep.push({ contract: id, at: now().toISOString(), route: normalizePath(path), expected: { screen: normalizePath(path) }, actual: { status: again?.status() ?? "no response" }, steps: [`link to ${path}`] });
          } else flaky++;
        }
      }

      await ctx.close();
      confirmed += keep.length;
      // Built-in failures carry their own timestamps; the simulated device is named by its profile.
      batches.push({
        v: 1,
        device: {
          id: `${SIM_DEVICE_PREFIX}${p.id}`,
          platform: "web",
          browser: "Chromium",
          model: `day2 simulation: ${p.label}`,
          viewport: { w: p.viewport.width, h: p.viewport.height },
          locale: p.locale,
          theme: p.theme,
          ...(p.textScale ? { textScale: p.textScale } : {}),
          ...(p.network ? { network: p.network } : {}),
        },
        passes,
        failures: keep.map((f) => ({ ...f, evidence: { ...(f.evidence ?? {}), detail: { ...(f.evidence?.detail ?? {}), simulated: true, reproduced: true, profile: p.label } } })),
        events: [],
      });
    }
  } finally {
    if (!input.browser) await browser.close();
  }

  return {
    batches,
    run: {
      at: now().toISOString(),
      durationMs: Date.now() - startedAt,
      profiles: profiles.map((p) => p.label),
      screens: screensRun,
      actions: actionsRun,
      links: linksRun,
      failures: confirmed,
      flaky,
      skipped,
    },
  };
}
