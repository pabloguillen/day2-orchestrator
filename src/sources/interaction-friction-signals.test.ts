import { afterEach, describe, expect, test } from "bun:test";
import { fetchFrictionSignals } from "./interaction-friction-signals";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchFrictionSignals", () => {
  test("maps the generic endpoint's aggregate signals into Signal objects", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      expect(String(url)).toBe("https://app-one.example.com/api/day2-friction-signals");
      return new Response(
        JSON.stringify({
          signals: [
            {
              target: "id:save",
              path: "/checkout",
              occurrences: 7,
              affectedDevices: 4,
              firstSeen: "2026-01-01T00:00:00.000Z",
              lastSeen: "2026-01-03T00:00:00.000Z",
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const signals = await fetchFrictionSignals("app-one", "https://app-one.example.com");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      source: "interaction-friction",
      appId: "app-one",
      occurrences: 7,
      affectedUsers: 4,
      path: "/checkout",
    });
    expect(signals[0]!.finding).toContain("id:save");
  });

  test("works for a second, different app by URL alone — no app-specific code path", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      expect(String(url)).toBe("https://app-two.example.com/api/day2-friction-signals");
      return new Response(JSON.stringify({ signals: [] }), { status: 200 });
    }) as typeof fetch;

    const signals = await fetchFrictionSignals("app-two", "https://app-two.example.com");
    expect(signals).toEqual([]);
  });

  test("throws on a non-ok response rather than silently returning nothing", async () => {
    globalThis.fetch = (async () => new Response("", { status: 503 })) as typeof fetch;
    await expect(fetchFrictionSignals("app-one", "https://app-one.example.com")).rejects.toThrow("503");
  });
});
