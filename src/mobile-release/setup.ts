import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NewTicketInput } from "../backlog";

/** Reads a file of the app at the commit that matters (main), or null when it isn't there. */
export type ReadFile = (path: string) => string | null;
export const workingCopy = (repoPath: string): ReadFile => (p) => (existsSync(join(repoPath, p)) ? readFileSync(join(repoPath, p), "utf-8") : null);

/**
 * What has to be in place, once, before day2 can release a React Native /
 * Expo app by itself — split into what day2 does in the code (one ticket)
 * and what only the owner can do (connect accounts).
 */

export const SETUP_KEY = "release:setup";

export type Readiness = {
  /** Code-side gaps day2 fixes with a ticket. */
  code: string[];
  /** The app's EAS project id, when the app has one. */
  projectId: string | null;
  /** The release tag the app reports (field data), when it does. */
  reportsRelease: boolean;
};

/** Reads the app's config files (on main). lastRelease = what the field library last reported. */
export function readiness(source: string | ReadFile, lastRelease: string | null): Readiness {
  const read = typeof source === "string" ? workingCopy(source) : source;
  const readJson = (p: string): Record<string, unknown> | null => {
    try {
      const t = read(p);
      return t === null ? null : (JSON.parse(t) as Record<string, unknown>);
    } catch {
      return null;
    }
  };
  const code: string[] = [];
  const pkg = readJson("package.json") ?? {};
  const deps = { ...((pkg.dependencies as Record<string, string>) ?? {}), ...((pkg.devDependencies as Record<string, string>) ?? {}) };
  const appJson = readJson("app.json");
  const expo = ((appJson?.expo as Record<string, unknown>) ?? appJson ?? {}) as Record<string, unknown>;
  const dynamicConfig = read("app.config.ts") !== null || read("app.config.js") !== null;
  const eas = readJson("eas.json");
  const projectId = ((expo.extra as Record<string, unknown> | undefined)?.eas as { projectId?: string } | undefined)?.projectId ?? null;

  if (!deps["expo-updates"]) code.push("expo-updates isn't installed (over-the-air updates)");
  if (!deps["expo-application"]) code.push("expo-application isn't installed (the release tag)");
  if (!dynamicConfig) {
    const rv = expo.runtimeVersion as { policy?: string } | string | undefined;
    if (!rv || typeof rv === "string" || rv.policy !== "fingerprint") code.push('runtimeVersion isn\'t { "policy": "fingerprint" } (so day2 can tell which changes are safe as updates)');
    if (!(expo.updates as { url?: string } | undefined)?.url) code.push("updates.url isn't set to the EAS Update URL");
  }
  if (!eas) code.push("there's no eas.json");
  else {
    const cli = (eas.cli as Record<string, unknown>) ?? {};
    const prod = ((eas.build as Record<string, Record<string, unknown>>) ?? {}).production;
    const submit = ((eas.submit as Record<string, Record<string, unknown>>) ?? {}).production;
    if (cli.appVersionSource !== "remote") code.push('eas.json cli.appVersionSource isn\'t "remote" (EAS counts build numbers)');
    if (!prod) code.push("eas.json has no production build profile");
    else {
      if (prod.autoIncrement !== true) code.push("the production build profile doesn't auto-increment build numbers");
      if (prod.channel !== "production") code.push('the production build profile isn\'t on the "production" update channel');
    }
    const android = (submit?.android as Record<string, unknown> | undefined) ?? null;
    if (!submit) code.push("eas.json has no production submit profile");
    else if (android && android.track !== undefined && android.track !== "internal") code.push('the production submit profile sends Android builds straight to a track other than "internal" (day2 promotes them itself)');
  }
  const reportsRelease = Boolean(lastRelease && /^\d[\w.]*\(\w+\)(@[0-9a-f]{8})?$/.test(lastRelease));
  // Not blocking: the release tag arrives with the next store build (it needs expo-application /
  // expo-updates). Until then releases go on, judged more slowly (quiet-app rule).
  return { code, projectId, reportsRelease };
}

export function setupTicket(r: Readiness): NewTicketInput {
  return {
    title: "Set the app up for releases by day2 (EAS Update, Build, Submit)",
    type: "task",
    description: [
      "The owner turned on releases by day2: JavaScript-only changes go out as over-the-air updates in stages (10% → 50% → 100%), native changes as store builds — each rolled back when day2's field checks see more crashes. For that, the app needs:",
      "",
      ...r.code.map((c) => `- Fix: ${c}`),
      "",
      "How:",
      "1. npx expo install expo-updates expo-application",
      `2. In the app config: "runtimeVersion": { "policy": "fingerprint" } and "updates": { "url": "https://u.expo.dev/${r.projectId ?? "<EAS project id>"}" }${r.projectId ? "" : " (the project id is in extra.eas.projectId after `eas init`; if there's none, leave a note in the PR — the owner runs `eas init` once)"}.`,
      '3. eas.json: "cli": { "appVersionSource": "remote" }; build.production: { "autoIncrement": true, "channel": "production" }; submit.production: { "android": { "track": "internal" }, "ios": { "ascAppId": "<the app\'s Apple ID, from App Store Connect → App Information>" } } — keep anything already there that doesn\'t conflict.',
      "4. Where day2 is started (startDay2), report the release: release: releaseTag(Application.nativeApplicationVersion, Application.nativeBuildVersion, Updates.isEmbeddedLaunch ? null : Updates.updateId) — releaseTag comes from day2's native.js; import * as Application from \"expo-application\" and * as Updates from \"expo-updates\".",
      "5. Don't change app behaviour. The app builds and its tests pass.",
      "",
      "Note: changing runtimeVersion and adding expo-updates are native changes — the next store release includes them, and from then on JavaScript-only fixes go out as updates.",
    ].join("\n"),
    doneWhen: [
      "expo-updates and expo-application are installed",
      'runtimeVersion uses the "fingerprint" policy and updates.url points at EAS Update',
      "eas.json: remote app versions, auto-increment, production channel, internal track",
      "startDay2 reports the release with releaseTag",
      "The app builds and its tests pass",
    ],
    priority: 2,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: SETUP_KEY },
    actor: "day2",
    createdNote: "The owner turned on releases by day2.",
  };
}
