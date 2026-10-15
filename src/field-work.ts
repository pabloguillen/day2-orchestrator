import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppEntry } from "./apps-registry";
import { fetchAppEvents } from "./app-events";
import type { IncomingItem } from "./backlog";
import { CONTRACTS_FILENAME, generateContracts, type Candidate } from "./contracts-gen";
import type { ContractHealth, FieldStore, StoredFailure } from "./field-store";
import type { EventLike } from "./metrics/types";
import type { Signal } from "./signals/types";
import { matchRoute } from "../packages/sensors/src/core";
import { BUILTIN, type Contract, type ContractFile } from "../packages/sensors/src/types";

/**
 * Field contracts in day2's loops:
 *
 *  - Self-evolution: a broken contract becomes a backlog bug that already
 *    says what was expected, what happened, the steps, the devices and
 *    where in the code — so the fix starts from a reproduction, not a guess.
 *  - Installing: day2 generates the contracts from the app's code (again
 *    whenever the code changes) and installs the library through a ticket.
 *  - Self-distribution: growth events come from the same library; ads are
 *    held while the page they lead to breaks its contracts.
 */

export const FIELD_WINDOW_DAYS = 7;
const DAY = 86_400_000;
/** A broken contract becomes a ticket at this many failures, or on this many devices (a crash: once). */
const MIN_FAILURES = 3;
const MIN_DEVICES = 2;

// ---------------------------------------------------------------------------
// Contracts from the code, regenerated when the code changes
// ---------------------------------------------------------------------------

async function headOf(repoPath: string): Promise<string | null> {
  const r = await $`git rev-parse HEAD`.cwd(repoPath).quiet().nothrow();
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

export async function refreshContracts(app: AppEntry, store: FieldStore, now = new Date()): Promise<{ changed: boolean; screens: number; actions: number; candidates: Candidate[] }> {
  const have = await store.contracts(app.id);
  const head = await headOf(app.repoPath);
  if (have && head && have.head === head) {
    return { changed: false, screens: have.file.contracts.filter((c) => c.kind === "screen").length, actions: have.file.contracts.filter((c) => c.kind === "action").length, candidates: have.candidates };
  }
  const g = generateContracts(app.repoPath, now);
  // Contracts the app declares itself (day2.contracts.json in the repo) win over generated ones with the same id.
  const declared = readDeclared(app.repoPath);
  const ids = new Set(declared.map((c) => c.id));
  const file: ContractFile = { ...g.file, contracts: [...declared, ...g.file.contracts.filter((c) => !ids.has(c.id))] };
  await store.setContracts(app.id, { head, file, candidates: g.candidates }, now);
  return { changed: true, screens: g.screens, actions: g.actions, candidates: g.candidates };
}

function readDeclared(repoPath: string): Contract[] {
  for (const p of [join(repoPath, CONTRACTS_FILENAME), join(repoPath, "src", CONTRACTS_FILENAME)]) {
    if (!existsSync(p)) continue;
    try {
      const f = JSON.parse(readFileSync(p, "utf-8")) as Partial<ContractFile>;
      return Array.isArray(f.contracts) ? f.contracts.map((c) => ({ ...c, source: c.source === "code" ? "declared" : c.source })) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Broken contracts → backlog bugs
// ---------------------------------------------------------------------------

const fmt = (v: unknown): string => {
  if (v === null || v === undefined) return "nothing";
  if (typeof v === "string") return v;
  if (typeof v !== "object") return String(v);
  return Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => `${k} ${Array.isArray(x) ? x.join(", ") : typeof x === "object" ? JSON.stringify(x) : String(x)}`)
    .join("; ");
};

const kindOf = (contract: string) => contract.split(" ")[0]!;

/** One line saying what broke, from the contract and its latest failure. */
export function describeBroken(h: ContractHealth, contract: Contract | undefined): string {
  const s = h.sample;
  const route = s?.route ?? "?";
  const actual = (s?.actual ?? {}) as Record<string, unknown>;
  const expected = (s?.expected ?? {}) as Record<string, unknown>;
  switch (kindOf(h.contract)) {
    case BUILTIN.crash:
      return `The app crashes on ${route}: ${String(s?.actual ?? "").slice(0, 120)}`;
    case BUILTIN.error:
      return `Error on ${route}: ${String(s?.actual ?? "").slice(0, 140)}`;
    case BUILTIN.freeze:
      return `${route} freezes for ${actual.ms ?? "over 2000"} ms`;
    case BUILTIN.serverError:
      return `${h.contract.slice(BUILTIN.serverError.length + 1)} fails with ${fmt(actual.status)}`;
    case BUILTIN.link:
      return `The link to ${String(expected.screen)} on ${route} doesn't open it (stays on ${String(actual.screen)})`;
    case BUILTIN.fits: {
      const vp = actual.viewport as { w?: number } | undefined;
      const wider = (actual.wider as string[] | undefined)?.join(", ");
      const clipped = (actual.clipped as string[] | undefined)?.join(", ");
      return `${route} doesn't fit a ${vp?.w ?? "small"} px wide screen${wider ? ` (${wider} too wide)` : ""}${clipped ? ` (cut off: ${clipped})` : ""}`;
    }
    case BUILTIN.placeholder:
      return `${route} shows placeholder text: ${fmt(s?.actual)}`;
    case BUILTIN.images:
      return `Images don't load on ${route}`;
    case BUILTIN.lcp:
      return `${route} takes ${actual.ms} ms to show its main content (budget ${expected.maxMs} ms)`;
    case BUILTIN.inp:
      return `Taps on ${route} take ${actual.ms} ms to respond (budget ${expected.maxMs} ms)`;
    case BUILTIN.stuckLoading:
      return `${route} keeps loading for over 10 s`;
  }
  if (contract?.kind === "action") return describeAction(contract.id, route, expected, actual);
  if (contract?.kind === "screen") return `${contract.route} isn't ready in time: ${fmt(actual.missing ?? s?.actual)} missing`;
  if (contract?.kind === "flow") return `${contract.name} stops at ${String(actual.stoppedAt)} (step ${String(actual.completed)} of ${String(actual.of)})`;
  if (contract?.kind === "speed") return `${contract.route ?? route}: ${contract.metric} ${actual.ms} ms, budget ${contract.maxMs} ms`;
  return `${h.contract} broken on ${route}: expected ${fmt(s?.expected)}, actual ${fmt(s?.actual)}`;
}

/** "Tap “cart.continue” on /cart should lead to /checkout — stayed on /cart (POST /api/cart/validate → 500)". */
export function describeAction(name: string, route: string, expected: Record<string, unknown>, actual: Record<string, unknown>): string {
  const parts: string[] = [];
  const want = typeof expected.screen === "string" ? expected.screen : null;
  const got = typeof actual.screen === "string" ? actual.screen : null;
  const head = `Tap “${name}” on ${route}`;
  const calls: string[] = [];
  const missing: string[] = [];
  for (const [k, v] of Object.entries(actual)) {
    if (k === "screen" || k === "afterMs") continue;
    if (v === "not visible") missing.push(k);
    else if (v === "not sent") calls.push(`${k} never sent`);
    else calls.push(`${k} → ${Array.isArray(v) ? v.join(", ") : String(v)}`);
  }
  if (want && got && want !== got) parts.push(`should lead to ${want} — ${got === route ? "stayed on" : "went to"} ${got}`);
  else if (want) parts.push(`should lead to ${want}`);
  else parts.push("didn't do what it should");
  if (missing.length) parts.push(`${missing.join(", ")} didn't appear`);
  return `${head} ${parts.join("; ")}${calls.length ? ` (${calls.join("; ")})` : ""}`;
}

function deviceLine(s: StoredFailure | null): string {
  if (!s) return "";
  const d = s.device;
  return [d.platform, d.os, d.browser ?? d.model, d.viewport ? `${d.viewport.w}×${d.viewport.h}` : null, d.locale, d.network, s.release ? `release ${s.release}` : null].filter(Boolean).join(", ");
}

/** The bug report: expected, actual, steps to reproduce, evidence, where in the code. */
function reportText(h: ContractHealth, contract: Contract | undefined, rate: number): string {
  const s = h.sample;
  const lines = [
    `day2's field check "${h.contract}" broke ${h.failures} time${h.failures === 1 ? "" : "s"} on ${h.devices} device${h.devices === 1 ? "" : "s"} in the last ${FIELD_WINDOW_DAYS} days (${Math.round(rate * 100)}% of checks).`,
    "",
    `Expected: ${fmt(s?.expected)}`,
    `Actual: ${fmt(s?.actual)}`,
  ];
  const calls = s?.evidence?.requests ?? [];
  if (calls.length) lines.push(`Calls during the action: ${calls.map((c) => `${c.call} → ${c.status || "no response"} (${c.ms} ms)`).join("; ")}`);
  const errs = s?.evidence?.errors ?? [];
  if (errs.length) lines.push(`Errors: ${errs.join(" | ")}`);
  if (s?.steps.length) lines.push("", "Steps to reproduce (from the user's session):", ...s.steps.map((st, i) => `${i + 1}. ${st}`));
  if (s) lines.push("", `Seen on: ${deviceLine(s)}`);
  if (contract && "origin" in contract && contract.origin) lines.push(`Where in the code: ${contract.origin}`);
  lines.push("", "Reproduce it first with a test that runs these steps in a real browser (Playwright) at the same screen size and language, then fix it. The fix is confirmed when this check passes again on users' devices.");
  return lines.join("\n");
}

export function contractSignals(appId: string, health: ContractHealth[], file: ContractFile | null, now: Date): Signal[] {
  const byId = new Map((file?.contracts ?? []).map((c) => [c.id, c]));
  const out: Signal[] = [];
  for (const h of health) {
    if (h.failures === 0) continue;
    const crash = kindOf(h.contract) === BUILTIN.crash;
    if (!crash && h.failures < MIN_FAILURES && h.devices < MIN_DEVICES) continue;
    const contract = byId.get(h.contract);
    const rate = h.failures / Math.max(1, h.failures + h.passes);
    out.push({
      id: `field:${h.contract}`,
      source: "field-contract",
      appId,
      at: h.lastFailureAt ?? now.toISOString(),
      finding: describeBroken(h, contract),
      evidence: { contract: h.contract, failures: h.failures, passes: h.passes, devices: h.devices, sample: h.sample },
      occurrences: h.failures,
      affectedUsers: h.devices,
      ...(h.sample?.route ? { path: h.sample.route } : {}),
      suggestedAction: reportText(h, contract, rate),
    });
  }
  return out;
}

export async function fieldSignals(app: AppEntry, store: FieldStore, now = new Date()): Promise<Signal[]> {
  const [health, contracts] = await Promise.all([store.health(app.id, new Date(now.getTime() - FIELD_WINDOW_DAYS * DAY)), store.contracts(app.id)]);
  return contractSignals(app.id, health, contracts?.file ?? null, now);
}

// ---------------------------------------------------------------------------
// Installing the library
// ---------------------------------------------------------------------------

export const INSTALL_KEY = "field:install";
export const VENDOR_DIR = "day2";

export type AppKind = "web" | "react-native" | "flutter" | "native" | "unknown";

export function appKind(repoPath: string): AppKind {
  if (existsSync(join(repoPath, "pubspec.yaml"))) return "flutter";
  const pkgPath = join(repoPath, "package.json");
  if (!existsSync(pkgPath)) {
    if (existsSync(join(repoPath, "index.html")) || existsSync(join(repoPath, "public", "index.html"))) return "web";
    return existsSync(join(repoPath, "Package.swift")) || existsSync(join(repoPath, "build.gradle")) ? "native" : "unknown";
  }
  const pkg = readFileSync(pkgPath, "utf-8");
  if (/"(react-native|expo)"/.test(pkg)) return "react-native";
  return "web";
}

export function installItem(app: AppEntry, opts: { key: string; endpoint: string; candidates: Candidate[] }): IncomingItem | null {
  if (appKind(app.repoPath) !== "web") return null;
  const dir = existsSync(join(app.repoPath, "src")) ? `src/${VENDOR_DIR}` : VENDOR_DIR;
  const tag = opts.candidates.slice(0, 40);
  return {
    source: { kind: "day2_proposal", key: INSTALL_KEY },
    title: "Install day2 field checks",
    type: "task",
    description: [
      "Let day2 check on users' devices that the app does what it should, and report \"expected X, actual Y\" when it doesn't — the base for fixing UI bugs on its own and measuring growth.",
      "",
      `day2 has placed the library in ${dir}/sensors.js (with ${dir}/sensors.d.ts). Wire it in:`,
      `1. At the app's entry point (before rendering), call it once:`,
      "```",
      `import { startDay2 } from "./${VENDOR_DIR}/sensors.js";`,
      `export const day2 = startDay2({ key: "${opts.key}", endpoint: "${opts.endpoint}", release: /* the app's version or commit if available */ undefined });`,
      "```",
      `   Adjust the import path to where the entry file is. The key is send-only and safe to have in the app's code.`,
      `2. Mark loading indicators with aria-busy="true" (or data-day2-loading) and input error messages with role="alert" (or data-day2-error), where they aren't already.`,
      `3. Where the app records sign-ups and first value, call day2.track("signup") and day2.track("activated"); for sharing and invites, day2.track("shared") / day2.track("invite_sent").`,
      ...(tag.length
        ? [
            `4. Add data-day2-action to these elements so their checks can run (name as given):`,
            ...tag.map((c) => `   - ${c.origin} "${c.label}" → data-day2-action="${c.name}"`),
          ]
        : []),
      `${tag.length ? 5 : 4}. Add a test (for example ${dir}/day2.test.ts) showing the app starts day2 exactly once, with this key and endpoint.`,
      "",
      "Don't change any behaviour; this only adds the checks.",
    ].join("\n"),
    doneWhen: [
      "startDay2 is called once at startup with the key and endpoint above",
      "Loading indicators carry aria-busy or data-day2-loading; error messages role=alert or data-day2-error",
      "Sign-up and first value call day2.track",
      ...(tag.length ? ["The listed elements carry their data-day2-action names"] : []),
      "A test shows day2 is started exactly once with the key and endpoint",
      "The app builds and its tests pass",
    ],
  };
}

let bundleCache: string | null = null;

/** The library as one browser-ready file (built once per process). */
export async function sensorsBundle(): Promise<string> {
  if (bundleCache) return bundleCache;
  const out = await Bun.build({ entrypoints: [join(import.meta.dir, "../packages/sensors/src/index.ts")], target: "browser", format: "esm", minify: true });
  if (!out.success) throw new Error(`Couldn't build the day2 field library: ${out.logs.map((l) => l.message).join("; ")}`);
  bundleCache = `/* day2 field checks (@day2/sensors) — installed by day2; updates come from day2. */\n${await out.outputs[0]!.text()}`;
  return bundleCache;
}

const TYPES = `export type Day2 = { track(type: string): void; check(id: string, ok: boolean, detail?: Record<string, number | boolean>): void; setIdentity(identity: "session" | "device"): void; flush(): void; stop(): void };
export type StartOptions = { key: string; endpoint: string; release?: string; contracts?: unknown; fetchContracts?: boolean; identity?: "session" | "device"; layoutSampleRate?: number; enabled?: boolean };
export declare function startDay2(opts: StartOptions): Day2;
`;

/** Puts the library files into a working copy (the install ticket's clone). */
export async function placeLibrary(workdir: string): Promise<string> {
  const dir = existsSync(join(workdir, "src")) ? join(workdir, "src", VENDOR_DIR) : join(workdir, VENDOR_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sensors.js"), await sensorsBundle());
  writeFileSync(join(dir, "sensors.d.ts"), TYPES);
  return dir;
}

// ---------------------------------------------------------------------------
// Growth: events from the field, and pages healthy enough for ads
// ---------------------------------------------------------------------------

/** Usage events: from the field library when the app has it, else the app's own endpoint. */
export async function appEvents(app: AppEntry, sinceIso: string, store: FieldStore): Promise<EventLike[] | null> {
  const field = await store.events(app.id, new Date(sinceIso));
  if (field.length) return field;
  return fetchAppEvents(app.appBaseUrl, sinceIso);
}

/**
 * Whether a page is fit to send paid traffic to: no broken contract on
 * that route in the last day (its screen, actions on it, crashes, errors,
 * layout, speed). Unknown (no reports yet) counts as fine.
 */
export async function pageHealth(app: AppEntry, path: string, store: FieldStore, now = new Date()): Promise<{ ok: boolean; reason: string }> {
  const health = await store.health(app.id, new Date(now.getTime() - DAY));
  const broken = health.filter((h) => h.failures >= 2 && h.sample && matchRoute(path, h.sample.route));
  if (!broken.length) return { ok: true, reason: "" };
  const contracts = (await store.contracts(app.id))?.file;
  const byId = new Map((contracts?.contracts ?? []).map((c) => [c.id, c]));
  return { ok: false, reason: describeBroken(broken[0]!, byId.get(broken[0]!.contract)) };
}
