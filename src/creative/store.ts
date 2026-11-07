import type { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { decryptSecret, encryptSecret } from "../secrets";
import { isToolId, TOOL_IDS, type ToolCreds, type ToolId } from "./types";

/**
 * Where creator-tool state lives:
 *  - the owner's own keys (per app, or for the whole workspace): encrypted
 *    with DAY2_SECRETS_KEY, bound to the row id, never returned by the API.
 *    Postgres with accounts (migration 027), a 0600 JSON file locally;
 *  - per app, next to its other day2 files (`day2-creator-tools.json`): which
 *    account each tool uses, whether Posts / Ads may use it, its monthly cap
 *    in credits on day2's account, and what was used this month.
 */

// ---------------------------------------------------------------- own keys

export type Likeness = { by: string | null; at: string };
export type OwnKeyMeta = {
  /** Which fields are set (never their values). */
  fields: string[];
  /** Consent given for the owner's own avatar / voice (the likeness fields). */
  likeness: { avatar?: Likeness; voice?: Likeness };
};
export type OwnKey = { id: string; accountId: string; appId: string | null; tool: ToolId; creds: ToolCreds; meta: OwnKeyMeta; connectedBy: string | null; connectedAt: string };
export type NewOwnKey = Omit<OwnKey, "id" | "connectedAt">;

export interface CreatorKeyStore {
  /** The account's keys for this app: the app's own and the workspace-wide ones. */
  forApp(accountId: string, appId: string): Promise<OwnKey[]>;
  save(k: NewOwnKey): Promise<OwnKey>;
  remove(accountId: string, appId: string | null, tool: ToolId): Promise<void>;
}

const newId = () => `ctk_${randomBytes(12).toString("base64url")}`;
/** Bound to the row and to whose key it is: a ciphertext moved to another account, app or tool won't decrypt. */
export const keyContext = (id: string, accountId: string, appId: string | null, tool: string) => `creator-tool:${id}|${accountId}|${appId ?? "*"}|${tool}`;
const seal = (c: ToolCreds, id: string, accountId: string, appId: string | null, tool: string) => encryptSecret(JSON.stringify(c), keyContext(id, accountId, appId, tool));
function unseal(v: string, id: string, accountId: string, appId: string | null, tool: string): ToolCreds {
  try {
    return JSON.parse(decryptSecret(v, keyContext(id, accountId, appId, tool))) as ToolCreds;
  } catch (err) {
    // Rows written before the binding included account/app/tool (pre-production only); re-encrypted on the next save.
    try {
      return JSON.parse(decryptSecret(v, `creator-tool:${id}`)) as ToolCreds;
    } catch {
      throw err;
    }
  }
}

type Row = { id: string; account_id: string; app_id: string | null; tool: string; secret_enc: string; meta: unknown; connected_by: string | null; connected_at: Date | string };
const toKey = (r: Row): OwnKey | null =>
  isToolId(r.tool)
    ? { id: r.id, accountId: String(r.account_id), appId: r.app_id, tool: r.tool, creds: unseal(r.secret_enc, r.id, String(r.account_id), r.app_id, r.tool), meta: (typeof r.meta === "string" ? JSON.parse(r.meta) : r.meta) as OwnKeyMeta, connectedBy: r.connected_by, connectedAt: new Date(r.connected_at).toISOString() }
    : null;

export function fileCreatorKeys(path: string): CreatorKeyStore {
  type Shape = Record<string, Omit<Row, "connected_at"> & { connected_at: string }>;
  const key = (a: string, app: string | null, t: ToolId) => `${a}|${app ?? "*"}|${t}`;
  const read = (): Shape => {
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as Shape;
    } catch {
      return {};
    }
  };
  const write = (all: Shape) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  };
  return {
    async forApp(accountId, appId) {
      return Object.values(read())
        .filter((r) => r.account_id === accountId && (r.app_id === appId || r.app_id === null))
        .map(toKey)
        .filter((k): k is OwnKey => Boolean(k));
    },
    async save(k) {
      const all = read();
      const id = newId();
      all[key(k.accountId, k.appId, k.tool)] = { id, account_id: k.accountId, app_id: k.appId, tool: k.tool, secret_enc: seal(k.creds, id, k.accountId, k.appId, k.tool), meta: k.meta, connected_by: k.connectedBy, connected_at: new Date().toISOString() };
      write(all);
      return toKey(all[key(k.accountId, k.appId, k.tool)]!)!;
    },
    async remove(accountId, appId, tool) {
      const all = read();
      delete all[key(accountId, appId, tool)];
      write(all);
    },
  };
}

export function dbCreatorKeys(sql: SQL): CreatorKeyStore {
  return {
    async forApp(accountId, appId) {
      const rows = (await sql`SELECT * FROM creator_tool_keys WHERE account_id = ${accountId} AND (app_id = ${appId} OR app_id IS NULL)`) as Row[];
      return rows.map(toKey).filter((k): k is OwnKey => Boolean(k));
    },
    async save(k) {
      const id = newId();
      return await sql.begin(async (tx) => {
        if (k.appId === null) await tx`DELETE FROM creator_tool_keys WHERE account_id = ${k.accountId} AND app_id IS NULL AND tool = ${k.tool}`;
        else await tx`DELETE FROM creator_tool_keys WHERE account_id = ${k.accountId} AND app_id = ${k.appId} AND tool = ${k.tool}`;
        const [r] = (await tx`INSERT INTO creator_tool_keys (id, account_id, app_id, tool, secret_enc, meta, connected_by) VALUES (${id}, ${k.accountId}, ${k.appId}, ${k.tool}, ${seal(k.creds, id, k.accountId, k.appId, k.tool)}, ${k.meta}::jsonb, ${k.connectedBy}) RETURNING *`) as Row[];
        return toKey(r!)!;
      });
    },
    async remove(accountId, appId, tool) {
      if (appId === null) await sql`DELETE FROM creator_tool_keys WHERE account_id = ${accountId} AND app_id IS NULL AND tool = ${tool}`;
      else await sql`DELETE FROM creator_tool_keys WHERE account_id = ${accountId} AND app_id = ${appId} AND tool = ${tool}`;
    },
  };
}

// ---------------------------------------------------------------- per-app settings

export const CREATOR_TOOLS_FILENAME = "day2-creator-tools.json";

/** "auto": the owner's own key when connected, else day2's (for the tools that were on before). */
export type AccountChoice = "auto" | "day2" | "own" | "off";
export type ToolSetting = { account: AccountChoice; posts: boolean; ads: boolean; capCredits: number };
export type CreatorSettings = { tools: Partial<Record<ToolId, ToolSetting>>; usage: Record<string, Partial<Record<ToolId, number>>> };

/** Per tool, per month, on day2's account. */
export const DEFAULT_CAP_CREDITS = 300;
export const MAX_CAP_CREDITS = 100_000;
export const defaultSetting = (): ToolSetting => ({ account: "auto", posts: true, ads: true, capCredits: DEFAULT_CAP_CREDITS });
export const monthKey = (d: Date) => d.toISOString().slice(0, 7);

export function settingOf(s: CreatorSettings, tool: ToolId): ToolSetting {
  return { ...defaultSetting(), ...(s.tools[tool] ?? {}) };
}

export function loadCreatorSettings(path: string): CreatorSettings {
  const empty: CreatorSettings = { tools: {}, usage: {} };
  if (!existsSync(path)) return empty;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<CreatorSettings>;
    const tools: CreatorSettings["tools"] = {};
    for (const id of TOOL_IDS) {
      const t = raw.tools?.[id] as Partial<ToolSetting> | undefined;
      if (!t) continue;
      tools[id] = {
        account: (["auto", "day2", "own", "off"] as const).includes(t.account as AccountChoice) ? (t.account as AccountChoice) : "auto",
        posts: t.posts !== false,
        ads: t.ads !== false,
        capCredits: typeof t.capCredits === "number" && Number.isFinite(t.capCredits) && t.capCredits >= 0 ? Math.min(MAX_CAP_CREDITS, Math.round(t.capCredits)) : DEFAULT_CAP_CREDITS,
      };
    }
    const usage: CreatorSettings["usage"] = {};
    for (const [m, u] of Object.entries(raw.usage ?? {})) if (/^\d{4}-\d{2}$/.test(m) && u && typeof u === "object") usage[m] = Object.fromEntries(Object.entries(u).filter(([k, v]) => isToolId(k) && typeof v === "number" && v >= 0));
    return { tools, usage };
  } catch {
    return empty;
  }
}

export function saveCreatorSettings(path: string, s: CreatorSettings): void {
  // Keep a year of usage.
  const months = Object.keys(s.usage).sort().slice(-12);
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ tools: s.tools, usage: Object.fromEntries(months.map((m) => [m, s.usage[m]])) }, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Holds `<path>.lock` (created exclusively) while `fn` runs, so read-modify-
 * write of the settings and usage can't interleave across processes (the
 * social and ads passes can run at once). Inside one process the section is
 * synchronous, so it can't interleave there either. A lock older than 30 s
 * is treated as left behind by a crash.
 */
export function withSettingsLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  const deadline = Date.now() + 10_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error("The creator tool settings are busy — try again.");
      Atomics.wait(pause, 0, 0, 15);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

export function updateCreatorSettings(path: string, fn: (s: CreatorSettings) => CreatorSettings): CreatorSettings {
  return withSettingsLock(path, () => {
    const next = fn(loadCreatorSettings(path));
    saveCreatorSettings(path, next);
    return next;
  });
}

export class CapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapError";
  }
}

/**
 * Reserves a job's estimated credits against the tool's monthly cap, from
 * the settings as they are now (under the lock): refused when it wouldn't
 * fit. The caller settles to the real cost afterwards, or releases it.
 */
export function reserveUsage(path: string, tool: ToolId, credits: number, now: Date): void {
  updateCreatorSettings(path, (s) => {
    const cap = settingOf(s, tool).capCredits;
    const used = usedThisMonth(s, tool, now);
    if (used + credits > cap) throw new CapError(`over this month's cap for ${tool} (${used} of ${cap} credits used, this would take about ${credits})`);
    return adjustUsage(s, tool, credits, now);
  });
}

/** Adds (or, negative, takes back) credits of use this month; never below 0. Pure. */
export function adjustUsage(s: CreatorSettings, tool: ToolId, delta: number, now: Date): CreatorSettings {
  const m = monthKey(now);
  const next = Math.max(0, (s.usage[m]?.[tool] ?? 0) + Math.round(delta));
  return { ...s, usage: { ...s.usage, [m]: { ...(s.usage[m] ?? {}), [tool]: next } } };
}

/** Credits used on day2's account this month. Pure. */
export const usedThisMonth = (s: CreatorSettings, tool: ToolId, now: Date) => s.usage[monthKey(now)]?.[tool] ?? 0;

export function addUsage(s: CreatorSettings, tool: ToolId, credits: number, now: Date): CreatorSettings {
  const m = monthKey(now);
  return { ...s, usage: { ...s.usage, [m]: { ...(s.usage[m] ?? {}), [tool]: (s.usage[m]?.[tool] ?? 0) + Math.max(0, Math.round(credits)) } } };
}
