import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Platform-level multi-app registry (day2 console plan §4) — one file,
 * `orchestrator/.day2-apps.json`, listing every app an owner has connected.
 * Not per-app and not reached via `--repo`, unlike every other `.day2-*.json`
 * file in this codebase, which lives inside the app repo it governs.
 *
 * `hasGitRemote` is a real, checked fact rather than something inferred from
 * `connectionMethod` — an upload-connected app, or a local_path app with no
 * remote configured, both need the same honest "insights only" capability
 * gate before Autonomy/Approvals (which need a real `gh pr` target) render
 * their controls.
 */

export type ConnectionMethod = "github" | "local_path" | "upload";

export type AppEntry = {
  id: string;
  name: string;
  repoPath: string;
  connectionMethod: ConnectionMethod;
  githubRepo?: string;
  appBaseUrl?: string;
  addedAt: string;
};

export type AppsRegistry = { apps: AppEntry[] };

export const APPS_REGISTRY_FILENAME = ".day2-apps.json";
export const MANAGED_REPOS_DIR = "managed-repos";

export function loadAppsRegistry(path: string): AppsRegistry {
  if (!existsSync(path)) {
    return { apps: [] };
  }
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} exists but isn't valid JSON — fix or remove it by hand before using this tool.`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { apps: unknown }).apps)) {
    throw new Error(`${path} exists but doesn't look like a valid apps registry — refusing to guess or overwrite it.`);
  }
  return parsed as AppsRegistry;
}

export function saveAppsRegistry(path: string, registry: AppsRegistry): void {
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
}

export function generateAppId(): string {
  return `app_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Fails closed rather than silently creating a duplicate or dangling entry:
 * rejects a `repoPath` that doesn't exist on disk, one already registered
 * under a different app, or (when `options.maxApps` is given) an add that
 * would exceed the caller's pricing-tier app allowance
 * (docs/offering-logic.md — Starter: 1 app, Growth: 5 apps, Enterprise:
 * unlimited).
 */
export function addApp(
  registry: AppsRegistry,
  input: {
    name: string;
    repoPath: string;
    connectionMethod: ConnectionMethod;
    githubRepo?: string;
    appBaseUrl?: string;
    /** Only ever supplied by the upload flow, which must create the
     * `managed-repos/<id>/` extraction directory before the registry entry
     * exists — lets that directory name and this entry's id match. Every
     * other caller omits this and gets a fresh generated id. */
    id?: string;
  },
  options: {
    /** The caller's plan entitlement (docs/offering-logic.md's pricing
     * tiers — Starter: 1, Growth: 5, Enterprise: unlimited), not a
     * mechanism this file decides on its own; this function only enforces
     * whatever cap the caller passes in. `undefined` (the default) means
     * unlimited — every existing caller that doesn't pass `options` keeps
     * today's exact behavior, including the one real app this platform
     * powers (expense-buddy). */
    maxApps?: number;
  } = {},
): { ok: true; registry: AppsRegistry; app: AppEntry } | { ok: false; reason: string } {
  if (!existsSync(input.repoPath)) {
    return { ok: false, reason: `${input.repoPath} doesn't exist on disk.` };
  }
  const existing = registry.apps.find((a) => a.repoPath === input.repoPath);
  if (existing) {
    return { ok: false, reason: `${input.repoPath} is already registered as "${existing.name}" (${existing.id}).` };
  }
  if (options.maxApps !== undefined && registry.apps.length >= options.maxApps) {
    return {
      ok: false,
      reason: `This plan allows up to ${options.maxApps} app${options.maxApps === 1 ? "" : "s"} — remove one before adding another, or upgrade your plan.`,
    };
  }
  const app: AppEntry = {
    id: input.id ?? generateAppId(),
    name: input.name,
    repoPath: input.repoPath,
    connectionMethod: input.connectionMethod,
    githubRepo: input.githubRepo,
    appBaseUrl: input.appBaseUrl,
    addedAt: new Date().toISOString(),
  };
  const nextRegistry: AppsRegistry = { apps: [...registry.apps, app] };
  return { ok: true, registry: nextRegistry, app };
}

/** Registry-only — never touches the app's own repo/clone on disk. */
/** Sets (or clears, with an empty string/undefined) an app's live base URL —
 * the address growth-strategy.ts reads `/api/day2-stats` from. Only http(s)
 * URLs are accepted; anything else is rejected rather than stored. */
export function setAppBaseUrl(
  registry: AppsRegistry,
  id: string,
  appBaseUrl: string | undefined,
): { ok: true; registry: AppsRegistry; app: AppEntry } | { ok: false; reason: string } {
  const existing = registry.apps.find((a) => a.id === id);
  if (!existing) return { ok: false, reason: `No app registered with id "${id}".` };
  const trimmed = appBaseUrl?.trim();
  let normalized: string | undefined;
  if (trimmed) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { ok: false, reason: `"${trimmed}" isn't a valid URL.` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, reason: "The app's address must start with http:// or https://." };
    }
    normalized = url.toString().replace(/\/$/, "");
  }
  const app: AppEntry = { ...existing, appBaseUrl: normalized };
  if (!normalized) delete app.appBaseUrl;
  return { ok: true, app, registry: { apps: registry.apps.map((a) => (a.id === id ? app : a)) } };
}

export function removeApp(registry: AppsRegistry, id: string): AppsRegistry {
  return { apps: registry.apps.filter((a) => a.id !== id) };
}

export function findApp(registry: AppsRegistry, id: string): AppEntry | undefined {
  return registry.apps.find((a) => a.id === id);
}

export function renderAppsSummary(registry: AppsRegistry): string {
  if (registry.apps.length === 0) {
    return "No apps connected yet.";
  }
  return registry.apps
    .map((a) => `- ${a.name} (${a.id}), connected via ${a.connectionMethod}: ${a.repoPath}`)
    .join("\n");
}

/**
 * Real, checked fact — never inferred from `connectionMethod` alone. Gates
 * whether Approvals/Autonomy's PR-based mechanism has anything to operate
 * against.
 */
export function hasGitRemote(repoPath: string): boolean {
  if (!existsSync(repoPath)) {
    return false;
  }
  try {
    const out = execSync("git remote -v", { cwd: repoPath, stdio: ["ignore", "pipe", "ignore"] }).toString();
    return out.trim().length > 0;
  } catch {
    return false;
  }
}
