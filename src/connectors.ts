import type { SQL } from "bun";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { decryptSecret, encryptSecret } from "./secrets";

/**
 * Connected tools: specialist products a workspace connects so day2's
 * agents can use them through their official MCP servers — competitor ad
 * research, video generation, ad accounts. day2 decides *what* to make and
 * judges *whether it worked* in the product; these tools do what they're
 * best at.
 *
 * Each connection belongs to one workspace. The person signs in with the
 * tool's own OAuth (day2 never sees their password), the tokens are stored
 * encrypted (secrets.ts) and refreshed when they near expiry, and an agent
 * run gets the connection as an HTTP MCP server with a bearer token.
 *
 * Tools that don't support dynamic client registration can be given a
 * pre-registered OAuth client via DAY2_CONNECTOR_<ID>_CLIENT_ID (and
 * _CLIENT_SECRET).
 */

export type ConnectorId = "foreplay" | "runway" | "meta_ads";

/** Local mode's store (gitignored). */
export const CONNECTORS_FILENAME = ".day2-connectors.json";

export type ConnectorUse = "competitor_research" | "video_generation" | "ad_platform";

export type Connector = {
  id: ConnectorId;
  name: string;
  /** What day2 uses it for, in plain words. */
  useFor: string;
  uses: ConnectorUse[];
  mcpUrl: string;
  /** Where its MCP server is documented — the source for this entry. */
  docsUrl: string;
  /** Shown before connecting, when there's something to know. */
  note?: string;
};

export const CONNECTORS: Connector[] = [
  {
    id: "foreplay",
    name: "Foreplay",
    useFor: "Competitor ad research: 200M+ ads across Meta, TikTok, YouTube and LinkedIn. day2 uses it to find the hooks, offers and formats that keep running for apps like yours.",
    uses: ["competitor_research"],
    mcpUrl: "https://public.api.foreplay.co/mcp",
    docsUrl: "https://feedback.foreplay.co/changelog/foreplay-mcp-connect-200m-ads-to-claude-chatgpt-and-any",
    note: "Needs a Foreplay account. Research uses your Foreplay plan's API credits.",
  },
  {
    id: "runway",
    name: "Runway",
    useFor: "Video and image generation for ads and social posts, from day2's briefs and your app's real screens.",
    uses: ["video_generation"],
    mcpUrl: "https://mcp.runwayml.com",
    docsUrl: "https://docs.dev.runwayml.com/guides/mcp/",
    note: "Needs a Runway account. Generations use your Runway credits.",
  },
  {
    id: "meta_ads",
    name: "Meta Ads",
    useFor: "Your Facebook and Instagram ad account: day2 reads what each ad costs and brings, and — only with your approval — prepares campaigns.",
    uses: ["ad_platform"],
    mcpUrl: "https://mcp.facebook.com/ads",
    docsUrl: "https://ppc.io/blog/ads-mcp-google-vs-meta",
    note: "Sign in with the Meta Business account that owns your ad account. Ad spend stays on your Meta account; day2 never launches or changes a campaign without your OK.",
  },
];

export function findConnector(id: string): Connector | undefined {
  return CONNECTORS.find((c) => c.id === id);
}

/** The MCP server address; DAY2_CONNECTOR_<ID>_MCP_URL overrides it (a
 * tool moving its server, or a test server). */
export function mcpUrlFor(c: Connector): string {
  return process.env[`DAY2_CONNECTOR_${c.id.toUpperCase()}_MCP_URL`] ?? c.mcpUrl;
}

// ---------------------------------------------------------------------------
// Stored state per workspace + tool
// ---------------------------------------------------------------------------

export type ConnectionRecord = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** When `tokens` were saved — with `expires_in`, when they expire. */
  tokensSavedAt?: string;
  codeVerifier?: string;
  state?: string;
  connectedAt?: string;
  connectedBy?: string;
  lastError?: string | null;
};

export interface ConnectorStore {
  get(id: ConnectorId): Promise<ConnectionRecord | undefined>;
  all(): Promise<Partial<Record<ConnectorId, ConnectionRecord>>>;
  update(id: ConnectorId, fn: (cur: ConnectionRecord) => ConnectionRecord | undefined): Promise<ConnectionRecord | undefined>;
}

/** Local single-operator mode: one gitignored file (0600). */
export function fileConnectors(path: string): ConnectorStore {
  const load = (): Partial<Record<ConnectorId, ConnectionRecord>> =>
    existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Partial<Record<ConnectorId, ConnectionRecord>>) : {};
  return {
    async get(id) {
      return load()[id];
    },
    async all() {
      return load();
    },
    async update(id, fn) {
      const all = load();
      const next = fn(all[id] ?? {});
      if (next === undefined) delete all[id];
      else all[id] = next;
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
      return next;
    },
  };
}

const ctx = (accountId: string, id: string) => `connector:${accountId}:${id}`;

/** Production: one encrypted row per workspace + tool. */
export function dbConnectors(sql: SQL, accountId: string): ConnectorStore {
  const read = async (q: SQL, id: ConnectorId, lock: boolean): Promise<ConnectionRecord | undefined> => {
    const rows = (lock
      ? await q`SELECT data_enc FROM account_connectors WHERE account_id = ${accountId} AND connector_id = ${id} FOR UPDATE`
      : await q`SELECT data_enc FROM account_connectors WHERE account_id = ${accountId} AND connector_id = ${id}`) as Array<{ data_enc: string }>;
    return rows[0] ? (JSON.parse(decryptSecret(rows[0].data_enc, ctx(accountId, id))) as ConnectionRecord) : undefined;
  };
  return {
    get: (id) => read(sql, id, false),
    async all() {
      const rows = (await sql`SELECT connector_id, data_enc FROM account_connectors WHERE account_id = ${accountId}`) as Array<{ connector_id: ConnectorId; data_enc: string }>;
      return Object.fromEntries(rows.map((r) => [r.connector_id, JSON.parse(decryptSecret(r.data_enc, ctx(accountId, r.connector_id))) as ConnectionRecord]));
    },
    async update(id, fn) {
      return (await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${ctx(accountId, id)}))`;
        const next = fn((await read(tx, id, true)) ?? {});
        if (next === undefined) {
          await tx`DELETE FROM account_connectors WHERE account_id = ${accountId} AND connector_id = ${id}`;
        } else {
          const enc = encryptSecret(JSON.stringify(next), ctx(accountId, id));
          await tx`INSERT INTO account_connectors (account_id, connector_id, data_enc) VALUES (${accountId}, ${id}, ${enc})
            ON CONFLICT (account_id, connector_id) DO UPDATE SET data_enc = EXCLUDED.data_enc, updated_at = now()`;
        }
        return next;
      })) as ConnectionRecord | undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// OAuth (MCP authorization spec, via the MCP SDK)
// ---------------------------------------------------------------------------

function preRegisteredClient(id: ConnectorId): OAuthClientInformationMixed | undefined {
  const key = id.toUpperCase();
  const clientId = process.env[`DAY2_CONNECTOR_${key}_CLIENT_ID`];
  if (!clientId) return undefined;
  const secret = process.env[`DAY2_CONNECTOR_${key}_CLIENT_SECRET`];
  return { client_id: clientId, ...(secret ? { client_secret: secret } : {}) };
}

class StoredOAuthProvider implements OAuthClientProvider {
  pendingAuthorizationUrl: URL | null = null;
  constructor(
    private store: ConnectorStore,
    private id: ConnectorId,
    private callbackUrl: string,
  ) {}
  private patch(p: Partial<ConnectionRecord>) {
    return this.store.update(this.id, (cur) => ({ ...cur, ...p }));
  }
  get redirectUrl() {
    return this.callbackUrl;
  }
  get clientMetadata(): OAuthClientMetadata {
    const pre = preRegisteredClient(this.id);
    return {
      client_name: "day2",
      redirect_uris: [this.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: pre && "client_secret" in pre && pre.client_secret ? "client_secret_post" : "none",
    };
  }
  async state() {
    const s = randomUUID();
    await this.patch({ state: s });
    return s;
  }
  async clientInformation() {
    return preRegisteredClient(this.id) ?? (await this.store.get(this.id))?.clientInformation;
  }
  async saveClientInformation(info: OAuthClientInformationMixed) {
    await this.patch({ clientInformation: info });
  }
  async tokens() {
    return (await this.store.get(this.id))?.tokens;
  }
  async saveTokens(tokens: OAuthTokens) {
    await this.patch({ tokens, tokensSavedAt: new Date().toISOString(), lastError: null });
  }
  redirectToAuthorization(url: URL) {
    this.pendingAuthorizationUrl = url;
  }
  async saveCodeVerifier(v: string) {
    await this.patch({ codeVerifier: v });
  }
  async codeVerifier() {
    const v = (await this.store.get(this.id))?.codeVerifier;
    if (!v) throw new Error("This sign-in expired — start connecting again.");
    return v;
  }
}

/** Starts connecting a tool: the address of the tool's sign-in page. */
/** A readable reason from an OAuth error (some carry only a code). */
function reason(err: unknown): string {
  const e = err as { message?: string; errorCode?: string; error?: string; constructor?: { name?: string } };
  return (e.message || e.errorCode || e.error || e.constructor?.name || "the tool refused the sign-in").slice(0, 300);
}

export async function beginConnector(store: ConnectorStore, connector: Connector, callbackUrl: string, by: string | null): Promise<{ authorizeUrl: string }> {
  // A fresh start: forget half-finished or stale sign-ins.
  await store.update(connector.id, (cur) => ({ clientInformation: cur.clientInformation, connectedBy: by ?? undefined }));
  const provider = new StoredOAuthProvider(store, connector.id, callbackUrl);
  let result;
  try {
    result = await auth(provider, { serverUrl: mcpUrlFor(connector) });
  } catch (err) {
    throw new Error(`${connector.name} didn't accept the connection request: ${reason(err)}`);
  }
  if (result === "AUTHORIZED" || !provider.pendingAuthorizationUrl) throw new Error(`${connector.name} didn't return a sign-in page.`);
  return { authorizeUrl: provider.pendingAuthorizationUrl.toString() };
}

/** The tool's sign-in sent the person back with `code` and `state`: which
 * connection was it (by `state`), and finish it. */
export async function finishConnector(store: ConnectorStore, state: string | null, code: string | null, callbackUrl: string): Promise<Connector> {
  if (!state || !code) throw new Error("The sign-in didn't complete.");
  const all = await store.all();
  const id = (Object.keys(all) as ConnectorId[]).find((k) => all[k]?.state === state);
  const connector = id ? findConnector(id) : undefined;
  if (!connector) throw new Error("That sign-in expired — start connecting again.");
  const provider = new StoredOAuthProvider(store, connector.id, callbackUrl);
  let result;
  try {
    result = await auth(provider, { serverUrl: mcpUrlFor(connector), authorizationCode: code });
  } catch (err) {
    await store.update(connector.id, (cur) => ({ ...cur, lastError: `The sign-in didn't finish (${reason(err)}). Try connecting again.` }));
    throw new Error(`${connector.name} didn't finish the sign-in: ${reason(err)}`);
  }
  if (result !== "AUTHORIZED") throw new Error(`${connector.name} didn't finish the sign-in.`);
  await store.update(connector.id, (cur) => ({ ...cur, state: undefined, codeVerifier: undefined, connectedAt: new Date().toISOString(), lastError: null }));
  return connector;
}

export async function disconnectConnector(store: ConnectorStore, id: ConnectorId): Promise<void> {
  await store.update(id, () => undefined);
}

export type ConnectorStatus = {
  id: ConnectorId;
  name: string;
  useFor: string;
  uses: ConnectorUse[];
  note: string | null;
  docsUrl: string;
  connected: boolean;
  connectedAt: string | null;
  problem: string | null;
};

/** What the console shows — never tokens. */
export async function connectorStatuses(store: ConnectorStore): Promise<ConnectorStatus[]> {
  const all = await store.all();
  return CONNECTORS.map((c) => {
    const r = all[c.id];
    const connected = Boolean(r?.tokens?.access_token && r.connectedAt);
    return {
      id: c.id,
      name: c.name,
      useFor: c.useFor,
      uses: c.uses,
      note: c.note ?? null,
      docsUrl: c.docsUrl,
      connected,
      connectedAt: connected ? r!.connectedAt! : null,
      problem: r?.lastError ?? null,
    };
  });
}

const REFRESH_MARGIN_MS = 2 * 60_000;

function expiresAt(r: ConnectionRecord): number | null {
  if (!r.tokens?.expires_in || !r.tokensSavedAt) return null;
  return new Date(r.tokensSavedAt).getTime() + r.tokens.expires_in * 1000;
}

/**
 * MCP servers for an agent run: every connected tool that serves one of
 * `uses`, with a current access token (refreshed when close to expiry).
 * A tool whose sign-in can't be refreshed is skipped and marked so the
 * console can ask the person to reconnect — the run goes on without it.
 */
export async function connectorMcpServers(store: ConnectorStore, uses: ConnectorUse[], callbackUrl: string, now = Date.now()): Promise<Record<string, McpServerConfig>> {
  const all = await store.all();
  const servers: Record<string, McpServerConfig> = {};
  for (const c of CONNECTORS) {
    if (!c.uses.some((u) => uses.includes(u))) continue;
    let r = all[c.id];
    if (!r?.tokens?.access_token || !r.connectedAt) continue;
    const exp = expiresAt(r);
    if (exp !== null && exp - now < REFRESH_MARGIN_MS) {
      if (!r.tokens.refresh_token) {
        await store.update(c.id, (cur) => ({ ...cur, lastError: "The sign-in expired — reconnect to keep using it." }));
        continue;
      }
      try {
        const provider = new StoredOAuthProvider(store, c.id, callbackUrl);
        await auth(provider, { serverUrl: mcpUrlFor(c) });
        r = await store.get(c.id);
      } catch (err) {
        await store.update(c.id, (cur) => ({ ...cur, lastError: `Couldn't refresh the sign-in (${reason(err)}) — reconnect to keep using it.` }));
        continue;
      }
      if (!r?.tokens?.access_token) continue;
    }
    servers[c.id] = { type: "http", url: mcpUrlFor(c), headers: { Authorization: `Bearer ${r.tokens.access_token}` } };
  }
  return servers;
}
