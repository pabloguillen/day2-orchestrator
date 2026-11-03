import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import type { Backlog, NewTicketInput, Ticket } from "../backlog";
import { appKind } from "../field-work";

/**
 * Native foundations: the native packages modules need (expo-iap,
 * react-native-google-mobile-ads, expo-notifications, expo-store-review…)
 * go into the app together, in one ticket, so they reach users in a single
 * store release. After that, everything changes over the air.
 *
 * Each module registers what it needs (`registerNativeNeed`, one call at
 * import time); Live's pass gathers the needs of the modules that are on
 * and opens the one ticket when anything is missing from the app.
 */

export type NativeNeed = {
  module: string;
  packages: string[];
  /** Expo config plugins to add to app.json / app.config (e.g. ["expo-notifications", { … }]). */
  plugins?: unknown[];
  /** What the build agent does with them, in plain words (wiring, permissions, keys). */
  instructions: string;
  whenNeeded(app: AppEntry): Promise<boolean>;
};

const needs: NativeNeed[] = [];

export function registerNativeNeed(need: NativeNeed): void {
  const i = needs.findIndex((n) => n.module === need.module);
  if (i >= 0) needs[i] = need;
  else needs.push(need);
}

export const registeredNeeds = (): NativeNeed[] => [...needs];

/** For tests: forget everything but Live's own needs. */
export function resetNativeNeeds(): void {
  needs.length = 0;
  registerNativeNeed(LIVE_NEED);
}

/** The packages listed in the app's package.json. */
export function installedPackages(repoPath: string): Set<string> {
  const p = join(repoPath, "package.json");
  if (!existsSync(p)) return new Set();
  try {
    const pkg = JSON.parse(readFileSync(p, "utf-8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  } catch {
    return new Set();
  }
}

export type MissingNative = { module: string; packages: string[]; plugins: unknown[]; instructions: string };

/** What the switched-on modules need that the app doesn't have yet. */
export async function missingNative(app: AppEntry, list: NativeNeed[] = needs): Promise<MissingNative[]> {
  if (appKind(app.repoPath) !== "react-native") return [];
  const have = installedPackages(app.repoPath);
  const out: MissingNative[] = [];
  for (const n of list) {
    let on = false;
    try {
      on = await n.whenNeeded(app);
    } catch {
      on = false;
    }
    if (!on) continue;
    const packages = n.packages.filter((p) => !have.has(p));
    if (packages.length) out.push({ module: n.module, packages, plugins: n.plugins ?? [], instructions: n.instructions });
  }
  return out;
}

export const NATIVE_KEY_PREFIX = "live:native:";

export function nativeTicket(app: AppEntry, missing: MissingNative[]): NewTicketInput & { source: { kind: "day2_proposal"; key: string } } {
  const packages = [...new Set(missing.flatMap((m) => m.packages))].sort();
  const key = `${NATIVE_KEY_PREFIX}${createHash("sha256").update(packages.join(",")).digest("hex").slice(0, 10)}`;
  const plugins = missing.flatMap((m) => m.plugins);
  return {
    title: `Native foundations for ${missing.map((m) => m.module).join(", ")}`.slice(0, 160),
    type: "task",
    source: { kind: "day2_proposal", key },
    description: [
      `${app.name} needs a few native packages so day2 can change settings, run experiments${missing.some((m) => m.module !== "live") ? " and the new features" : ""} over the air from now on. They go in together, so they reach users in one App Store / Google Play release; everything after that ships as over-the-air updates.`,
      "",
      `Install with \`npx expo install ${packages.join(" ")}\` (Expo picks the versions that fit the app's SDK).`,
      ...(plugins.length ? ["", "Add these config plugins to app.json / app.config:", "```json", JSON.stringify(plugins, null, 2), "```"] : []),
      "",
      ...missing.map((m) => `**${m.module}:** ${m.instructions}`),
      "",
      "Don't change any behaviour beyond this; each feature is built in its own ticket.",
    ].join("\n"),
    doneWhen: [`${packages.join(", ")} are in package.json`, ...(plugins.length ? ["The config plugins are in the app config"] : []), "The app builds for iOS and Android and its tests pass"],
  };
}

/** An open native-foundations ticket (not done or parked), if any. */
export const openNativeTicket = (b: Backlog): Ticket | undefined => b.tickets.find((t) => t.source.key?.startsWith(NATIVE_KEY_PREFIX) && t.state !== "done" && t.state !== "parked");

/** Live's own needs. */
export const LIVE_NEED: NativeNeed = {
  module: "live",
  packages: ["expo-updates", "@react-native-async-storage/async-storage", "expo-application"],
  instructions: [
    "Pass AsyncStorage to startDay2 as `storage` (Live keeps its settings and counters there, so they work offline and settings never change during a session).",
    "Use expo-application and expo-updates for the release tag: `release: releaseTag(Application.nativeApplicationVersion, Application.nativeBuildVersion, Updates.isEmbeddedLaunch ? null : Updates.updateId)`.",
    'Only set `identity: "device"` after the user agreed where the law requires it; otherwise experiments use the signed-in user (day2.identify).',
  ].join(" "),
  whenNeeded: async (app) => appKind(app.repoPath) === "react-native",
};

registerNativeNeed(LIVE_NEED);
