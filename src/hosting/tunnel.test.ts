import { describe, expect, test } from "bun:test";
import { openTunnel, type TunnelProcess } from "./tunnel";

/** The EAS tunnel (hosting/tunnel.ts) against a fake cloudflared: the address read from its log, health waited for, closed (killed) once. */

function proc(lines: string[], o: { hang?: boolean } = {}): TunnelProcess & { killed: number } {
  let resolveExit: (n: number) => void = () => undefined;
  const p = {
    killed: 0,
    exited: new Promise<number>((r) => (resolveExit = r)),
    kill: () => {
      p.killed++;
      resolveExit(0);
    },
    lines: (async function* () {
      for (const l of lines) yield l;
      if (o.hang) await new Promise(() => undefined);
    })(),
  };
  return p;
}

describe("the quick tunnel", () => {
  test("opens to 127.0.0.1:<port> only, reads the trycloudflare address, waits until it answers, closes once", async () => {
    const seen: string[][] = [];
    const p = proc(["INF Requesting new quick Tunnel on trycloudflare.com...", "INF |  https://brave-otter-12.trycloudflare.com  |", "INF Registered tunnel connection"], { hang: true });
    let calls = 0;
    const t = await openTunnel(55400, {
      has: () => true,
      spawn: (cmd) => (seen.push(cmd), p),
      fetch: (async (url: string) => (calls++, new Response("", { status: calls < 3 ? 530 : 401, headers: { "x-url": url } }))) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    expect(seen[0]).toEqual(["cloudflared", "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:55400"]);
    expect(t.url).toBe("https://brave-otter-12.trycloudflare.com");
    expect(calls).toBe(3);
    await t.close();
    await t.close();
    expect(p.killed).toBe(1);
  });

  test("no cloudflared: an install hint, nothing started; no address in time or cloudflared exits: an error and the process is killed", async () => {
    let spawned = 0;
    await expect(openTunnel(55400, { has: () => false, spawn: () => (spawned++, proc([])) })).rejects.toMatchObject({ code: "no_tunnel", hints: [expect.stringContaining("cloudflared")] });
    expect(spawned).toBe(0);
    const hang = proc(["INF starting"], { hang: true });
    await expect(openTunnel(55400, { has: () => true, spawn: () => hang, timeoutMs: 30 })).rejects.toThrow(/in time/);
    expect(hang.killed).toBe(1);
    const quit = proc(["ERR failed"]);
    await expect(openTunnel(55400, { has: () => true, spawn: () => quit })).rejects.toThrow(/stopped before/);
    expect(quit.killed).toBe(1);
    await expect(openTunnel(22, { has: () => true, spawn: () => proc([]) })).rejects.toThrow(/Not a port/);
  });
});
