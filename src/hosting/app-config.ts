import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NewTicketInput } from "../backlog";
import { childEnv, EAS_CLI_VERSION } from "../mobile-release/eas";
import type { Runner } from "./migrations";

/**
 * The app learns where its backend is from two public values:
 *   EXPO_PUBLIC_SUPABASE_URL  https://<ref>.supabase.co
 *   EXPO_PUBLIC_SUPABASE_KEY  the publishable key (public by design; RLS protects the data)
 *
 * - eas.json: `build.<profile>.env` — store builds get them inlined
 *   (production profile → production project; other profiles → staging
 *   when there is one).
 * - EAS environment variables (`eas env:set`, eas-cli 27.2.0's flags):
 *   `eas update --environment production` (day2's release path) reads them,
 *   so over-the-air updates get the same values as builds.
 * Never the secret key.
 */

export const URL_VAR = "EXPO_PUBLIC_SUPABASE_URL";
export const KEY_VAR = "EXPO_PUBLIC_SUPABASE_KEY";
export const APP_CONFIG_KEY = "hosting:app-config";

export type EnvValues = { url: string; key: string };

type EasJson = { build?: Record<string, { env?: Record<string, string>; [k: string]: unknown }>; [k: string]: unknown };

/** Pure. eas.json with the values in every build profile; null when nothing changes. */
export function easJsonWithEnv(raw: string | null, production: EnvValues, staging: EnvValues | null): string | null {
  const j: EasJson = raw ? (JSON.parse(raw) as EasJson) : {};
  const build = { ...(j.build ?? {}) };
  if (!Object.keys(build).length) build.production = {};
  if (!build.production) build.production = {};
  let changed = false;
  for (const [name, profile] of Object.entries(build)) {
    const v = name === "production" || !staging ? production : staging;
    const env = { ...(profile.env ?? {}) };
    if (env[URL_VAR] !== v.url || env[KEY_VAR] !== v.key) {
      env[URL_VAR] = v.url;
      env[KEY_VAR] = v.key;
      changed = true;
    }
    build[name] = { ...profile, env };
  }
  return changed ? `${JSON.stringify({ ...j, build }, null, 2)}\n` : null;
}

/** Writes eas.json in the app's checkout (Create, before its first commit is pushed). */
export function writeEasJson(repoPath: string, production: EnvValues, staging: EnvValues | null): boolean {
  const p = join(repoPath, "eas.json");
  const next = easJsonWithEnv(existsSync(p) ? readFileSync(p, "utf-8") : null, production, staging);
  if (next) writeFileSync(p, next);
  return Boolean(next);
}

/** For apps day2 didn't just create: the same change as a small ticket. */
export function appConfigTicket(production: EnvValues, staging: EnvValues | null): NewTicketInput {
  return {
    title: "Point the app at its hosted backend",
    type: "task",
    description: [
      `In eas.json, add to the \`env\` of every build profile (production → the production values${staging ? ", other profiles → staging" : ""}):`,
      "```json",
      JSON.stringify({ [URL_VAR]: production.url, [KEY_VAR]: production.key }, null, 2),
      "```",
      ...(staging ? ["Staging:", "```json", JSON.stringify({ [URL_VAR]: staging.url, [KEY_VAR]: staging.key }, null, 2), "```"] : []),
      "The key is the publishable key: public by design (row level security protects the data). Don't add any other Supabase key.",
    ].join("\n"),
    doneWhen: ["Every build profile in eas.json has EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_KEY"],
    priority: 2,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: APP_CONFIG_KEY },
    actor: "day2",
    createdNote: "day2 hosts the app's backend (Hosting).",
  };
}

/** True when the app is linked to an EAS project (app.json extra.eas.projectId). */
export function hasEasProject(repoPath: string): boolean {
  const p = join(repoPath, "app.json");
  if (!existsSync(p)) return false;
  try {
    const j = JSON.parse(readFileSync(p, "utf-8")) as { expo?: { extra?: { eas?: { projectId?: string } } } };
    return Boolean(j.expo?.extra?.eas?.projectId);
  } catch {
    return false;
  }
}

/** `eas env:set` for both values in an EAS environment. The Expo token goes in the child's environment only. */
export async function setEasEnv(run: Runner, repoPath: string, expoToken: string, environment: "production" | "preview", v: EnvValues): Promise<{ ok: true } | { ok: false; error: string }> {
  const env = childEnv(expoToken);
  for (const [name, value] of [
    [URL_VAR, v.url],
    [KEY_VAR, v.key],
  ] as const) {
    const r = await run(["npx", "--yes", `eas-cli@${EAS_CLI_VERSION}`, "env:set", "--name", name, "--value", value, "--environment", environment, "--visibility", "plaintext", "--scope", "project", "--non-interactive"], { cwd: repoPath, env });
    if (r.code !== 0) return { ok: false, error: `${r.stderr}\n${r.stdout}`.split(expoToken).join("[token]").trim().split("\n").slice(-6).join("\n").slice(0, 400) };
  }
  return { ok: true };
}
