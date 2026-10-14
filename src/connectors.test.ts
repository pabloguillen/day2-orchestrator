import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginConnector,
  connectorMcpServers,
  connectorStatuses,
  disconnectConnector,
  fileConnectors,
  findConnector,
  finishConnector,
  type ConnectorStore,
} from "./connectors";

/**
 * A stand-in for a tool's MCP server with the MCP authorization flow:
 * protected-resource metadata → authorization server metadata → dynamic
 * client registration → PKCE code exchange → refresh.
 */
let server: ReturnType<typeof Bun.serve>;
let base: string;
const issued: string[] = [];
let tokenCalls = 0;
let expiresIn = 3600;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
      }
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register" && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        return Response.json({ ...body, client_id: "day2-client" }, { status: 201 });
      }
      if (url.pathname === "/token" && req.method === "POST") {
        tokenCalls++;
        const form = new URLSearchParams(await req.text());
        if (form.get("grant_type") === "authorization_code") {
          if (form.get("code") !== "good-code" || !form.get("code_verifier")) return Response.json({ error: "invalid_grant" }, { status: 400 });
        } else if (form.get("grant_type") === "refresh_token") {
          if (form.get("refresh_token") !== "rt") return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const token = `at-${tokenCalls}`;
        issued.push(token);
        return Response.json({ access_token: token, refresh_token: "rt", token_type: "Bearer", expires_in: expiresIn });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
  process.env.DAY2_CONNECTOR_FOREPLAY_MCP_URL = `${base}/mcp`;
});
afterAll(() => {
  server.stop(true);
  delete process.env.DAY2_CONNECTOR_FOREPLAY_MCP_URL;
});

const CALLBACK = "https://day2.test/api/connectors/callback";
const foreplay = findConnector("foreplay")!;

function tempStore(): { store: ConnectorStore; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "day2-connectors-"));
  const path = join(dir, "connectors.json");
  return { store: fileConnectors(path), path, dir };
}

describe("connecting a tool", () => {
  test("sign-in round trip: authorize URL → callback → MCP server for agents", async () => {
    const { store, path, dir } = tempStore();
    try {
      const { authorizeUrl } = await beginConnector(store, foreplay, CALLBACK, "user-1");
      const u = new URL(authorizeUrl);
      expect(`${u.origin}${u.pathname}`).toBe(`${base}/authorize`);
      expect(u.searchParams.get("client_id")).toBe("day2-client");
      expect(u.searchParams.get("redirect_uri")).toBe(CALLBACK);
      expect(u.searchParams.get("code_challenge_method")).toBe("S256");
      const state = u.searchParams.get("state")!;

      expect((await connectorStatuses(store)).find((c) => c.id === "foreplay")!.connected).toBe(false);
      await expect(finishConnector(store, "wrong-state", "good-code", CALLBACK)).rejects.toThrow("expired");
      const c = await finishConnector(store, state, "good-code", CALLBACK);
      expect(c.id).toBe("foreplay");

      const status = (await connectorStatuses(store)).find((x) => x.id === "foreplay")!;
      expect(status).toMatchObject({ connected: true, problem: null });
      expect(JSON.stringify(await connectorStatuses(store))).not.toContain("at-");
      expect(statSync(path).mode & 0o777).toBe(0o600);

      const servers = await connectorMcpServers(store, ["competitor_research"], CALLBACK);
      expect(servers.foreplay).toEqual({ type: "http", url: `${base}/mcp`, headers: { Authorization: `Bearer ${issued.at(-1)}` } });
      // Not used for other jobs.
      expect(await connectorMcpServers(store, ["video_generation"], CALLBACK)).toEqual({});
      // The state is single-use.
      await expect(finishConnector(store, state, "good-code", CALLBACK)).rejects.toThrow();

      await disconnectConnector(store, "foreplay");
      expect(await connectorMcpServers(store, ["competitor_research"], CALLBACK)).toEqual({});
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a token close to expiry is refreshed before an agent uses it", async () => {
    const { store, dir } = tempStore();
    try {
      expiresIn = 60; // already inside the refresh margin
      const { authorizeUrl } = await beginConnector(store, foreplay, CALLBACK, null);
      await finishConnector(store, new URL(authorizeUrl).searchParams.get("state"), "good-code", CALLBACK);
      const first = (await store.get("foreplay"))!.tokens!.access_token;
      expiresIn = 3600;
      const servers = await connectorMcpServers(store, ["competitor_research"], CALLBACK);
      const refreshed = (await store.get("foreplay"))!.tokens!.access_token;
      expect(refreshed).not.toBe(first);
      expect((servers.foreplay as { headers: Record<string, string> }).headers.Authorization).toBe(`Bearer ${refreshed}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a bad code is reported, not silently accepted", async () => {
    const { store, dir } = tempStore();
    try {
      const { authorizeUrl } = await beginConnector(store, foreplay, CALLBACK, null);
      await expect(finishConnector(store, new URL(authorizeUrl).searchParams.get("state"), "bad-code", CALLBACK)).rejects.toThrow("didn't finish");
      const status = (await connectorStatuses(store)).find((c) => c.id === "foreplay")!;
      expect(status.connected).toBe(false);
      expect(status.problem).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
