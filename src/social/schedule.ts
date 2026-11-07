import type { SocialPlatform, TimeSlot } from "./types";

/**
 * When a post goes out. Until an app has its own results, a heuristic per
 * platform for a young audience (after school / evenings, a bit later on
 * TikTok, lunchtime and evening on Facebook), in the audience's time zone;
 * once a time slot has at least MIN_POSTS measured posts, the slot whose
 * posts got the most engagement per view wins (a little exploration stays).
 */

export const SLOT_HOUR: Record<TimeSlot, number> = { morning: 8, midday: 12, afternoon: 16, evening: 19, late: 21 };
const DEFAULT_SLOT: Record<SocialPlatform, { weekday: TimeSlot; weekend: TimeSlot }> = {
  instagram: { weekday: "evening", weekend: "midday" },
  tiktok: { weekday: "evening", weekend: "afternoon" },
  facebook: { weekday: "midday", weekend: "midday" },
};
export const MIN_POSTS = 3;

/** The audience's time zone from the app's language/market. */
export function audienceTimeZone(language: string, country?: string | null): string {
  const c = (country ?? "").toUpperCase();
  const byCountry: Record<string, string> = { DE: "Europe/Berlin", AT: "Europe/Vienna", CH: "Europe/Zurich", FR: "Europe/Paris", ES: "Europe/Madrid", IT: "Europe/Rome", NL: "Europe/Amsterdam", GB: "Europe/London", US: "America/New_York", BR: "America/Sao_Paulo" };
  if (byCountry[c]) return byCountry[c]!;
  const byLang: Record<string, string> = { de: "Europe/Berlin", fr: "Europe/Paris", es: "Europe/Madrid", it: "Europe/Rome", nl: "Europe/Amsterdam", pt: "Europe/Lisbon", pl: "Europe/Warsaw", en: "Europe/London" };
  return byLang[language.slice(0, 2).toLowerCase()] ?? "UTC";
}

/** Hour, weekday and date parts of `d` in `tz`. */
function partsIn(d: Date, tz: string): { y: number; m: number; day: number; h: number; min: number; weekday: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday ?? "Mon");
  return { y: Number(p.year), m: Number(p.month), day: Number(p.day), h: Number(p.hour), min: Number(p.minute), weekday: wd };
}

/** The UTC instant of a wall-clock time in `tz` (DST-safe to the hour). */
export function zonedTime(y: number, m: number, day: number, hour: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, day, hour, 0, 0));
  const p = partsIn(guess, tz);
  const shownAsUtc = Date.UTC(p.y, p.m - 1, p.day, p.h, p.min);
  return new Date(guess.getTime() - (shownAsUtc - guess.getTime()));
}

export type SlotStats = Partial<Record<TimeSlot, { posts: number; score: number }>>;

/** The slot for a platform: the app's best measured one when there's enough, else the heuristic. Pure. */
export function pickSlot(platform: SocialPlatform, weekend: boolean, stats: SlotStats | undefined, rng: () => number = Math.random): { slot: TimeSlot; why: string } {
  const measured = Object.entries(stats ?? {}).filter(([, s]) => s && s.posts >= MIN_POSTS) as Array<[TimeSlot, { posts: number; score: number }]>;
  if (measured.length >= 2 && rng() > 0.15) {
    const [slot] = measured.sort((a, b) => b[1].score / b[1].posts - a[1].score / a[1].posts)[0]!;
    return { slot, why: `Your posts at this time did best so far (${measured.length} times of day compared).` };
  }
  const d = DEFAULT_SLOT[platform];
  const slot = weekend ? d.weekend : d.weekday;
  return { slot, why: measured.length ? "A usual good time for this audience; day2 is still comparing times of day." : "A usual good time for a young audience on this platform; day2 switches to your own best time once it has results." };
}

/**
 * The next good time at least `minLeadMs` from now (so the owner has time
 * to look), avoiding a day that already has `busyDays` posts. Pure given `now`.
 */
export function nextPostTime(o: { platform: SocialPlatform; tz: string; now: Date; stats?: SlotStats; minLeadMs?: number; busyDays?: Set<string>; rng?: () => number }): { at: Date; slot: TimeSlot; why: string } {
  const lead = o.minLeadMs ?? 3 * 3_600_000;
  for (let add = 0; add < 14; add++) {
    const day = new Date(o.now.getTime() + add * 86_400_000);
    const p = partsIn(day, o.tz);
    const key = `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    if (o.busyDays?.has(key)) continue;
    const weekend = p.weekday === 0 || p.weekday === 6;
    const { slot, why } = pickSlot(o.platform, weekend, o.stats, o.rng);
    const at = zonedTime(p.y, p.m, p.day, SLOT_HOUR[slot], o.tz);
    if (at.getTime() - o.now.getTime() >= lead) return { at, slot, why };
  }
  return { at: new Date(o.now.getTime() + 86_400_000), slot: "evening", why: "The next free day." };
}

/** Which slot a time falls in, in `tz`. */
export function slotOf(at: Date, tz: string): TimeSlot {
  const h = partsIn(at, tz).h;
  if (h < 10) return "morning";
  if (h < 14) return "midday";
  if (h < 18) return "afternoon";
  if (h < 21) return "evening";
  return "late";
}
export const dayKeyIn = (at: Date, tz: string) => {
  const p = partsIn(at, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};
