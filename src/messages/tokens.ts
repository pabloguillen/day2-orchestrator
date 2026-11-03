import type { SQL } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEVICE_RE, LOCALES, TOKEN_KEEP_DAYS, SENDS_KEEP_DAYS, USER_RE, type Locale, type OptOut, type PushPlatform, type PushToken, type PushTokenInput } from "./types";

/**
 * Push tokens: the store behind `pushTokens.save` (the ingest `push`
 * sub-route, POST /api/ingest/:key/push, fed by day2.setPushToken).
 *
 * One row per device token, owned by one hashed user and bound to the
 * library's device id that registered it. Never written to events or
 * logs, never returned by the API. Rules:
 *  - only the device that registered a token can replace or clear it: a
 *    new token from the same device (for the same user) replaces its old
 *    one; another device adds its own entry and never touches this one.
 *    Sending the token itself again counts as being that device (the
 *    token is the device's secret), and binds it to the sender's id;
 *  - setPushToken(null) from the app = push switched off (or signed out):
 *    only the sending device's tokens for that user and platform are
 *    invalidated, and an opt-out is noted (no token) for the campaign
 *    guardrail — only when that device had a token;
 *  - Expo answers DeviceNotRegistered → the token is invalidated at once
 *    and an opt-out is noted;
 *  - the daily cleanup deletes invalidated tokens and tokens not seen for
 *    400 days; opt-outs go after 400 days.
 */

export interface PushTokenStore {
  save(appId: string, input: PushTokenInput, now: Date): Promise<void>;
  /** Valid tokens (all, or for these users). */
  valid(appId: string, users?: string[]): Promise<PushToken[]>;
  invalidate(appId: string, token: string, reason: "not_registered" | "disabled", now: Date): Promise<void>;
  optOuts(appId: string, since: Date): Promise<OptOut[]>;
  /** Users with at least one valid token, and how many tokens there are per platform. */
  counts(appId: string): Promise<{ users: number; ios: number; android: number }>;
  prune(now: Date): Promise<{ tokens: number }>;
}

const TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/;
const DAY = 86_400_000;

function validZone(tz: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{1,63}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure. Re-shapes what an app sent; null when it isn't a valid push
 * registration. `tz` may be an IANA zone or an offset in minutes east of
 * UTC (−720…840); `tzOffset` is accepted too.
 */
export function cleanPushInput(raw: unknown): PushTokenInput | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.user !== "string" || !USER_RE.test(o.user)) return null;
  // Registrations from apps are bound to the device that sent them.
  if (typeof o.device !== "string" || !DEVICE_RE.test(o.device)) return null;
  if (o.platform !== "ios" && o.platform !== "android") return null;
  let token: string | null = null;
  if (o.token !== null && o.token !== undefined) {
    if (typeof o.token !== "string" || !TOKEN_RE.test(o.token)) return null;
    token = o.token;
  }
  const offsetOf = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= -720 && v <= 840 ? v : null);
  const tz = typeof o.tz === "string" && validZone(o.tz) ? o.tz : null;
  const tzOffset = offsetOf(o.tzOffset) ?? offsetOf(o.tz);
  const locale = typeof o.locale === "string" ? (o.locale.toLowerCase().slice(0, 2) as Locale) : null;
  return { user: o.user, device: o.device, token, platform: o.platform as PushPlatform, tz, tzOffset, locale: locale && LOCALES.includes(locale) ? locale : null };
}

// ---------------------------------------------------------------------------
// Files (local mode): <root>/<app>/push-tokens.json and optouts.json
// ---------------------------------------------------------------------------

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export const appDir = (root: string, appId: string) => join(root, appId.replace(/[^A-Za-z0-9_-]/g, "_"));

export function filePushTokens(root: string): PushTokenStore {
  const tokensPath = (appId: string) => join(appDir(root, appId), "push-tokens.json");
  const optPath = (appId: string) => join(appDir(root, appId), "optouts.json");
  const load = (appId: string) => readJson<Record<string, PushToken>>(tokensPath(appId), {});
  const noteOptOut = (appId: string, o: OptOut) => writeJson(optPath(appId), [...readJson<OptOut[]>(optPath(appId), []), o]);
  const apps = () => (existsSync(root) ? readdirSync(root) : []);
  return {
    async save(appId, input, now) {
      const all = load(appId);
      const at = now.toISOString();
      const device = input.device ?? null;
      if (input.token === null) {
        let any = false;
        for (const t of Object.values(all)) {
          if (t.user === input.user && t.platform === input.platform && (t.device ?? null) === device && !t.invalidatedAt) {
            t.invalidatedAt = at;
            t.invalidReason = "disabled";
            any = true;
          }
        }
        if (any) {
          writeJson(tokensPath(appId), all);
          noteOptOut(appId, { user: input.user, at, reason: "disabled" });
        }
        return;
      }
      // This device's earlier token for this user is replaced (no opt-out: push is still on).
      for (const [k, t] of Object.entries(all)) if (k !== input.token && t.user === input.user && (t.device ?? null) === device && device !== null) delete all[k];
      all[input.token] = { user: input.user, token: input.token, platform: input.platform, tz: input.tz ?? null, tzOffset: input.tzOffset ?? null, locale: input.locale ?? null, updatedAt: at, invalidatedAt: null, invalidReason: null, device };
      writeJson(tokensPath(appId), all);
    },
    async valid(appId, users) {
      const want = users ? new Set(users) : null;
      return Object.values(load(appId)).filter((t) => !t.invalidatedAt && (!want || want.has(t.user)));
    },
    async invalidate(appId, token, reason, now) {
      const all = load(appId);
      const t = all[token];
      if (!t || t.invalidatedAt) return;
      t.invalidatedAt = now.toISOString();
      t.invalidReason = reason;
      writeJson(tokensPath(appId), all);
      noteOptOut(appId, { user: t.user, at: t.invalidatedAt, reason });
    },
    async optOuts(appId, since) {
      const s = since.toISOString();
      return readJson<OptOut[]>(optPath(appId), []).filter((o) => o.at >= s);
    },
    async counts(appId) {
      const v = Object.values(load(appId)).filter((t) => !t.invalidatedAt);
      return { users: new Set(v.map((t) => t.user)).size, ios: v.filter((t) => t.platform === "ios").length, android: v.filter((t) => t.platform === "android").length };
    },
    async prune(now) {
      const cut = new Date(now.getTime() - TOKEN_KEEP_DAYS * DAY).toISOString();
      const optCut = new Date(now.getTime() - SENDS_KEEP_DAYS * DAY).toISOString();
      let dropped = 0;
      for (const appId of apps()) {
        const all = load(appId);
        const keep = Object.fromEntries(Object.entries(all).filter(([, t]) => !t.invalidatedAt && t.updatedAt >= cut));
        const n = Object.keys(all).length - Object.keys(keep).length;
        if (n) {
          dropped += n;
          writeJson(tokensPath(appId), keep);
        }
        const opts = readJson<OptOut[]>(optPath(appId), []);
        const keptOpts = opts.filter((o) => o.at >= optCut);
        if (keptOpts.length !== opts.length) writeJson(optPath(appId), keptOpts);
      }
      return { tokens: dropped };
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres (accounts mode): push_tokens, message_optouts (016_messages.sql)
// ---------------------------------------------------------------------------

type Row = { user_id: string; token: string; device: string | null; platform: PushPlatform; tz: string | null; tz_offset: number | null; locale: Locale | null; updated_at: Date; invalidated_at: Date | null; invalid_reason: PushToken["invalidReason"] };
const fromRow = (r: Row): PushToken => ({
  user: r.user_id,
  token: r.token,
  platform: r.platform,
  tz: r.tz,
  tzOffset: r.tz_offset,
  locale: r.locale,
  updatedAt: new Date(r.updated_at).toISOString(),
  invalidatedAt: r.invalidated_at ? new Date(r.invalidated_at).toISOString() : null,
  invalidReason: r.invalid_reason,
  device: r.device ?? null,
});

export function dbPushTokens(sql: SQL): PushTokenStore {
  return {
    async save(appId, input, now) {
      const at = now.toISOString();
      const device = input.device ?? null;
      if (input.token === null) {
        const changed = (await sql`UPDATE push_tokens SET invalidated_at = ${at}, invalid_reason = 'disabled'
          WHERE app_id = ${appId} AND user_id = ${input.user} AND platform = ${input.platform} AND device IS NOT DISTINCT FROM ${device} AND invalidated_at IS NULL RETURNING token`) as unknown[];
        if (changed.length) await sql`INSERT INTO message_optouts (app_id, user_id, at, reason) VALUES (${appId}, ${input.user}, ${at}, 'disabled') ON CONFLICT DO NOTHING`;
        return;
      }
      await sql.begin(async (tx) => {
        if (device !== null) await tx`DELETE FROM push_tokens WHERE app_id = ${appId} AND user_id = ${input.user} AND device = ${device} AND token <> ${input.token}`;
        await tx`INSERT INTO push_tokens (app_id, token, user_id, platform, tz, tz_offset, locale, updated_at, invalidated_at, invalid_reason, device)
          VALUES (${appId}, ${input.token}, ${input.user}, ${input.platform}, ${input.tz ?? null}, ${input.tzOffset ?? null}, ${input.locale ?? null}, ${at}, NULL, NULL, ${device})
          ON CONFLICT (app_id, token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, tz = EXCLUDED.tz, tz_offset = EXCLUDED.tz_offset, locale = EXCLUDED.locale,
            updated_at = EXCLUDED.updated_at, invalidated_at = NULL, invalid_reason = NULL, device = EXCLUDED.device`;
      });
    },
    async valid(appId, users) {
      const rows = (
        users
          ? await sql`SELECT * FROM push_tokens WHERE app_id = ${appId} AND invalidated_at IS NULL AND user_id = ANY(${sql.array(users, "text")})`
          : await sql`SELECT * FROM push_tokens WHERE app_id = ${appId} AND invalidated_at IS NULL`
      ) as Row[];
      return rows.map(fromRow);
    },
    async invalidate(appId, token, reason, now) {
      const at = now.toISOString();
      const rows = (await sql`UPDATE push_tokens SET invalidated_at = ${at}, invalid_reason = ${reason}
        WHERE app_id = ${appId} AND token = ${token} AND invalidated_at IS NULL RETURNING user_id`) as Array<{ user_id: string }>;
      if (rows[0]) await sql`INSERT INTO message_optouts (app_id, user_id, at, reason) VALUES (${appId}, ${rows[0].user_id}, ${at}, ${reason}) ON CONFLICT DO NOTHING`;
    },
    async optOuts(appId, since) {
      const rows = (await sql`SELECT user_id, at, reason FROM message_optouts WHERE app_id = ${appId} AND at >= ${since.toISOString()} ORDER BY at`) as Array<{ user_id: string; at: Date; reason: OptOut["reason"] }>;
      return rows.map((r) => ({ user: r.user_id, at: new Date(r.at).toISOString(), reason: r.reason }));
    },
    async counts(appId) {
      const [r] = (await sql`SELECT COUNT(DISTINCT user_id)::int AS users, (COUNT(*) FILTER (WHERE platform = 'ios'))::int AS ios, (COUNT(*) FILTER (WHERE platform = 'android'))::int AS android
        FROM push_tokens WHERE app_id = ${appId} AND invalidated_at IS NULL`) as Array<{ users: number; ios: number; android: number }>;
      return r ?? { users: 0, ios: 0, android: 0 };
    },
    async prune(now) {
      const cut = new Date(now.getTime() - TOKEN_KEEP_DAYS * DAY).toISOString();
      const rows = (await sql`DELETE FROM push_tokens WHERE invalidated_at IS NOT NULL OR updated_at < ${cut} RETURNING token`) as unknown[];
      await sql`DELETE FROM message_optouts WHERE at < ${new Date(now.getTime() - SENDS_KEEP_DAYS * DAY).toISOString()}`;
      return { tokens: rows.length };
    },
  };
}
