import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { scrub, tidy, unsafeReason } from "../memory/privacy";

/**
 * Learning from build failures across apps: each failed build or check is
 * reduced to a signature (framework version, package, error type), and when
 * a later run on the same work gets through, the fix that worked becomes a
 * short, generalized playbook entry. Approved entries (the operator reviews
 * every one) go into the build agent's notes for apps on a matching stack.
 * Never app code: file paths, code, quotes and the app's name are stripped.
 */

export type Stack = { framework: string; packages: string[] };

export type Signature = { framework: string; pkg: string | null; errorType: string; key: string };

export type PlaybookEntry = {
  id: string;
  key: string;
  framework: string;
  pkg: string | null;
  errorType: string;
  /** The generalized fix, one or two sentences. */
  fix: string;
  status: "candidate" | "approved" | "retired";
  /** Distinct apps that hit it / where the fix worked, as "<account hash>.<app hash>" (salted) — counts only are shown. */
  apps: string[];
  fixedIn: string[];
  seen: number;
  createdAt: string;
  updatedAt: string;
};

/** A failure waiting for its fix (per app and ticket, salted). */
export type OpenFailure = { ref: string; app: string; account: string; key: string; framework: string; pkg: string | null; errorType: string; at: string };

/** Whether the app is Expo / React Native and which version, plus its public npm packages. */
export function stackOf(repoPath: string): Stack {
  try {
    const p = join(repoPath, "package.json");
    if (!existsSync(p)) return { framework: "unknown", packages: [] };
    const pkg = JSON.parse(readFileSync(p, "utf-8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
    const major = (v?: string) => v?.match(/(\d+)\.(\d+)?/);
    let framework = "node";
    if (deps.expo) framework = `expo${major(deps.expo)?.[1] ?? ""}`;
    else if (deps["react-native"]) framework = `rn0.${major(deps["react-native"])?.[2] ?? ""}`;
    else if (deps.next) framework = `next${major(deps.next)?.[1] ?? ""}`;
    else if (deps.vite) framework = `vite${major(deps.vite)?.[1] ?? ""}`;
    // Public package names only (no scoped private ones, no file: or git: deps).
    const packages = Object.entries(deps)
      .filter(([name, v]) => /^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/.test(name) && !/^(file|link|git|github|workspace):/.test(v))
      .map(([name]) => name);
    return { framework, packages };
  } catch {
    return { framework: "unknown", packages: [] };
  }
}

const ERROR_TYPES: Array<[string, RegExp]> = [
  ["peer_dependency", /ERESOLVE|peer dep|conflicting peer/i],
  ["module_not_found", /unable to resolve module|cannot find module|module not found|could not resolve/i],
  ["type_error_ts", /\bTS\d{4}\b|type ?check|tsc\b/i],
  ["native_build_ios", /pod install|xcodebuild|cocoapods|\.xcworkspace/i],
  ["native_build_android", /gradle|android build|aapt|D8|R8/i],
  ["expo_config", /app\.json|app\.config|expo-doctor|config plugin/i],
  ["metro_bundle", /metro|bundl(e|ing) failed|transform error/i],
  ["invariant", /invariant violation/i],
  ["test_failed", /tests? failed|expect\(|assertion/i],
  ["lint", /eslint|lint error/i],
  ["device_check", /on a virtual device|maestro/i],
  ["runtime_type_error", /TypeError|undefined is not|null is not/i],
  ["no_changes", /made no changes/i],
];

/** Pure. The failure's signature: framework version, the package it names (if it's in the app's deps), error type. */
export function errorSignature(reason: string, stack: Stack): Signature {
  const errorType = ERROR_TYPES.find(([, re]) => re.test(reason))?.[0] ?? "other";
  const named = [...reason.matchAll(/['"`]?((?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*)['"`]?/gi)].map((m) => m[1]!.toLowerCase());
  const pkg = named.find((n) => stack.packages.includes(n) && n !== "react" && n.length > 2) ?? null;
  return { framework: stack.framework, pkg, errorType, key: `${stack.framework}|${pkg ?? "-"}|${errorType}` };
}

/** Pure. The "What changed" of an agent's summary, generalized: no code, paths, quotes, names. */
export function generalizeFix(summary: string, appName: string): string | null {
  const section = summary.match(/## What changed\s*\n([\s\S]*?)(\n## |$)/i)?.[1] ?? summary;
  let t = section
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]{1,60})`/g, (_m, inner: string) => (/^(@[a-z0-9-]+\/)?[a-z0-9-]+(\/[a-z0-9-]+)?(@[\d.x^~]+)?$/i.test(inner) ? inner : " "))
    .replace(/(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.\w+/g, " ")
    .replace(/\b[\w.-]+\.(tsx?|jsx?|json|kt|swift|java|gradle|plist)\b/g, " ")
    .replace(/["“”„][^"“”„]*["“”„]/g, " ");
  for (const w of appName.split(/[^A-Za-z0-9]+/).filter((x) => x.length >= 3)) t = t.replace(new RegExp(`\\b${w}\\b`, "gi"), "the app");
  t = tidy(scrub(t), 240);
  if (t.length < 15 || unsafeReason(t)) return null;
  return t;
}

/** Pure. Records a failure (one open failure per app and ticket). */
export function noteFailure(open: OpenFailure[], f: OpenFailure): OpenFailure[] {
  return [f, ...open.filter((x) => x.ref !== f.ref)].slice(0, 2000);
}

/** How an app is kept on a playbook entry: its account and app hashes, so an opt-out can remove both. */
export const memberOf = (f: Pick<OpenFailure, "app" | "account">) => `${f.account}.${f.app}`;

/**
 * Pure. Takes accounts (and/or apps) out of the playbook: their open
 * failures go, their hashes are stripped from entries, and entries left
 * with no app are dropped — unless an operator approved them (then only
 * the hashes go).
 */
export function forgetInPlaybook(s: { entries: PlaybookEntry[]; open: OpenFailure[] }, who: { accounts?: string[]; apps?: string[] }): { entries: PlaybookEntry[]; open: OpenFailure[] } {
  const accounts = new Set(who.accounts ?? []);
  const apps = new Set(who.apps ?? []);
  const gone = (m: string) => {
    const [acc, app] = m.split(".");
    return accounts.has(acc ?? "") || apps.has(app ?? "");
  };
  const open = s.open.filter((f) => !accounts.has(f.account) && !apps.has(f.app));
  const entries = s.entries
    .map((e) => ({ ...e, apps: e.apps.filter((m) => !gone(m)), fixedIn: e.fixedIn.filter((m) => !gone(m)) }))
    .filter((e) => e.apps.length > 0 || e.status === "approved");
  return { entries, open };
}

/** Pure. A run that got through after failing: the fix becomes (or strengthens) a playbook candidate. */
export function noteFix(entries: PlaybookEntry[], open: OpenFailure[], ref: string, fix: string | null, now: Date): { entries: PlaybookEntry[]; open: OpenFailure[]; entry: PlaybookEntry | null } {
  const failure = open.find((x) => x.ref === ref);
  const rest = open.filter((x) => x.ref !== ref);
  if (!failure || !fix) return { entries, open: rest, entry: null };
  const at = now.toISOString();
  const existing = entries.find((e) => e.key === failure.key && e.status !== "retired");
  if (existing) {
    const who = memberOf(failure);
    const entry: PlaybookEntry = { ...existing, apps: [...new Set([...existing.apps, who])], fixedIn: [...new Set([...existing.fixedIn, who])], seen: existing.seen + 1, updatedAt: at };
    return { entries: entries.map((e) => (e.id === existing.id ? entry : e)), open: rest, entry };
  }
  const entry: PlaybookEntry = { id: `pb-${randomUUID().slice(0, 8)}`, key: failure.key, framework: failure.framework, pkg: failure.pkg, errorType: failure.errorType, fix, status: "candidate", apps: [memberOf(failure)], fixedIn: [memberOf(failure)], seen: 1, createdAt: at, updatedAt: at };
  return { entries: [entry, ...entries], open: rest, entry };
}

const ERROR_LABEL: Record<string, string> = {
  module_not_found: "a module that can't be resolved",
  type_error_ts: "type errors",
  peer_dependency: "conflicting package versions",
  native_build_ios: "the iOS native build",
  native_build_android: "the Android native build",
  expo_config: "the Expo config",
  metro_bundle: "the Metro bundle",
  invariant: "an invariant violation",
  test_failed: "failing tests",
  lint: "lint errors",
  device_check: "the virtual-device check",
  runtime_type_error: "a runtime type error",
  no_changes: "no changes made",
  other: "a failed check",
};

/** Pure. Approved entries for this stack, for the build agent's notes ("" when none). */
export function playbookNotes(entries: PlaybookEntry[], stack: Stack, max = 5): string {
  const fits = entries.filter((e) => e.status === "approved" && e.framework === stack.framework && (!e.pkg || stack.packages.includes(e.pkg)));
  if (!fits.length) return "";
  const lines = fits
    .sort((a, b) => b.fixedIn.length - a.fixedIn.length || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, max)
    .map((e) => `- ${e.pkg ? `${e.pkg}, ` : ""}${ERROR_LABEL[e.errorType] ?? e.errorType}: ${e.fix}`);
  return `Known fixes on this stack (${stack.framework}), learned from builds of other apps — use one only if the same problem shows up here:\n${lines.join("\n")}`;
}

export const errorLabel = (t: string) => ERROR_LABEL[t] ?? t;
