/**
 * Stage signals (active users, retention) for growth-strategy.ts, from what
 * day2 itself sees first: the field store the day2 library reports into
 * (users, events) and the retention engine (retention.ts). An app's own
 * `/api/day2-stats` (only the old web demo had one) is an optional extra:
 * a 404 or a network error is ignored, never thrown — a mobile app on a
 * static site (Netlify) simply doesn't have it.
 *
 * With neither field data nor stats, the stage is "launch" with a basis that
 * says so ("no usage data yet") — an explicit default, never a silent one.
 */

import type { FieldStore } from "./field-store";
import { SIM_DEVICE_PREFIX } from "./field-store";
import type { StageSignals } from "./growth-strategy";
import { computeSnapshot, historyDays, rhythmFromUsage, type RetentionSnapshot } from "./retention";
import { WINDOWS, type Rhythm } from "../packages/sensors/src/lifecycle";

const DAY = 86_400_000;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
export const STATS_TIMEOUT_MS = 10_000;
export const NO_USAGE_BASIS = "no usage data yet — no day2 field events from the app and no /api/day2-stats endpoint; defaulting to launch until people use it.";

/** A remote error body, cut to fit a log line (a 404 page is a whole HTML document). */
export function clip(text: string, max = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** An app's `/api/day2-stats`, or null when it has none / can't be reached / answers nonsense. Never throws. */
export async function fetchDay2Stats(
  appBaseUrl: string,
  opts: { fetchFn?: typeof fetch; log?: (msg: string) => void; timeoutMs?: number } = {},
): Promise<{ activeUsers: number; retentionSignal: number | null } | null> {
  const f = opts.fetchFn ?? fetch;
  const log = opts.log ?? (() => {});
  const url = `${appBaseUrl.replace(/\/+$/, "")}/api/day2-stats`;
  try {
    const res = await f(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? STATS_TIMEOUT_MS) });
    if (!res.ok) {
      // 404 is the normal case for apps without this endpoint: not worth a log line.
      if (res.status !== 404) log(`day2-stats ${url}: ${res.status} ${clip(await res.text().catch(() => ""))}`);
      return null;
    }
    const body = (await res.json()) as { activeUsers?: unknown; retentionSignal?: unknown };
    if (typeof body.activeUsers !== "number" || !Number.isFinite(body.activeUsers) || body.activeUsers < 0) return null;
    const r = body.retentionSignal;
    return { activeUsers: body.activeUsers, retentionSignal: typeof r === "number" && Number.isFinite(r) ? r : null };
  } catch (err) {
    log(`day2-stats ${url}: ${clip((err as Error).message ?? String(err))}`);
    return null;
  }
}

export type FieldStageSignals = { activeUsers: number; retentionSignal: number | null; rhythm: Rhythm; windowDays: number; snapshot: RetentionSnapshot | null };

/**
 * Active users over the app's rhythm window (WINDOWS[rhythm].short: 7 days
 * for a daily app, 28 weekly, 90 monthly — "used it recently"), counting an
 * identified user once and an unidentified device once; and retention as
 * the share of current users who came back in the last full period (the
 * retention engine's `rates.current`, null while too few to say). Null when
 * day2 has no field data for the app at all.
 */
export async function fieldStageSignals(
  store: Pick<FieldStore, "activity" | "events" | "retention">,
  appId: string,
  now: Date = new Date(),
): Promise<FieldStageSignals | null> {
  const stored = await store.retention(appId).catch(() => null);
  const t = now.getTime();
  // Enough history for a snapshot at the slowest rhythm the app might have.
  const history = await store.activity(appId, dayOf(t - historyDays(stored?.rhythm ?? "monthly") * DAY));
  const rhythm: Rhythm = stored?.rhythm ?? rhythmFromUsage(history.users, now) ?? "weekly";
  const windowDays = WINDOWS[rhythm].short;
  const since = dayOf(t - windowDays * DAY);
  const events = await store.events(appId, new Date(t - windowDays * DAY));

  const deviceUser = new Map<string, string>();
  for (const e of events) if (e.userId && !deviceUser.has(e.deviceId)) deviceUser.set(e.deviceId, e.userId);
  const active = new Set<string>();
  for (const u of history.users) if (u.days.some((d) => d >= since)) active.add(`u:${u.user}`);
  for (const e of events) {
    if (e.deviceId.startsWith(SIM_DEVICE_PREFIX)) continue;
    if ((e as { props?: { by?: unknown } }).props?.by === "store") continue;
    const user = e.userId ?? deviceUser.get(e.deviceId);
    active.add(user ? `u:${user}` : `d:${e.deviceId}`);
  }

  const hasData = active.size > 0 || history.users.length + history.older > 0 || (stored != null && stored.users > 0);
  if (!hasData) return null;
  const snapshot = stored ?? (history.users.length ? computeSnapshot({ ...history, productType: null, now }) : null);
  return { activeUsers: active.size, retentionSignal: snapshot?.rates.current ?? null, rhythm, windowDays, snapshot };
}

/**
 * The stage signals for an app: field data first, then `/api/day2-stats`
 * when the app has a web address (and the endpoint), else an explicit
 * "no usage data yet". Never throws for a missing stats endpoint.
 */
export async function resolveStageSignals(input: {
  store: Pick<FieldStore, "activity" | "events" | "retention">;
  appId: string;
  appBaseUrl?: string | null;
  now?: Date;
  fetchFn?: typeof fetch;
  log?: (msg: string) => void;
}): Promise<StageSignals> {
  const log = input.log ?? ((m: string) => console.warn(m));
  const field = await fieldStageSignals(input.store, input.appId, input.now).catch((err) => {
    log(`stage signals: field data for ${input.appId} unreadable: ${clip((err as Error).message ?? String(err))}`);
    return null;
  });
  const stats = input.appBaseUrl ? await fetchDay2Stats(input.appBaseUrl, { fetchFn: input.fetchFn, log }) : null;

  if (field) {
    const activeUsers = Math.max(field.activeUsers, stats?.activeUsers ?? 0);
    const retentionSignal = field.retentionSignal ?? stats?.retentionSignal ?? null;
    const parts = [
      `day2 field data: ${field.activeUsers} active user${field.activeUsers === 1 ? "" : "s"} in the last ${field.windowDays} days (${field.rhythm} rhythm)`,
      field.retentionSignal === null ? "return rate not measurable yet" : `${Math.round(field.retentionSignal * 100)}% of current users came back last period`,
    ];
    if (stats) parts.push(`app's /api/day2-stats: ${stats.activeUsers} active users`);
    return { activeUsers, retentionSignal, source: `${parts.join("; ")}.` };
  }
  if (stats) return { ...stats, source: "the app's /api/day2-stats (no day2 field data yet)." };
  return { activeUsers: 0, retentionSignal: null, source: NO_USAGE_BASIS };
}
