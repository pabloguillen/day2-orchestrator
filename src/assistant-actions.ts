import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppEntry } from "./apps-registry";
import { BACKLOG_FILENAME, createTicket, rankBacklog, withBacklog, type NewTicketInput } from "./backlog";
import type { ContractHealth, FieldStore } from "./field-store";
import { appKind } from "./field-work";
import { registerNativeNeed } from "./live/native-foundations";
import type { ContractFile } from "../packages/sensors/src/types";

/**
 * Assistant actions: an app's 1–3 most-used actions in Siri / Shortcuts
 * (App Intents + App Shortcuts, iOS 16+) and as Android app shortcuts
 * (long-press on the icon, static shortcuts), each one opening the app at a
 * deep link (<scheme>://<route>) — so the code behind them is the app's
 * own screens; only a thin native layer is new.
 *
 * day2 proposes it as a normal build ticket in the backlog (a feature: the
 * owner approves the plan first, like any feature); the build agent writes
 * an Expo config plugin. It's a native change, so it reaches users with the
 * next store release (native foundations), never as an over-the-air update.
 *
 * Proposed for Expo apps with deep links (a `scheme` in the app config):
 * after Create (from the plan's main actions) and by the growth autopilot
 * (from field usage, else the app's routes).
 */

export const ASSISTANT_KEY = "assistant-actions:v1";
export const PLUGIN_PATH = "./plugins/with-assistant-actions";

export type AssistantAction = { id: string; title: string; route: string; phrase: string; uses?: number };
export type DeepLinkApp = { name: string; scheme: string; bundleId: string | null; androidPackage: string | null };

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32) || "action";

const humanize = (route: string) => {
  const last = route.split("/").filter(Boolean).pop() ?? "home";
  const words = last.replace(/[-_]+/g, " ").trim();
  return words ? `Open ${words[0]!.toUpperCase()}${words.slice(1)}` : "Open the app";
};

/** Routes that make no sense as an assistant action. */
const NOT_ACTIONS = /^\/(?:$|index$|settings|privacy|about|login|sign-?in|sign-?up|auth|onboarding|welcome|modal|\+not-found|_sitemap)/i;
const DYNAMIC = /\[|:/;

function toAction(title: string, route: string, phrase?: string, uses?: number): AssistantAction {
  return { id: slug(title), title: title.slice(0, 40), route, phrase: (phrase ?? title).slice(0, 60), ...(uses !== undefined ? { uses } : {}) };
}

/** Pure. From the Create plan's main actions. */
export function actionsFromPlan(plan: { actions: Array<{ title: string; route: string; phrase?: string }> }): AssistantAction[] {
  return plan.actions.filter((a) => !DYNAMIC.test(a.route)).slice(0, 3).map((a) => toAction(a.title, a.route, a.phrase));
}

/**
 * Pure. The most-used destinations from field data: screen views (screen
 * contracts' checks) and taps that lead to a screen (action contracts that
 * expect one), over routes that exist in the code.
 */
export function actionsFromUsage(health: ContractHealth[], file: ContractFile | null, codeRoutes: string[]): AssistantAction[] {
  const byId = new Map((file?.contracts ?? []).map((c) => [c.id, c]));
  const uses = new Map<string, number>();
  for (const h of health) {
    const c = byId.get(h.contract);
    let route: string | null = null;
    if (c?.kind === "screen") route = c.route;
    else if (c?.kind === "action") route = (c.expect.find((e) => "screen" in e) as { screen: string } | undefined)?.screen ?? null;
    if (!route) continue;
    uses.set(route, (uses.get(route) ?? 0) + h.passes + h.failures);
  }
  const known = new Set(codeRoutes);
  return [...uses.entries()]
    .filter(([r, n]) => n > 0 && !NOT_ACTIONS.test(r) && !DYNAMIC.test(r) && (known.size === 0 || known.has(r)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([r, n]) => toAction(humanize(r), r, undefined, n));
}

/** Expo Router routes from the app/ (or src/app/) folder: "/", "/log", "/habit/[id]" … */
export function routesFromCode(repoPath: string): string[] {
  const root = [join(repoPath, "app"), join(repoPath, "src", "app")].find((d) => existsSync(d));
  if (!root) return [];
  const out = new Set<string>();
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 6) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        // (group) folders don't appear in the URL.
        walk(join(dir, e.name), /^\(.*\)$/.test(e.name) ? prefix : `${prefix}/${e.name}`, depth + 1);
      } else if (/\.(tsx|ts|jsx|js)$/.test(e.name) && !/^_layout\.|^\+|\.test\.|\.d\.ts$/.test(e.name)) {
        const base = e.name.replace(/\.(tsx|ts|jsx|js)$/, "");
        out.add(base === "index" ? prefix || "/" : `${prefix}/${base}`);
      }
    }
  };
  walk(root, "", 0);
  return [...out].sort();
}

/** Pure. Actions from the code alone (no field data yet): the first few plain routes. */
export function actionsFromCode(routes: string[]): AssistantAction[] {
  return routes.filter((r) => !NOT_ACTIONS.test(r) && !DYNAMIC.test(r)).slice(0, 3).map((r) => toAction(humanize(r), r));
}

/** The app's deep link scheme and ids from app.json, when it's an Expo app with deep links. */
export function deepLinkApp(repoPath: string): DeepLinkApp | null {
  if (appKind(repoPath) !== "react-native") return null;
  let expo: Record<string, unknown> = {};
  try {
    const j = JSON.parse(readFileSync(join(repoPath, "app.json"), "utf-8")) as Record<string, unknown>;
    expo = ((j.expo as Record<string, unknown>) ?? j) as Record<string, unknown>;
  } catch {
    // app.config.ts: read the scheme with a plain search (no evaluation of the app's code).
    for (const f of ["app.config.ts", "app.config.js"]) {
      const p = join(repoPath, f);
      if (!existsSync(p)) continue;
      const t = readFileSync(p, "utf-8");
      const scheme = t.match(/scheme:\s*["'`]([a-z][a-z0-9+.-]*)["'`]/i)?.[1];
      if (scheme) return { name: t.match(/\bname:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? scheme, scheme, bundleId: t.match(/bundleIdentifier:\s*["'`]([^"'`]+)/)?.[1] ?? null, androidPackage: t.match(/\bpackage:\s*["'`]([^"'`]+)/)?.[1] ?? null };
    }
    return null;
  }
  const scheme = Array.isArray(expo.scheme) ? expo.scheme[0] : expo.scheme;
  if (typeof scheme !== "string" || !scheme) return null;
  return {
    name: typeof expo.name === "string" ? expo.name : scheme,
    scheme,
    bundleId: ((expo.ios as Record<string, unknown> | undefined)?.bundleIdentifier as string | undefined) ?? null,
    androidPackage: ((expo.android as Record<string, unknown> | undefined)?.package as string | undefined) ?? null,
  };
}

/** Pure. The build ticket, with exact instructions for the build agent. */
export function assistantActionsTicket(app: DeepLinkApp, actions: AssistantAction[], why: "create" | "usage" | "code"): NewTicketInput {
  const link = (a: AssistantAction) => `${app.scheme}://${a.route.replace(/^\//, "")}`;
  const list = actions.map((a, i) => `${i + 1}. “${a.title}” → ${link(a)} (Siri phrase: “${a.phrase} in ${app.name}”${a.uses ? `; used ${a.uses}× in the last weeks` : ""})`);
  return {
    title: `Siri, Shortcuts and Android shortcuts for ${actions.length === 1 ? "the main action" : `the ${actions.length} main actions`}`,
    type: "feature",
    description: [
      `Let people start ${app.name}'s most-used ${actions.length === 1 ? "action" : "actions"} from Siri, the Shortcuts app and Spotlight on iPhone, and from a long press on the app icon on Android. Each one opens the app at its deep link, so the screens behind them stay the app's own.`,
      "",
      why === "create" ? "From the product plan's main actions:" : why === "usage" ? "The most-used actions, from day2's field data:" : "From the app's screens (no usage data yet):",
      ...list,
      "",
      "How (an Expo config plugin — no ios/ or android/ folders in the repo):",
      `1. Deep links first: each link above must open its screen with Expo Router (cold start and while running). Add a Maestro flow per action (e.g. .maestro/assistant-<id>.yaml: launchApp, openLink: <link>, assertVisible: <something on that screen>).`,
      `2. Write ${PLUGIN_PATH}.js (plain JS, CommonJS, using @expo/config-plugins — already a dependency of expo) and add "${PLUGIN_PATH}" to "plugins" in the app config. Keep the generated texts in pure functions (swiftSource(actions), shortcutsXml(actions)) exported for tests.`,
      "3. iOS (App Intents, iOS 16+), in the plugin:",
      "   - withDangerousMod(\"ios\") writes ios/<ProjectName>/AssistantActions.swift; withXcodeProject adds it to the main app target's sources (App Shortcuts must live in the app bundle).",
      "   - Per action: `@available(iOS 16.0, *) struct <Id>Intent: AppIntent { static var title: LocalizedStringResource = \"<title>\"; static var openAppWhenRun = true; @MainActor func perform() async throws -> some IntentResult { if let url = URL(string: \"<link>\") { await UIApplication.shared.open(url) }; return .result() } }`.",
      "   - One `@available(iOS 16.0, *) struct <App>Shortcuts: AppShortcutsProvider { static var appShortcuts: [AppShortcut] { AppShortcut(intent: <Id>Intent(), phrases: [\"<phrase> in \\(.applicationName)\", \"\\(.applicationName) <phrase>\"]) … } }` — every phrase must contain \\(.applicationName). At most 10 shortcuts.",
      "   - Make sure the app's deployment target allows it: guard everything with @available(iOS 16.0, *); don't raise the deployment target.",
      "4. Android (static app shortcuts), in the plugin:",
      `   - withDangerousMod("android") writes android/app/src/main/res/xml/shortcuts.xml: one <shortcut android:shortcutId="<id>" android:enabled="true" android:icon="@mipmap/ic_launcher" android:shortcutShortLabel="@string/shortcut_<id>_short" android:shortcutLongLabel="@string/shortcut_<id>_long"> with <intent android:action="android.intent.action.VIEW" android:data="<link>" android:targetPackage="${app.androidPackage ?? "<android.package>"}" android:targetClass="${app.androidPackage ?? "<android.package>"}.MainActivity" /> per action (at most 4).`,
      "   - withStringsXml adds the labels (short ≤ 10 characters, long ≤ 25).",
      "   - withAndroidManifest adds <meta-data android:name=\"android.app.shortcuts\" android:resource=\"@xml/shortcuts\" /> to the MAIN/LAUNCHER activity. Expo's scheme already adds the VIEW intent filter.",
      "5. Tests: unit tests for swiftSource and shortcutsXml (ids, links, phrases with \\(.applicationName), labels), and that the plugin is listed in the app config.",
      "6. Check it builds natively: `npx expo prebuild --clean --no-install` in a scratch copy, then confirm ios/*/AssistantActions.swift is in project.pbxproj and android/app/src/main/res/xml/shortcuts.xml plus the manifest meta-data exist. Don't commit ios/ or android/.",
      "",
      "This is a native change: it goes out with the next store release (day2's native foundations release), not as an over-the-air update — the fingerprint runtime policy marks it as native by itself.",
      "Verified: by the unit tests and prebuild check above, the Maestro deep link flows on virtual devices, and after the store release by saying “Hey Siri, <phrase> in <app>” on an iPhone and long-pressing the icon on Android.",
    ].join("\n"),
    doneWhen: [
      "Each listed deep link opens its screen (Maestro flows)",
      `${PLUGIN_PATH}.js is in the app config's plugins and generates AssistantActions.swift (App Intents + App Shortcuts, iOS 16+) in the main target`,
      "The plugin generates Android static shortcuts (shortcuts.xml, labels, manifest meta-data)",
      "Unit tests for the generated Swift and XML pass; expo prebuild succeeds",
      "Nothing in ios/ or android/ is committed",
    ],
    priority: 3,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: ASSISTANT_KEY },
    actor: "day2",
    createdNote: why === "create" ? "Proposed by day2 when the app was created." : "Proposed by day2's growth check: the app's main actions, one sentence away.",
  };
}

// Registered with Live's native foundations so the native change is known; it has no packages
// of its own (its ticket writes the plugin), so it never opens a native foundations ticket by itself.
registerNativeNeed({
  module: "assistant-actions",
  packages: [],
  plugins: [PLUGIN_PATH],
  instructions: `The assistant actions config plugin (${PLUGIN_PATH}) — App Intents / App Shortcuts on iOS and static app shortcuts on Android. Its code is in the repo already; this release only has to include it.`,
  async whenNeeded(app: AppEntry) {
    try {
      return readFileSync(join(app.repoPath, "app.json"), "utf-8").includes(PLUGIN_PATH);
    } catch {
      return false;
    }
  },
});

export const ASSISTANT_WINDOW_DAYS = 28;

/**
 * The growth autopilot's check: proposes the ticket once for an Expo app with
 * deep links that doesn't have it (by source key, so a deleted or finished
 * ticket isn't proposed again). Returns the ticket id when it made one.
 */
export async function assistantActionsPass(app: AppEntry, o: { field?: FieldStore; now?: Date } = {}): Promise<string | null> {
  const info = deepLinkApp(app.repoPath);
  if (!info) return null;
  const file = resolve(app.repoPath, BACKLOG_FILENAME);
  const now = o.now ?? new Date();
  const seen = await withBacklog(file, (b) => ({ backlog: b, result: b.tickets.some((t) => t.source.key === ASSISTANT_KEY) || (b.forgotten ?? []).includes(`day2_proposal:${ASSISTANT_KEY}`) }));
  if (seen) return null;
  if (readFileSync(join(app.repoPath, "app.json"), "utf-8").includes(PLUGIN_PATH)) return null;
  const routes = routesFromCode(app.repoPath);
  let actions: AssistantAction[] = [];
  let why: "usage" | "code" = "code";
  if (o.field) {
    const [health, contracts] = await Promise.all([o.field.health(app.id, new Date(now.getTime() - ASSISTANT_WINDOW_DAYS * 86_400_000)), o.field.contracts(app.id)]);
    actions = actionsFromUsage(health, contracts?.file ?? null, routes);
    if (actions.length) why = "usage";
  }
  if (!actions.length) actions = actionsFromCode(routes);
  if (!actions.length) return null;
  return withBacklog(file, (b) => {
    const r = createTicket(b, assistantActionsTicket(info, actions, why), now);
    return { backlog: rankBacklog(r.backlog, now).backlog, result: r.ticket.id };
  });
}
