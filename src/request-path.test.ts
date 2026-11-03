import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleRequest } from "./api-server";
import { pathProblem, PUBLIC_PATH, PUBLIC_PATH_SOURCE, rawPath } from "./request-path";

const KEY = "d2k_qodmrFihh_VU5JJgYrl-Nrns";

describe("request paths that change when normalized are refused", () => {
  test("encoded dots, slashes and backslashes, dot segments, backslashes", () => {
    for (const p of [
      "/api/ingest/%2e%2e/apps",
      "/api/ingest/%2E%2E/%2e%2e/api/apps",
      "/api/store-notify/%2e%2e/apps/x/money/settings",
      "/api/ingest/..%2fapps",
      "/api/ingest/..%2Fapps",
      "/api/ingest/x%5c..%5capps",
      "/api/ingest/../apps",
      "/api/ingest/./x",
      "/api/ingest/a\\..\\apps",
    ]) {
      expect([p, pathProblem(`http://localhost:4700${p}`)]).not.toEqual([p, null]);
      expect(pathProblem(p)).not.toBeNull(); // a bare request-target too
    }
  });

  test("plain paths pass, query strings don't matter", () => {
    for (const p of [`/api/ingest/${KEY}`, `/api/ingest/${KEY}/config?p=ios&r=1.2.0`, "/api/apps", "/api/apps/a1/live/values/onboarding.title", "/api/assets/as_abc.png", "/", "/api/x?next=../y"]) {
      expect([p, pathProblem(`http://localhost:4700${p}`)]).toEqual([p, null]);
    }
    expect(rawPath("http://h:1/a/b?c=../d#e")).toBe("/a/b");
  });

  test("handleRequest answers 400 before routing", async () => {
    const res = await handleRequest(new Request("http://localhost:4700/api/ingest/..%2fapps"));
    expect(res.status).toBe(400);
  });
});

describe("the tunnel's public paths", () => {
  const script = readFileSync(join(import.meta.dir, "..", "deploy", "tunnel", "day2-tunnel.sh"), "utf-8");
  const tunnel = /^\s+path: (.+)$/m.exec(script)?.[1];

  test("the tunnel and day2 use the same list", () => {
    expect(tunnel).toBe(PUBLIC_PATH_SOURCE);
  });

  test("every public path still matches; nothing that climbs out of one does", () => {
    const re = new RegExp(tunnel!);
    for (const p of [
      "/api/ads/connect/callback/meta",
      "/api/assets/as_abcdefghijklmnopqrstuvwx.mp4",
      "/api/assets/as_abcdefghijklmnopqrstuvwx",
      "/api/l/app_dotty",
      "/api/l/app_dotty/handoff.js",
      `/api/ingest/${KEY}`,
      `/api/ingest/${KEY}/config`,
      `/api/ingest/${KEY}/contracts`,
      `/api/ingest/${KEY}/push`,
      "/api/store-notify/apple/app_dotty",
      "/api/store-notify/google/app_dotty",
      "/api/store-notify/revenuecat/app_dotty",
    ]) {
      expect([p, re.test(p)]).toEqual([p, true]);
      expect(PUBLIC_PATH.test(p)).toBe(true);
    }
    for (const p of [
      "/api/ingest/%2e%2e/apps",
      "/api/ingest/../apps",
      "/api/ingest/..%2fapps",
      `/api/ingest/${KEY}/../../apps`,
      `/api/ingest/${KEY}/other`,
      "/api/ingest/apps",
      "/api/assets/..",
      "/api/assets/.%2e",
      "/api/store-notify/%2e%2e/apps",
      "/api/store-notify/apple/app/../../apps",
      "/api/l/a%2f..",
      "/api/apps",
    ]) {
      expect([p, re.test(p)]).toEqual([p, false]);
    }
  });

  test("locally, what came through Cloudflare only reaches the public paths (whatever the tunnel let through)", async () => {
    // What Bun makes of /api/ingest/%2e%2e/apps:
    const res = await handleRequest(new Request("http://localhost:4700/api/apps", { headers: { "cf-connecting-ip": "203.0.113.1", "cf-ray": "x" } }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found." });
    // A public path through Cloudflare is handled as usual (an unknown key here).
    const ingest = await handleRequest(new Request(`http://localhost:4700/api/ingest/d2k_${"z".repeat(24)}/config`, { headers: { "cf-ray": "x" } }));
    expect(ingest.status).toBe(404);
    expect(await ingest.json()).toEqual({ error: "Unknown key." });
    // Directly on this computer: the console's API as usual.
    expect((await handleRequest(new Request("http://localhost:4700/api/apps"))).status).toBe(200);
  });
});
