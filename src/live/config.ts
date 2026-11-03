import { createHash } from "node:crypto";
import type { AppEntry } from "../apps-registry";
import type { LiveAd, LiveConfig, LiveMessage, LiveReview } from "../../packages/sensors/src/types";
import { LIVE_CONTRIBUTORS, type LiveContributor } from "./contributors";
import type { LiveStore } from "./store";
import { SERVED_STATES, type LiveState } from "./types";

/**
 * The Live config an app receives (GET /api/ingest/<key>/config): Live's
 * own values and experiments merged with every module's contribution.
 * Public to anyone with the app's key, like contracts — nothing secret.
 */

export type ConfigBody = Omit<LiveConfig, "version">;

export async function buildConfig(
  app: AppEntry,
  state: LiveState,
  now: Date,
  contributors: LiveContributor[] = LIVE_CONTRIBUTORS,
  warn: (text: string) => void = (t) => console.warn(`[day2-live] ${t}`),
): Promise<ConfigBody> {
  const ordered = [...contributors.filter((c) => c.module !== "live"), ...contributors.filter((c) => c.module === "live")];
  const values: LiveConfig["values"] = {};
  const ads: Record<string, LiveAd> = {};
  const messages: LiveMessage[] = [];
  let review: LiveReview | undefined;
  for (const c of ordered) {
    let part;
    try {
      part = await c.contribute(app, { now, live: state });
    } catch (err) {
      warn(`${c.module} couldn't add its part to ${app.name}'s config: ${(err as Error).message}`);
      continue;
    }
    Object.assign(values, part.values ?? {});
    Object.assign(ads, part.ads ?? {});
    for (const m of part.messages ?? []) if (!messages.some((x) => x.id === m.id)) messages.push(m);
    if (part.review) review = part.review;
  }
  const experiments = state.experiments
    .filter((e) => SERVED_STATES.includes(e.state))
    .map((e) => ({ id: e.id, keys: e.keys, variants: e.variants.map((v) => ({ name: v.name, weight: v.weight, values: v.values })), ...(e.audience ? { audience: e.audience } : {}) }));
  return {
    v: 1,
    values,
    experiments,
    ...(Object.keys(ads).length ? { ads } : {}),
    ...(messages.length ? { messages } : {}),
    ...(review ? { review } : {}),
  };
}

/** Stable JSON (sorted keys), so the same content always has the same hash. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export const configHash = (body: ConfigBody) => createHash("sha256").update(stable(body)).digest("hex").slice(0, 32);

export type ServeDeps = {
  store: LiveStore;
  app: (appId: string) => Promise<AppEntry | null>;
  contributors?: LiveContributor[];
  now?: () => Date;
};

/** The config for an app with its version: unchanged content keeps its version (and etag); any change raises it. */
export async function serveConfig(appId: string, deps: ServeDeps): Promise<LiveConfig> {
  const now = deps.now?.() ?? new Date();
  const app = await deps.app(appId);
  const served = await deps.store.served(appId);
  if (!app) return served?.body ?? { v: 1, version: 0, values: {}, experiments: [] };
  const body = await buildConfig(app, await deps.store.get(appId), now, deps.contributors);
  const hash = configHash(body);
  if (served && served.hash === hash) return served.body;
  const config: LiveConfig = { ...body, version: (served?.version ?? 0) + 1 };
  await deps.store.setServed(appId, { version: config.version, hash, body: config });
  return config;
}
