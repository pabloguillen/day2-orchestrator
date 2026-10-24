/**
 * Where each user is in their life with the app, and who gets a treatment.
 *
 * Shared, unchanged, by the device library, the app's own backend (via
 * `day2/retention.js`) and day2's server, so all three agree on a user's
 * state and on who is held out. Pure functions, no dependencies.
 *
 * The model is Duolingo's: every user is in exactly one state at any time.
 * What differs per product is the rhythm — "away for a while" means a day
 * for a daily habit and weeks for a trip-splitting app.
 */

export type Rhythm = "daily" | "weekly" | "monthly";

/** period: "now" · short: recently · long: still remembered. Days. */
export const WINDOWS: Record<Rhythm, { period: number; short: number; long: number }> = {
  daily: { period: 1, short: 7, long: 30 },
  weekly: { period: 7, short: 28, long: 90 },
  monthly: { period: 30, short: 90, long: 180 },
};

export type LifecycleState =
  /** First activity ever, in this period. */
  | "new"
  /** Active now, and also shortly before. */
  | "current"
  /** Active now after a short break. */
  | "reactivated"
  /** Active now after a long break. */
  | "resurrected"
  /** Not active now, but shortly before. */
  | "at_risk"
  /** Not active recently, but within the long window. */
  | "lapsing"
  /** Away longer than the long window. */
  | "dormant";

export const ACTIVE_STATES: LifecycleState[] = ["new", "current", "reactivated", "resurrected"];
const DAY = 86_400_000;

/**
 * The state at `now` from the times the user was active (any order).
 * `firstSeen` is the user's first activity ever, when it's older than the
 * history passed in (e.g. events are kept 180 days).
 */
export function stateOf(active: Array<number | string | Date>, now: number | Date, rhythm: Rhythm, firstSeen?: number | string | Date): LifecycleState | null {
  const t = (x: number | string | Date) => (typeof x === "number" ? x : new Date(x).getTime());
  const at = t(now);
  const w = WINDOWS[rhythm];
  const times = active.map(t).filter((x) => x <= at);
  if (!times.length) return null;
  const first = Math.min(...times, firstSeen !== undefined ? t(firstSeen) : Infinity);
  const periodStart = at - w.period * DAY;
  const shortStart = at - w.short * DAY;
  const longStart = at - w.long * DAY;
  const nowActive = times.some((x) => x > periodStart);
  const before = times.filter((x) => x <= periodStart);
  const lastBefore = before.length ? Math.max(...before) : null;
  if (nowActive) {
    if (first > periodStart) return "new";
    // Seen before, but longer ago than the history passed in.
    if (lastBefore === null) return "resurrected";
    if (lastBefore > shortStart) return "current";
    if (lastBefore > longStart) return "reactivated";
    return "resurrected";
  }
  const last = Math.max(...times);
  if (last > shortStart) return "at_risk";
  if (last > longStart) return "lapsing";
  return "dormant";
}

/**
 * Whether one more reminder (push, email) may go out. Duolingo's lesson:
 * reminders nobody answers teach people to turn them all off. So: at most
 * one per period, and none after `maxUnanswered` sent since the user was
 * last active — the next activity resets it.
 */
export function mayNudge(input: {
  sent: Array<number | string | Date>;
  lastActive: number | string | Date | null;
  now: number | Date;
  rhythm: Rhythm;
  maxUnanswered?: number;
}): boolean {
  const t = (x: number | string | Date) => (typeof x === "number" ? x : new Date(x).getTime());
  const at = t(input.now);
  const since = input.lastActive === null ? -Infinity : t(input.lastActive);
  const sent = input.sent.map(t).filter((x) => x <= at);
  if (sent.some((x) => x > at - WINDOWS[input.rhythm].period * DAY)) return false;
  return sent.filter((x) => x > since).length < (input.maxUnanswered ?? 3);
}

// ---------------------------------------------------------------------------
// Holdouts: a fixed share of users never gets a treatment, so its effect can
// be measured instead of guessed. Decided by the user id alone, the same on
// every device and server, without a network call.
// ---------------------------------------------------------------------------

export const DEFAULT_HOLDOUT = 0.1;

/** "on" gets the treatment; "holdout" doesn't. Users day2 can't identify always get it. */
export function arm(user: string | null | undefined, treatment: string, holdout = DEFAULT_HOLDOUT): "on" | "holdout" {
  if (!user) return "on";
  const h = sha256(`${user}:${treatment}`);
  return parseInt(h.slice(0, 8), 16) / 0x1_0000_0000 < holdout ? "holdout" : "on";
}

/**
 * The id day2 sees for a user: a hash of the app's own user id, salted with
 * the app's key so the same person can't be linked across apps. Never the
 * id, email or name itself.
 */
export function hashUser(appKey: string, userId: string): string {
  return `u_${sha256(`${appKey}:${userId}`).slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// SHA-256 (synchronous: React Native has no crypto.subtle, and holdouts must
// be decided without waiting).
// ---------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

export function sha256(text: string): string {
  const msg = utf8(text);
  const len = ((msg.length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(len);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const bits = msg.length * 8;
  const view = new DataView(buf.buffer);
  view.setUint32(len - 8, Math.floor(bits / 0x1_0000_0000));
  view.setUint32(len - 4, bits >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < len; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15]!;
      const b = W[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (h! + S1 + ch + K[i]! + W[i]!) >>> 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]! + a!) >>> 0;
    H[1] = (H[1]! + b!) >>> 0;
    H[2] = (H[2]! + c!) >>> 0;
    H[3] = (H[3]! + d!) >>> 0;
    H[4] = (H[4]! + e!) >>> 0;
    H[5] = (H[5]! + f!) >>> 0;
    H[6] = (H[6]! + g!) >>> 0;
    H[7] = (H[7]! + h!) >>> 0;
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, "0")).join("");
}
