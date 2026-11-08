/**
 * A short-lived public https address for one local port — for EAS captures,
 * whose cloud simulator can't reach this machine's temporary database
 * otherwise (docs/creative-quality.md §2b). A Cloudflare quick tunnel
 * (`cloudflared tunnel --url http://127.0.0.1:<port>`, no account, a random
 * trycloudflare.com name) for the temporary database's API port only; it
 * carries nothing but demo data and is closed in `finally` with the run.
 *
 * Not day2's own named tunnel (deploy/tunnel/day2-tunnel.sh), which serves
 * day2's public paths and is never pointed at a demo database.
 */

export type TunnelProcess = { lines: AsyncIterable<string>; kill: () => void; exited: Promise<number> };
export type TunnelDeps = {
  has: (bin: string) => boolean;
  spawn?: (cmd: string[]) => TunnelProcess;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the address (and then for it to answer). */
  timeoutMs?: number;
};
export type Tunnel = { url: string; close: () => Promise<void> };

export class TunnelError extends Error {
  code = "no_tunnel" as const;
  constructor(
    message: string,
    public hints: string[] = [],
  ) {
    super(message);
  }
}

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function bunSpawn(cmd: string[]): TunnelProcess {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  async function* lines(): AsyncIterable<string> {
    const dec = new TextDecoder();
    let buf = "";
    // cloudflared logs to stderr.
    for await (const chunk of p.stderr as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        yield buf.slice(0, i);
        buf = buf.slice(i + 1);
      }
    }
    if (buf) yield buf;
  }
  return { lines: lines(), kill: () => p.kill(), exited: p.exited };
}

/** The error when cloudflared isn't installed (null: it is). */
export function cloudflaredMissing(has: (bin: string) => boolean, platform = process.platform): TunnelError | null {
  return has("cloudflared") ? null : new TunnelError("EAS captures reach the temporary database through a short-lived Cloudflare tunnel, and cloudflared isn't installed here.", [platform === "darwin" ? "brew install cloudflared" : "Install cloudflared (pkg.cloudflare.com)"]);
}

/** Opens the quick tunnel to 127.0.0.1:<port> and waits until its address answers. */
export async function openTunnel(port: number, d: TunnelDeps, o: { healthPath?: string } = {}): Promise<Tunnel> {
  const missing = cloudflaredMissing(d.has);
  if (missing) throw missing;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new TunnelError(`Not a port day2 tunnels to: ${port}`);
  const proc = (d.spawn ?? bunSpawn)(["cloudflared", "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`]);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    proc.kill();
    await Promise.race([proc.exited.catch(() => 0), new Promise((r) => setTimeout(r, 5000))]);
  };
  const timeout = d.timeoutMs ?? 60_000;
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new TunnelError("cloudflared didn't give a tunnel address in time.")), timeout);
      void (async () => {
        try {
          for await (const line of proc.lines) {
            const m = QUICK_URL.exec(line);
            if (m) {
              clearTimeout(timer);
              resolve(m[0]);
              return;
            }
          }
          clearTimeout(timer);
          reject(new TunnelError("cloudflared stopped before giving a tunnel address."));
        } catch (err) {
          clearTimeout(timer);
          reject(new TunnelError(`cloudflared failed: ${(err as Error).message.slice(0, 160)}`));
        }
      })();
    });
    // A new quick tunnel takes a few seconds before its name resolves.
    const f = d.fetch ?? fetch;
    const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeout;
    for (;;) {
      const ok = await f(`${url}${o.healthPath ?? "/auth/v1/health"}`, { signal: AbortSignal.timeout(10_000) })
        .then(async (r) => (await r.body?.cancel().catch(() => undefined), r.status < 500))
        .catch(() => false);
      if (ok) break;
      if (Date.now() >= deadline) throw new TunnelError("The tunnel to the temporary database didn't answer in time.");
      await sleep(2000);
    }
    return { url, close };
  } catch (err) {
    await close();
    throw err instanceof TunnelError ? err : new TunnelError((err as Error).message);
  }
}
