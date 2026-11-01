/** Runs a command with a time limit; never throws (the caller decides what a failure means). */
export async function runCmd(cmd: string[], o: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {}): Promise<{ code: number; out: string; err: string; timedOut: boolean }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, { cwd: o.cwd, env: { ...process.env, ...o.env } as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    return { code: 127, out: "", err: (err as Error).message, timedOut: false };
  }
  let timedOut = false;
  const timer = o.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, o.timeoutMs)
    : null;
  const [out, err] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  return { code, out, err, timedOut };
}

export const has = (bin: string) => Bun.which(bin) !== null;

/** The last lines of a command's output, for a reason on the ticket. */
export const tail = (s: string, n = 6) => s.trim().split("\n").slice(-n).join(" ").slice(0, 600);
