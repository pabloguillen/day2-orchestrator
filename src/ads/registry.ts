import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "../day2-paths";
import { decryptSecret, encryptSecret, hasSecretsKey } from "../secrets";
import * as google from "./platforms/google";
import * as linkedin from "./platforms/linkedin";
import * as meta from "./platforms/meta";
import * as pinterest from "./platforms/pinterest";
import * as reddit from "./platforms/reddit";
import * as snapchat from "./platforms/snapchat";
import * as tiktok from "./platforms/tiktok";
import * as x from "./platforms/x";
import { createCreatify, creatifyFromEnv } from "./providers/creatify";
import { createRunway, runwayFromEnv } from "./providers/runway";
import type { VideoProvider } from "./providers/video";
import type { AdPlatform, PlatformDeps, PlatformId, PlatformInfo } from "./types";

/**
 * Which ad platforms and video providers this day2 server can use: those
 * whose credentials (day2's own ad accounts) are in its environment.
 * Platforms that rotate refresh tokens get the newest one from an
 * encrypted file on day2's disk, so a restart doesn't lose access.
 */

type Module = {
  info: PlatformInfo;
  credentialsFromEnv(env: Record<string, string | undefined>): unknown;
  create(creds: never, deps?: PlatformDeps): AdPlatform;
};

export const MODULES: Record<PlatformId, Module> = { meta, tiktok, linkedin, google, snapchat, pinterest, reddit, x } as unknown as Record<PlatformId, Module>;
export const ALL_PLATFORMS = Object.keys(MODULES) as PlatformId[];
export const platformInfo = (id: PlatformId): PlatformInfo => MODULES[id].info;

const TOKENS_FILE = () => join(dataDir(), ".day2-ads-tokens.json");

function storedTokens(): Partial<Record<PlatformId, string>> {
  const p = TOKENS_FILE();
  if (!existsSync(p) || !hasSecretsKey()) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, string>;
    return Object.fromEntries(Object.entries(raw).flatMap(([k, v]) => {
      try {
        return [[k, decryptSecret(v, `ads-refresh:${k}`)]];
      } catch {
        return [];
      }
    }));
  } catch {
    return {};
  }
}

function saveToken(platform: PlatformId, token: string): void {
  if (!hasSecretsKey()) return; // never write a token in the clear
  const p = TOKENS_FILE();
  const raw = existsSync(p) ? (JSON.parse(readFileSync(p, "utf-8")) as Record<string, string>) : {};
  raw[platform] = encryptSecret(token, `ads-refresh:${platform}`);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw));
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
}

const cache = new Map<PlatformId, AdPlatform>();

/** The platforms day2 has an ad account on (credentials present), as adapters. */
export function configuredPlatforms(env: Record<string, string | undefined> = process.env, deps?: PlatformDeps): Map<PlatformId, AdPlatform> {
  const out = new Map<PlatformId, AdPlatform>();
  const rotated = storedTokens();
  for (const id of ALL_PLATFORMS) {
    if (env.DAY2_ADS_DISABLE?.split(",").map((s) => s.trim()).includes(id)) continue;
    const creds = MODULES[id].credentialsFromEnv(env) as Record<string, unknown> | null;
    if (!creds) continue;
    if (!deps && cache.has(id)) {
      out.set(id, cache.get(id)!);
      continue;
    }
    if (typeof creds.refreshToken === "string" && rotated[id]) creds.refreshToken = rotated[id];
    creds.onRefreshToken = (t: string) => saveToken(id, t);
    const adapter = MODULES[id].create(creds as never, deps);
    if (!deps) cache.set(id, adapter);
    out.set(id, adapter);
  }
  return out;
}

export function videoProviders(env: Record<string, string | undefined> = process.env): { creatify: VideoProvider | null; runway: VideoProvider | null } {
  const c = creatifyFromEnv(env);
  const r = env.DAY2_ADS_RUNWAY === "on" ? runwayFromEnv(env) : null;
  return { creatify: c ? createCreatify(c) : null, runway: r ? createRunway(r) : null };
}
