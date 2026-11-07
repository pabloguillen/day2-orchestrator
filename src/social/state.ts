import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { SocialTrendInsight } from "../competitor-feed";
import type { SlotStats } from "./schedule";
import { DEFAULT_SOCIAL_SETTINGS, SOCIAL_PLATFORMS, type HookStyle, type SocialArm, type SocialPlatform, type SocialSettings, type Topic } from "./types";

/**
 * Per app, next to its other day2 files (`day2-social.json`): the kill
 * switch and platform choice, what day2 learned from the app's own posts
 * (hooks, topics, formats, times of day — fixed words and scores only), the
 * latest trend research, and a short log the Social page shows.
 * ("Posts go out on their own" lives in the autonomy settings.)
 */

export const SOCIAL_FILENAME = "day2-social.json";

export type Score = { posts: number; score: number };
export type SocialLearnings = {
  hooks: Partial<Record<HookStyle, Score>>;
  topics: Partial<Record<Topic, Score>>;
  formats: Partial<Record<SocialArm, Score>>;
  slots: Partial<Record<SocialPlatform, SlotStats>>;
  /** Engagement per view of this app's measured posts (7-day results), for "did well" / boost candidates. */
  rates: number[];
};

export type SocialState = {
  paused: boolean;
  platforms: SocialPlatform[] | null;
  /** The posts' language (ISO 639-1); null = from the app (guessLanguage). */
  language: string | null;
  learnings: SocialLearnings;
  trends: { at: string; items: SocialTrendInsight[] } | null;
  lastMadeAt: string | null;
  log: Array<{ at: string; text: string }>;
};

export const emptyLearnings = (): SocialLearnings => ({ hooks: {}, topics: {}, formats: {}, slots: {}, rates: [] });

export function loadSocialState(path: string): SocialState {
  const empty: SocialState = { paused: DEFAULT_SOCIAL_SETTINGS.paused, platforms: null, language: null, learnings: emptyLearnings(), trends: null, lastMadeAt: null, log: [] };
  if (!existsSync(path)) return empty;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<SocialState>;
    return {
      paused: raw.paused === true,
      platforms: Array.isArray(raw.platforms) ? raw.platforms.filter((p): p is SocialPlatform => (SOCIAL_PLATFORMS as readonly string[]).includes(p)) : null,
      language: typeof raw.language === "string" && /^[a-z]{2}$/.test(raw.language) ? raw.language : null,
      learnings: { ...emptyLearnings(), ...(raw.learnings ?? {}) },
      trends: raw.trends ?? null,
      lastMadeAt: raw.lastMadeAt ?? null,
      log: Array.isArray(raw.log) ? raw.log.slice(0, 50) : [],
    };
  } catch {
    return empty;
  }
}

export function saveSocialState(path: string, s: SocialState): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...s, log: s.log.slice(0, 50) }, null, 2)}\n`);
  renameSync(tmp, path);
}

export function updateSocialState(path: string, fn: (s: SocialState) => SocialState): SocialState {
  const next = fn(loadSocialState(path));
  saveSocialState(path, next);
  return next;
}

export const logLine = (s: SocialState, text: string, at = new Date()): SocialState => ({ ...s, log: [{ at: at.toISOString(), text }, ...s.log].slice(0, 50) });

export function settingsOf(s: SocialState, autoPublish: boolean): SocialSettings {
  return { autoPublish, paused: s.paused, platforms: s.platforms };
}

/** Adds one measured result to a score table. Pure. */
export function addScore<K extends string>(table: Partial<Record<K, Score>>, key: K, score: number): Partial<Record<K, Score>> {
  const cur = table[key] ?? { posts: 0, score: 0 };
  return { ...table, [key]: { posts: cur.posts + 1, score: Math.round((cur.score + score) * 10_000) / 10_000 } };
}

/** For the writer's prompt: what did best and worst so far (fixed words only). */
export function learnedHints(l: SocialLearnings): string {
  const rank = <K extends string>(t: Partial<Record<K, Score>>) =>
    (Object.entries(t) as Array<[K, Score]>)
      .filter(([, s]) => s.posts >= 2)
      .sort((a, b) => b[1].score / b[1].posts - a[1].score / a[1].posts);
  const lines: string[] = [];
  const h = rank(l.hooks);
  if (h.length >= 2) lines.push(`Openings that did best: ${h.slice(0, 2).map(([k]) => k).join(", ")}; least: ${h[h.length - 1]![0]}.`);
  const t = rank(l.topics);
  if (t.length >= 2) lines.push(`Topics that did best: ${t.slice(0, 2).map(([k]) => k).join(", ")}; least: ${t[t.length - 1]![0]}.`);
  return lines.join("\n");
}

/** The audience's language from what day2 knows about the app: German for German-speaking apps, else English. Pure. */
export function guessLanguage(texts: Array<string | null | undefined>): string {
  const t = texts.filter(Boolean).join(" ");
  if (/\b(german|deutsch\w*|german-speaking|dach)\b/i.test(t)) return "de";
  const de = (t.match(/\b(und|der|die|das|nicht|für|mit|ist|ein|eine|dein|deine|du)\b/gi) ?? []).length;
  const en = (t.match(/\b(and|the|not|for|with|is|a|your|you)\b/gi) ?? []).length;
  if (de > en && de >= 3) return "de";
  const fr = (t.match(/\b(et|le|la|les|pour|avec|est|une|ton|tu)\b/gi) ?? []).length;
  if (fr > en && fr >= 3) return "fr";
  return "en";
}
