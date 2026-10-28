import type { Asset, LaunchSpec } from "./types";

/**
 * A scripted fake fetch for adapter tests: each expected call is matched in
 * order by method + URL substring, records what was sent, and answers with
 * the given JSON. Unexpected calls fail the test with a clear message.
 */
export type Expect = {
  method?: string;
  /** Substring (or regex) the URL must contain/match. */
  url: string | RegExp;
  /** Optional check on the request; throw to fail. */
  check?: (req: Recorded) => void;
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
};

export type Recorded = { method: string; url: string; headers: Record<string, string>; body: string | FormData | Uint8Array | null; json: unknown };

export function scriptedFetch(script: Expect[]) {
  const calls: Recorded[] = [];
  let i = 0;
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = (init?.body ?? null) as Recorded["body"];
    let json: unknown = null;
    if (typeof body === "string") {
      try {
        json = JSON.parse(body);
      } catch {
        json = Object.fromEntries(new URLSearchParams(body));
      }
    }
    const rec: Recorded = { method, url, headers, body, json };
    calls.push(rec);
    const e = script[i++];
    if (!e) throw new Error(`Unexpected call #${i}: ${method} ${url}`);
    const urlOk = typeof e.url === "string" ? url.includes(e.url) : e.url.test(url);
    if (!urlOk || (e.method && e.method.toUpperCase() !== method)) throw new Error(`Call #${i}: expected ${e.method ?? "*"} ${e.url}, got ${method} ${url}`);
    e.check?.(rec);
    const text = e.text ?? (e.json === undefined ? "" : JSON.stringify(e.json));
    return new Response(text, { status: e.status ?? 200, headers: { "content-type": "application/json", ...(e.headers ?? {}) } });
  }) as typeof fetch;
  return { fetch: fn, calls, done: () => i === script.length, remaining: () => script.slice(i) };
}

export const noSleep = async () => {};

export function testAsset(over: Partial<Asset> = {}): Asset {
  return {
    id: "as_video1",
    kind: "video",
    ratio: "9:16",
    width: 1080,
    height: 1920,
    durationSec: 15,
    mime: "video/mp4",
    bytes: 1_200_000,
    path: "/tmp/does-not-matter.mp4",
    url: "https://day2.example/api/assets/as_video1.mp4",
    source: "screen_recording",
    aiGenerated: false,
    aiPerson: false,
    thumbnail: {
      id: "as_thumb1",
      kind: "image",
      ratio: "9:16",
      width: 1080,
      height: 1920,
      mime: "image/jpeg",
      bytes: 90_000,
      path: "/tmp/thumb.jpg",
      url: "https://day2.example/api/assets/as_thumb1.jpg",
      source: "screen_recording",
      aiGenerated: false,
      aiPerson: false,
    },
    ...over,
  };
}

export function testImage(over: Partial<Asset> = {}): Asset {
  return {
    id: "as_img1",
    kind: "image",
    ratio: "1:1",
    width: 1080,
    height: 1080,
    mime: "image/png",
    bytes: 300_000,
    path: "/tmp/img.png",
    url: "https://day2.example/api/assets/as_img1.png",
    source: "template",
    aiGenerated: false,
    aiPerson: false,
    ...over,
  };
}

export function testSpec(over: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    appId: "app_1",
    appName: "Buddy",
    campaignName: "day2 Buddy B-4",
    link: "https://buddy.example/go/split?d2=B-4.x",
    dailyBudgetUsd: 20,
    targeting: { countries: ["DE"], languages: ["de"], ageMin: 18, audience: "consumer", interests: ["travel"], keywords: ["split bills app"] },
    creatives: [{ key: "B-4-v1", copy: { headline: "Split a dinner bill in 10 seconds", body: "Add the bill, pick who was there, done.", description: "Free for groups", cta: "sign_up" }, asset: testAsset() }],
    identity: null,
    aiContent: false,
    ...over,
  };
}
