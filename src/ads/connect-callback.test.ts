import { describe, expect, test } from "bun:test";
import { adsConnectCallback, isSlowCallbackPath, safeErrorLine } from "./connect-callback";
import { connect, GRAPH_CALL_TIMEOUT_MS, timed } from "./connect/meta";
import { PlatformError, type PlatformId } from "./types";
import { isAgentBackedPath } from "../api-server";

const isPlatform = (p: string): p is PlatformId => ["meta", "tiktok"].includes(p);
const CONSOLE = "https://console.example";
const started = async () => ({ id: "pend1", scope: { appId: "dotty" } as const, purpose: "social" });
const req = (qs = "state=st&code=SECRETCODE123") => new Request(`https://day2.example/api/ads/connect/callback/meta?${qs}`);
const errorOf = (r: Response) => new URL(r.headers.get("location")!).searchParams.get("connectError");

describe("ads sign-in callback", () => {
  test("success redirects to the page it started on", async () => {
    const r = await adsConnectCallback(req(), "meta", isPlatform, { consoleUrl: CONSOLE, started, finish: async () => ({ pendingId: "pend1", scope: { appId: "dotty" }, purpose: "social" }) });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`${CONSOLE}/apps/dotty/social?connect=pend1&platform=meta`);
  });

  test("a Graph error lands on the console as connectError, logged once without the code, pending dropped", async () => {
    const logs: string[] = [];
    const ended: string[] = [];
    const r = await adsConnectCallback(req(), "meta", isPlatform, {
      consoleUrl: CONSOLE,
      started,
      finish: async () => {
        throw new PlatformError("meta", "token exchange: Invalid verification code format. code=SECRETCODE123 access_token=EAAB123");
      },
      endPending: async (id) => void ended.push(id),
      log: (l) => logs.push(l),
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")!.startsWith(`${CONSOLE}/apps/dotty/social?platform=meta&connectError=`)).toBe(true);
    expect(errorOf(r)).toContain("Invalid verification code format");
    expect(logs).toHaveLength(1);
    for (const s of [logs[0]!, errorOf(r)!]) {
      expect(s).not.toContain("SECRETCODE123");
      expect(s).not.toContain("EAAB123");
    }
    expect(ended).toEqual(["pend1"]);
  });

  test("an exchange that takes too long redirects with a readable error instead of hanging", async () => {
    const logs: string[] = [];
    const t0 = Date.now();
    const r = await adsConnectCallback(req(), "meta", isPlatform, {
      consoleUrl: CONSOLE,
      started,
      finish: () => new Promise(() => {}),
      deadlineMs: 50,
      log: (l) => logs.push(l),
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(errorOf(r)).toContain("took longer than");
    expect(logs).toHaveLength(1);
  });

  test("a throwing pending lookup or a non-Error throw still redirects", async () => {
    const r = await adsConnectCallback(req(), "meta", isPlatform, {
      consoleUrl: CONSOLE,
      started: async () => {
        throw new Error("db down");
      },
      finish: async () => {
        throw "weird";
      },
      log: () => {},
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")!.startsWith(`${CONSOLE}/?platform=meta&connectError=weird`)).toBe(true);
  });

  test("the real Meta exchange: a timed-out fetch ends in connectError, not a dropped request", async () => {
    const hanging = ((_u: string, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const deps = timed({ fetch: hanging, sleep: async () => {} }, 30);
    const r = await adsConnectCallback(req(), "meta", isPlatform, {
      consoleUrl: CONSOLE,
      started,
      finish: async (_p, query) => {
        await connect.exchange({ appId: "a", appSecret: "s" }, { query, redirectUri: "https://day2.example/cb" }, deps);
        return { pendingId: "pend1", scope: { appId: "dotty" }, purpose: "social" };
      },
      log: () => {},
    });
    expect(errorOf(r)).toMatch(/token exchange/);
    expect(errorOf(r)).not.toContain("SECRETCODE123");
  });

  test("per-call timeout is applied to Graph fetches without a signal of their own", async () => {
    expect(GRAPH_CALL_TIMEOUT_MS).toBe(15_000);
    let seen: AbortSignal | undefined;
    const f = (async (_u: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return Response.json({});
    }) as unknown as typeof fetch;
    await timed({ fetch: f }).fetch!("https://graph.facebook.com/x");
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  test("Bun's idle timeout is lifted for GET sign-in callbacks (Meta, TikTok), not other GETs", () => {
    expect(isSlowCallbackPath("GET", "/api/ads/connect/callback/meta")).toBe(true);
    expect(isSlowCallbackPath("GET", "/api/ads/connect/callback/tiktok-content")).toBe(true);
    expect(isSlowCallbackPath("POST", "/api/ads/connect/callback/meta")).toBe(false);
    expect(isSlowCallbackPath("GET", "/api/apps/x/growth/ads")).toBe(false);
    expect(isAgentBackedPath("/api/ads/connect/callback/meta")).toBe(false);
  });

  test("safeErrorLine squeezes and redacts", () => {
    expect(safeErrorLine("a\n\n b  code=XYZ&state=1 Bearer abc.def")).toBe("a b code=[redacted]&state=1 Bearer [redacted]");
    expect(safeErrorLine("x".repeat(1000)).length).toBe(301);
  });
});
