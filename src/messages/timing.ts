/**
 * When a push may go out, in the user's own local time:
 *  - never in quiet hours (21:00–09:00 by default);
 *  - at the user's usual active hour when day2 knows it (from when their
 *    events arrive), else as soon as quiet hours are over;
 *  - spread over the first half hour so a whole audience doesn't land in
 *    the same minute.
 * Pure functions; DST-safe because local time is always read through Intl.
 */

export type Zone = { tz: string | null; tzOffset: number | null };
export type QuietHours = { start: number; end: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(tz, f);
  }
  return f;
}

/** Local hour and minute at `at` in the zone (IANA zone first, then offset, else UTC). */
export function localTime(at: Date, zone: Zone): { hour: number; minute: number } {
  if (zone.tz) {
    try {
      const parts = formatter(zone.tz).formatToParts(at);
      const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
      return { hour: n("hour") % 24, minute: n("minute") };
    } catch {
      // fall through to the offset
    }
  }
  const t = new Date(at.getTime() + (zone.tzOffset ?? 0) * 60_000);
  return { hour: t.getUTCHours(), minute: t.getUTCMinutes() };
}

export function isQuiet(hour: number, q: QuietHours): boolean {
  if (q.start === q.end) return false;
  return q.start > q.end ? hour >= q.start || hour < q.end : hour >= q.start && hour < q.end;
}

const STEP = 5 * 60_000;
const jitterOf = (seed: string) => {
  let h = 0;
  for (const c of seed) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  return h % 30;
};

/**
 * The next moment at or after `now` this user may get a push. With a
 * usual hour, the next time it's that hour locally (within ~a day);
 * otherwise now, or the end of quiet hours.
 */
export function nextSendAt(now: Date, zone: Zone, quiet: QuietHours, usualHour: number | null, seed: string): Date {
  const jitter = jitterOf(seed);
  const start = Math.ceil(now.getTime() / STEP) * STEP;
  const usual = usualHour !== null && !isQuiet(usualHour, quiet) ? usualHour : null;
  if (usual !== null) {
    for (let t = start; t < start + 26 * 3_600_000; t += STEP) {
      const l = localTime(new Date(t), zone);
      if (l.hour === usual && l.minute >= jitter) return new Date(t);
    }
  }
  if (!isQuiet(localTime(now, zone).hour, quiet)) return now;
  for (let t = start; t < start + 26 * 3_600_000; t += STEP) {
    if (!isQuiet(localTime(new Date(t), zone).hour, quiet)) return new Date(t + jitter * 60_000);
  }
  return now;
}

/**
 * The local hour a user is most often active in, from the times of their
 * events — when at least 3 events fall in that hour and it isn't in quiet
 * hours. Null when it isn't clear.
 */
export function usualHour(times: string[], zone: Zone, quiet: QuietHours): number | null {
  const counts = new Array<number>(24).fill(0);
  for (const at of times) counts[localTime(new Date(at), zone).hour]! += 1;
  let best = -1;
  for (let h = 0; h < 24; h++) if (!isQuiet(h, quiet) && counts[h]! >= 3 && (best < 0 || counts[h]! > counts[best]!)) best = h;
  return best < 0 ? null : best;
}

const GERMAN_ZONES = new Set(["Europe/Berlin", "Europe/Vienna", "Europe/Zurich", "Europe/Busingen", "Europe/Vaduz", "Europe/Luxembourg"]);

/** A guess at the language when the app didn't send one: German-speaking zones → "de". */
export function localeFromZone(tz: string | null): "de" | null {
  return tz && GERMAN_ZONES.has(tz) ? "de" : null;
}
