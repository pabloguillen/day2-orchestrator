import { $ } from "bun";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppEntry } from "./apps-registry";
import { cloneIsolatedWorkspace, defaultBranch } from "./git";
import type { ExistingIntegration } from "./field-work";
import { gitEnv } from "./tenant";

/**
 * For an app that wired day2 in by hand with its key and address read from
 * environment variables (like `process.env.EXPO_PUBLIC_DAY2_KEY`): day2 sets
 * them for release builds itself — a small pull request on eas.json — so the
 * owner only approves it instead of editing build settings.
 */

export const TURN_ON_KEY = "field:turn-on";

/** Pure. eas.json with the two settings in the production build profile, or null when they're already there. */
export function withDay2Env(easJson: string, envKey: string, envEndpoint: string | null, key: string, endpoint: string): string | null {
  const j = JSON.parse(easJson) as { build?: Record<string, { env?: Record<string, string> } & Record<string, unknown>> };
  const build = (j.build ??= {});
  const prod = (build.production ??= {});
  const env = { ...(prod.env ?? {}) };
  const before = JSON.stringify(env);
  env[envKey] = key;
  if (envEndpoint) env[envEndpoint] = endpoint;
  if (JSON.stringify(env) === before) return null;
  prod.env = env;
  return `${JSON.stringify(j, null, 2)}\n`;
}

/** Keeps day2's own checkout of the app current (what day2 reads between passes), when nothing tracked is changed in it. */
export async function syncCheckout(repoPath: string): Promise<void> {
  const dirty = (await $`git -C ${repoPath} status --porcelain --untracked-files=no`.quiet().nothrow().text()).trim();
  if (dirty) return;
  await $`git -C ${repoPath} pull --ff-only --quiet`.env(await gitEnv()).quiet().nothrow();
}

/** Opens the pull request. Returns its URL and number, or null when there's nothing to change. */
export async function openTurnOnPr(app: AppEntry, ex: ExistingIntegration, key: string, endpoint: string): Promise<{ url: string; number: number } | null> {
  if (!ex.envKey) return null;
  const work = await cloneIsolatedWorkspace(app.repoPath);
  try {
    const easPath = join(work, "eas.json");
    if (!existsSync(easPath)) return null;
    const next = withDay2Env(readFileSync(easPath, "utf-8"), ex.envKey, ex.envEndpoint, key, endpoint);
    if (!next) return null;
    const env = await gitEnv();
    const base = await defaultBranch(work);
    const branch = `day2-fix-turn-on-day2-${Date.now().toString(36)}`;
    await $`git -C ${work} checkout -B ${branch} ${`origin/${base}`}`.quiet();
    writeFileSync(easPath, next);
    await $`git -C ${work} add eas.json`.quiet();
    await $`git -C ${work} -c user.name=day2 -c user.email=day2@users.noreply.github.com commit -m ${"Turn on day2 in release builds"}`.quiet();
    await $`git -C ${work} push -u origin ${branch}`.env(env).quiet();
    const body = [
      "## What this adds",
      `day2 is already in the app (${ex.file}) but stays off until release builds get its key and address. This sets them in eas.json's production build profile, so the next store build reports crashes, broken screens and usage to day2.`,
      "",
      "## What changed",
      `eas.json → build.production.env: ${[ex.envKey, ex.envEndpoint].filter(Boolean).join(" and ")}. The key can only send reports to day2, so it's safe in the repo and in the app.`,
      "",
      "## Before the next release",
      "Update the App Store / Google Play privacy answers — day2 walks you through it on the Privacy page.",
    ].join("\n");
    const out = (await $`gh pr create --title ${"Turn on day2 in release builds"} --body ${body} --head ${branch} --base ${base}`.cwd(work).env(env).text()).trim();
    const url = out.split("\n").pop() ?? out;
    return { url, number: Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
