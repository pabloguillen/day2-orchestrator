import { describe, expect, test } from "bun:test";
import { EXPO_RECEIPTS_URL, EXPO_SEND_URL, ExpoRequestError, getReceipts, ownerFix, sendPush, type ExpoMessage } from "./expo";

type Call = { url: string; headers: Record<string, string>; body: unknown };

function fakeExpo(answer: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url: string, init: RequestInit) => {
      const call = { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
      calls.push(call);
      return answer(call, calls.length);
    },
  };
}
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
const msg = (i: number): ExpoMessage => ({ to: `ExponentPushToken[t${i}]`, title: "Hi", body: "Body" });
const noSleep = { sleep: async () => {}, random: () => 0.5 };

describe("sendPush", () => {
  test("batches of 100, tickets in order, the access token as bearer", async () => {
    const x = fakeExpo((c) => ok((c.body as ExpoMessage[]).map((m, i) => (m.to.endsWith("[t5]") ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } : { status: "ok", id: `r-${i}` }))));
    const tickets = await sendPush(
      Array.from({ length: 205 }, (_, i) => msg(i)),
      { fetch: x.fetch, accessToken: "expo-token-123", ...noSleep },
    );
    expect(x.calls.map((c) => (c.body as unknown[]).length)).toEqual([100, 100, 5]);
    expect(x.calls[0]!.url).toBe(EXPO_SEND_URL);
    expect(x.calls[0]!.headers.authorization).toBe("Bearer expo-token-123");
    expect(tickets).toHaveLength(205);
    expect(tickets[5]).toEqual({ status: "error", message: "gone", error: "DeviceNotRegistered" });
    expect(tickets[6]).toEqual({ status: "ok", id: "r-6" });
  });
  test("no token: no authorization header", async () => {
    const x = fakeExpo(() => ok([{ status: "ok", id: "r" }]));
    await sendPush([msg(1)], { fetch: x.fetch, accessToken: null, ...noSleep });
    expect(x.calls[0]!.headers.authorization).toBeUndefined();
  });
  test("429 and 5xx are retried with backoff; then it gives up", async () => {
    const waits: number[] = [];
    const x = fakeExpo((_c, n) => (n < 3 ? new Response(JSON.stringify({ errors: [{ code: "TOO_MANY_REQUESTS" }] }), { status: 429 }) : ok([{ status: "ok", id: "r" }])));
    expect(await sendPush([msg(1)], { fetch: x.fetch, accessToken: null, sleep: async (ms) => void waits.push(ms), random: () => 0.5 })).toEqual([{ status: "ok", id: "r" }]);
    expect(waits).toEqual([1000, 2000]);
    const down = fakeExpo(() => new Response("", { status: 503 }));
    await expect(sendPush([msg(1)], { fetch: down.fetch, accessToken: null, ...noSleep })).rejects.toBeInstanceOf(ExpoRequestError);
    expect(down.calls).toHaveLength(4);
  });
  test("UNAUTHORIZED isn't retried", async () => {
    const x = fakeExpo(() => new Response(JSON.stringify({ errors: [{ code: "UNAUTHORIZED", message: "bad token" }] }), { status: 401 }));
    const err = await sendPush([msg(1)], { fetch: x.fetch, accessToken: "x", ...noSleep }).catch((e) => e as ExpoRequestError);
    expect(err).toBeInstanceOf(ExpoRequestError);
    expect((err as ExpoRequestError).code).toBe("UNAUTHORIZED");
    expect(x.calls).toHaveLength(1);
  });
  test("network errors are retried", async () => {
    let n = 0;
    const tickets = await sendPush([msg(1)], {
      fetch: async () => {
        if (++n === 1) throw new Error("ECONNRESET");
        return ok([{ status: "ok", id: "r" }]);
      },
      accessToken: null,
      ...noSleep,
    });
    expect(tickets[0]!.status).toBe("ok");
  });
});

test("getReceipts: ≤ 1000 ids per request; missing = not ready", async () => {
  const x = fakeExpo((c) => {
    const ids = (c.body as { ids: string[] }).ids;
    return ok(Object.fromEntries(ids.filter((id) => id !== "r-7").map((id) => [id, id === "r-3" ? { status: "error", message: "x", details: { error: "MessageTooBig" } } : { status: "ok" }])));
  });
  const r = await getReceipts(
    Array.from({ length: 1500 }, (_, i) => `r-${i}`),
    { fetch: x.fetch, accessToken: null, ...noSleep },
  );
  expect(x.calls.map((c) => (c.body as { ids: string[] }).ids.length)).toEqual([1000, 500]);
  expect(x.calls[0]!.url).toBe(EXPO_RECEIPTS_URL);
  expect(r["r-3"]).toEqual({ status: "error", message: "x", error: "MessageTooBig" });
  expect(r["r-7"]).toBeUndefined();
  expect(r["r-8"]).toEqual({ status: "ok" });
});

test("owner fixes in plain words", () => {
  expect(ownerFix("InvalidCredentials", "android")).toContain("FCM V1");
  expect(ownerFix("InvalidCredentials", "ios")).toContain("eas credentials");
  expect(ownerFix("UNAUTHORIZED", null)).toContain("access token");
  expect(ownerFix("DeviceNotRegistered", "ios")).toBeNull();
});
