import { createHash } from "node:crypto";
import { promptProblem } from "../kit";

/**
 * The demo cast (docs/creative-quality.md, "Real screens"): fictional
 * friends who fill an app's demo backend so the screens day2 captures look
 * lived-in — never a real person, never a minor, never a real end user's
 * data. It is plain data (JSON) that a model writes and this file checks;
 * nothing in it is ever run as code.
 */

export const CAST_VERSION = 1;
export const CAST_MARKER = "DEMO_CAST_JSON:";

export const LIMITS = { people: [6, 10], places: [3, 12], moments: [4, 16], comments: 24, reactions: 60, minAge: 18, maxAge: 40, bio: 120, caption: 80, comment: 80, name: 30 } as const;

/** Where an image of the cast came from — and whether posts that show it must carry the AI label. */
export type CastImage = {
  assetId: string | null;
  /** Absolute path on day2's disk (resolved when loaded; never sent to the console). */
  file: string | null;
  source: "generated" | "bundled" | "placeholder";
  aiGenerated: boolean;
  /** Shows an AI-generated (fictional) person. */
  aiPerson: boolean;
  tool: string | null;
};

export type CastPerson = { key: string; displayName: string; username: string; age: number; city: string; bio: string; look: string; avatar: CastImage | null };
export type CastPlace = { key: string; name: string; category: string; district: string; city: string; lat: number; lon: number };
export type CastMoment = { key: string; person: string; place: string; caption: string; minutesAgo: number; visibility: "friends" | "public"; scene: string; photo: CastImage | null };
export type CastFriendship = { a: string; b: string; status: "accepted" | "pending" };
export type CastReaction = { moment: string; person: string };
export type CastComment = { key: string; moment: string; person: string; text: string; minutesAgo: number };
export type CastScore = { person: string; points: number };

export type DemoCast = {
  version: typeof CAST_VERSION;
  appId: string;
  language: string;
  locale: string;
  createdAt: string;
  generator: "model" | "fake";
  seed: number;
  status: "draft" | "approved";
  approvedAt: string | null;
  approvedBy: string | null;
  /** The person the demo account signs in as. */
  self: string;
  people: CastPerson[];
  friendships: CastFriendship[];
  places: CastPlace[];
  moments: CastMoment[];
  reactions: CastReaction[];
  comments: CastComment[];
  leaderboard: CastScore[];
  images: { source: "generated" | "bundled" | "placeholder" | "mixed" | "none"; note: string };
};

/** What the model writes (no images, no bookkeeping). */
export type CastDraft = Pick<DemoCast, "self" | "people" | "friendships" | "places" | "moments" | "reactions" | "comments" | "leaderboard">;

// ---------------------------------------------------------------- helpers

/** A small seeded random generator (mulberry32). Pure. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable UUID (v4 layout) for one entity of a cast. Pure. */
export function castUuid(seed: number, kind: string, key: string): string {
  const h = createHash("sha256").update(`day2-demo:${seed}:${kind}:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const KEY = /^[a-z][a-z0-9_]{0,23}$/;
const USERNAME = /^[a-z0-9._]{3,20}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

/** Text that must never be in a cast: handles, links, emails, real people. Pure. */
function textProblem(what: string, text: string): string | null {
  const p = promptProblem(text);
  return p ? `${what}: ${p}` : null;
}

// ---------------------------------------------------------------- validation

export type CastCheck = { ok: true; draft: CastDraft; problems: string[] } | { ok: false; problems: string[] };

/**
 * Checks what a model wrote and keeps only what's allowed: unique keys,
 * references that point at the cast's own people/places/moments, adults
 * only (18+, kept ≤ 40 so every face reads clearly as an adult), plain
 * text without handles, links, emails or a real person's name. Problems
 * that make the cast unusable fail it; small ones drop the item. Pure.
 */
export function validateCast(raw: unknown): CastCheck {
  const fatal: string[] = [];
  const soft: string[] = [];
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const arr = (k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]) : []);

  const people: CastPerson[] = [];
  const usernames = new Set<string>();
  for (const x of arr("people").slice(0, LIMITS.people[1])) {
    const p = (x ?? {}) as Record<string, unknown>;
    const key = str(p.key, 24);
    const displayName = str(p.displayName, LIMITS.name);
    const username = str(p.username, 20).toLowerCase();
    const age = Math.round(num(p.age));
    if (!KEY.test(key) || people.some((q) => q.key === key)) {
      soft.push(`person "${key}": a key must be unique, lowercase letters/digits`);
      continue;
    }
    if (!Number.isFinite(age) || age < LIMITS.minAge || age > LIMITS.maxAge) {
      fatal.push(`person "${key}": age ${Number.isFinite(age) ? age : "?"} — every person must be an adult (${LIMITS.minAge}–${LIMITS.maxAge})`);
      continue;
    }
    if (!displayName || !USERNAME.test(username) || usernames.has(username)) {
      soft.push(`person "${key}": needs a name and a unique username (a–z, 0–9, . _; 3–20)`);
      continue;
    }
    const bio = str(p.bio, LIMITS.bio);
    const look = str(p.look, 160);
    // The username is checked by its pattern (a dot in it would read as a web address here).
    const problem = textProblem(`person "${key}"`, `${displayName}. ${bio}. ${look}`);
    if (problem) {
      fatal.push(problem);
      continue;
    }
    usernames.add(username);
    people.push({ key, displayName, username, age, city: str(p.city, 40), bio, look, avatar: null });
  }
  if (people.length < LIMITS.people[0]) fatal.push(`the cast needs at least ${LIMITS.people[0]} people (has ${people.length})`);
  const person = new Set(people.map((p) => p.key));
  const self = str(o.self, 24);
  if (!person.has(self)) fatal.push(`"self" must be one of the people (the demo account)`);

  const places: CastPlace[] = [];
  for (const x of arr("places").slice(0, LIMITS.places[1])) {
    const p = (x ?? {}) as Record<string, unknown>;
    const key = str(p.key, 24);
    const name = str(p.name, 60);
    const lat = num(p.lat);
    const lon = num(p.lon);
    if (!KEY.test(key) || places.some((q) => q.key === key) || !name || !(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) {
      soft.push(`place "${key}": needs a unique key, a name and coordinates`);
      continue;
    }
    const problem = textProblem(`place "${key}"`, name);
    if (problem) {
      soft.push(problem);
      continue;
    }
    places.push({ key, name, category: str(p.category, 30) || "other", district: str(p.district, 40), city: str(p.city, 40), lat, lon });
  }
  if (places.length < LIMITS.places[0]) fatal.push(`the cast needs at least ${LIMITS.places[0]} places (has ${places.length})`);
  const place = new Set(places.map((p) => p.key));

  const moments: CastMoment[] = [];
  for (const x of arr("moments").slice(0, LIMITS.moments[1])) {
    const m = (x ?? {}) as Record<string, unknown>;
    const key = str(m.key, 24);
    const caption = str(m.caption, LIMITS.caption);
    const mins = Math.round(num(m.minutesAgo));
    if (!KEY.test(key) || moments.some((q) => q.key === key) || !person.has(str(m.person, 24)) || !place.has(str(m.place, 24)) || !(mins >= 0 && mins <= 7 * 24 * 60)) {
      soft.push(`moment "${key}": needs a unique key, one of the cast's people and places, and a time in the last 7 days`);
      continue;
    }
    const problem = textProblem(`moment "${key}"`, `${caption}. ${str(m.scene, 160)}`);
    if (problem) {
      soft.push(problem);
      continue;
    }
    moments.push({ key, person: str(m.person, 24), place: str(m.place, 24), caption, minutesAgo: mins, visibility: m.visibility === "public" ? "public" : "friends", scene: str(m.scene, 160), photo: null });
  }
  if (moments.length < LIMITS.moments[0]) fatal.push(`the cast needs at least ${LIMITS.moments[0]} moments (has ${moments.length})`);
  const moment = new Set(moments.map((m) => m.key));

  const friendships: CastFriendship[] = [];
  const pairs = new Set<string>();
  for (const x of arr("friendships").slice(0, 60)) {
    const f = (x ?? {}) as Record<string, unknown>;
    const a = str(f.a, 24);
    const b = str(f.b, 24);
    const pair = [a, b].sort().join("|");
    if (!person.has(a) || !person.has(b) || a === b || pairs.has(pair)) continue;
    pairs.add(pair);
    friendships.push({ a, b, status: f.status === "pending" ? "pending" : "accepted" });
  }
  if (!friendships.some((f) => f.status === "accepted" && (f.a === self || f.b === self))) fatal.push("the demo account needs at least one friend");

  const reactions: CastReaction[] = [];
  const seen = new Set<string>();
  for (const x of arr("reactions").slice(0, LIMITS.reactions)) {
    const r = (x ?? {}) as Record<string, unknown>;
    const k = `${str(r.moment, 24)}|${str(r.person, 24)}`;
    if (!moment.has(str(r.moment, 24)) || !person.has(str(r.person, 24)) || seen.has(k)) continue;
    seen.add(k);
    reactions.push({ moment: str(r.moment, 24), person: str(r.person, 24) });
  }

  const comments: CastComment[] = [];
  for (const [i, x] of arr("comments").slice(0, LIMITS.comments).entries()) {
    const c = (x ?? {}) as Record<string, unknown>;
    const text = str(c.text, LIMITS.comment);
    const mins = Math.round(num(c.minutesAgo));
    if (!moment.has(str(c.moment, 24)) || !person.has(str(c.person, 24)) || !text || !(mins >= 0)) continue;
    if (textProblem("comment", text)) {
      soft.push(`comment ${i + 1}: dropped (${textProblem("comment", text)})`);
      continue;
    }
    comments.push({ key: KEY.test(str(c.key, 24)) ? str(c.key, 24) : `c${i + 1}`, moment: str(c.moment, 24), person: str(c.person, 24), text, minutesAgo: Math.min(mins, 7 * 24 * 60) });
  }

  const leaderboard: CastScore[] = [];
  for (const x of arr("leaderboard").slice(0, LIMITS.people[1])) {
    const s = (x ?? {}) as Record<string, unknown>;
    const pts = Math.round(num(s.points));
    if (!person.has(str(s.person, 24)) || !(pts >= 0 && pts <= 100_000) || leaderboard.some((q) => q.person === str(s.person, 24))) continue;
    leaderboard.push({ person: str(s.person, 24), points: pts });
  }
  leaderboard.sort((a, b) => b.points - a.points);

  if (fatal.length) return { ok: false, problems: [...fatal, ...soft] };
  return { ok: true, draft: { self, people, friendships, places, moments, reactions, comments, leaderboard }, problems: soft };
}

/** A whole stored cast is still valid (after an edit or a load). Pure. */
export function isValidCast(c: unknown): c is DemoCast {
  const x = c as DemoCast;
  return Boolean(x && x.version === CAST_VERSION && typeof x.appId === "string" && validateCast(x).ok);
}
