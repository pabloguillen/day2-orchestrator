import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "../day2-paths";
import { decryptSecret, encryptSecret, hasSecretsKey } from "../secrets";
import { connect as googleConnect } from "./connect/google";
import { connect as linkedinConnect } from "./connect/linkedin";
import { connect as metaConnect } from "./connect/meta";
import { connect as pinterestConnect } from "./connect/pinterest";
import { connect as redditConnect } from "./connect/reddit";
import { connect as snapchatConnect } from "./connect/snapchat";
import { connect as tiktokConnect } from "./connect/tiktok";
import type { PlatformConnect } from "./connect/types";
import { connect as xConnect } from "./connect/x";
import type { Connection, ConnectionStore } from "./connections";
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
 * Which ad platforms an app can use, and through whose ad account:
 *  1. the app's own connected account (the customer pays the platform);
 *  2. else day2's connected account (spend billed in credits);
 *  3. else day2's account from the server environment (older setups).
 * Connections are made in one click (OAuth) from the console; only day2's
 * developer-app keys live in the environment.
 */

type Module = {
  info: PlatformInfo;
  credentialsFromEnv(env: Record<string, string | undefined>): unknown;
  create(creds: never, deps?: PlatformDeps): AdPlatform;
};

export const MODULES: Record<PlatformId, Module> = { meta, tiktok, linkedin, google, snapchat, pinterest, reddit, x } as unknown as Record<PlatformId, Module>;
export const CONNECTS: Record<PlatformId, PlatformConnect> = { meta: metaConnect, tiktok: tiktokConnect, linkedin: linkedinConnect, google: googleConnect, snapchat: snapchatConnect, pinterest: pinterestConnect, reddit: redditConnect, x: xConnect };
export const ALL_PLATFORMS = Object.keys(MODULES) as PlatformId[];
export const platformInfo = (id: PlatformId): PlatformInfo => MODULES[id].info;

const disabled = (env: Record<string, string | undefined>) => new Set((env.DAY2_ADS_DISABLE ?? "").split(",").map((s) => s.trim()).filter(Boolean));

// ---------------------------------------------------------------------------
// Older setups: day2's account from the environment
// ---------------------------------------------------------------------------

const TOKENS_FILE = () => join(dataDir(), ".day2-ads-tokens.json");

function storedTokens(): Partial<Record<PlatformId, string>> {
  const p = TOKENS_FILE();
  if (!existsSync(p) || !hasSecretsKey()) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, string>;
    return Object.fromEntries(
      Object.entries(raw).flatMap(([k, v]) => {
        try {
          return [[k, decryptSecret(v, `ads-refresh:${k}`)]];
        } catch {
          return [];
        }
      }),
    );
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

const envCache = new Map<PlatformId, AdPlatform>();

/** The platforms with day2's account in the server environment. */
export function configuredPlatforms(env: Record<string, string | undefined> = process.env, deps?: PlatformDeps): Map<PlatformId, AdPlatform> {
  const out = new Map<PlatformId, AdPlatform>();
  const rotated = storedTokens();
  for (const id of ALL_PLATFORMS) {
    if (disabled(env).has(id)) continue;
    const creds = MODULES[id].credentialsFromEnv(env) as Record<string, unknown> | null;
    if (!creds) continue;
    if (!deps && envCache.has(id)) {
      out.set(id, envCache.get(id)!);
      continue;
    }
    if (typeof creds.refreshToken === "string" && rotated[id]) creds.refreshToken = rotated[id];
    creds.onRefreshToken = (t: string) => saveToken(id, t);
    const adapter = MODULES[id].create(creds as never, deps);
    if (!deps) envCache.set(id, adapter);
    out.set(id, adapter);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Connected accounts
// ---------------------------------------------------------------------------

export type Resolved = {
  id: PlatformId;
  adapter: AdPlatform;
  info: PlatformInfo;
  billing: "credits" | "own";
  currency: string;
  /** "app": the app's own account; "day2": day2's connected account; "env": day2's account from the environment. */
  source: "app" | "day2" | "env";
  accountName: string | null;
  connectionId: string | null;
};

const connCache = new Map<string, AdPlatform>();

/** An adapter for a connected ad account; refreshed tokens are stored back (encrypted). */
export function adapterFor(c: Connection, store: ConnectionStore, env: Record<string, string | undefined> = process.env, deps?: PlatformDeps): AdPlatform | null {
  const app = CONNECTS[c.platform].appCredentials(env);
  if (!app) return null;
  const cacheKey = `${c.id}:${c.connectedAt}`;
  if (!deps && connCache.has(cacheKey)) return connCache.get(cacheKey)!;
  const creds = CONNECTS[c.platform].credentials(app, c.tokens, c.adAccountId) as Record<string, unknown>;
  creds.onRefreshToken = (t: string) => store.updateTokens(c.id, { ...c.tokens, refreshToken: t });
  const adapter = MODULES[c.platform].create(creds as never, deps);
  if (!deps) connCache.set(cacheKey, adapter);
  return adapter;
}

/** For one app (or day2 itself when appId is null): every platform it can run ads on now, through whose account. */
export async function resolvePlatforms(appId: string | null, store: ConnectionStore, env: Record<string, string | undefined> = process.env, deps?: PlatformDeps): Promise<Map<PlatformId, Resolved>> {
  const out = new Map<PlatformId, Resolved>();
  const own = appId ? await store.list({ appId }) : [];
  const day2 = await store.list("day2");
  const fromEnv = configuredPlatforms(env, deps);
  for (const id of ALL_PLATFORMS) {
    if (disabled(env).has(id)) continue;
    const info = platformInfo(id);
    const mine = own.find((c) => c.platform === id);
    const ours = day2.find((c) => c.platform === id);
    const c = mine ?? ours;
    if (c) {
      const adapter = adapterFor(c, store, env, deps);
      if (adapter) {
        out.set(id, { id, adapter, info, billing: mine ? "own" : "credits", currency: c.currency, source: mine ? "app" : "day2", accountName: c.accountName, connectionId: c.id });
        continue;
      }
    }
    const e = fromEnv.get(id);
    if (e) out.set(id, { id, adapter: e, info, billing: "credits", currency: "USD", source: "env", accountName: null, connectionId: null });
  }
  return out;
}

/** Can people connect this platform on this server (day2's developer app keys present)? */
export function connectable(env: Record<string, string | undefined> = process.env): Record<PlatformId, { ok: boolean; missing: string[] }> {
  return Object.fromEntries(
    ALL_PLATFORMS.map((id) => {
      const c = CONNECTS[id];
      const ok = Boolean(c.appCredentials(env));
      return [id, { ok, missing: ok ? [] : c.appEnv.filter((k) => !k.includes("(optional)") && !env[k]) }];
    }),
  ) as Record<PlatformId, { ok: boolean; missing: string[] }>;
}

export function videoProviders(env: Record<string, string | undefined> = process.env): { creatify: VideoProvider | null; runway: VideoProvider | null } {
  const c = creatifyFromEnv(env);
  const r = env.DAY2_ADS_RUNWAY === "on" ? runwayFromEnv(env) : null;
  return { creatify: c ? createCreatify(c) : null, runway: r ? createRunway(r) : null };
}
