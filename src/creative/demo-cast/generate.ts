import { afterMarker } from "../../store-listing/research";
import { localeFor } from "../capture";
import { CAST_MARKER, CAST_VERSION, LIMITS, rng, validateCast, type CastDraft, type DemoCast } from "./schema";

/**
 * Writing a demo cast: one text-only model run gets the app's purpose,
 * features, audience, language and UI tone — nothing about the app's real
 * users — and answers with JSON after a marker. The JSON is checked
 * (schema.ts); on failure the model gets one more try with the problems,
 * then day2 falls back to the seeded built-in cast. `fakeCastModel` is the
 * deterministic stand-in for tests and for running without credits.
 */

export type CastModel = (prompt: string) => Promise<string | null>;

export type CastContext = {
  appId: string;
  appName: string;
  purpose: string;
  features: string[];
  audience: string;
  language: string;
  tone: string;
  city?: string | null;
};

const CITY: Record<string, { city: string; lat: number; lon: number; districts: string[] }> = {
  de: { city: "Berlin", lat: 52.52, lon: 13.405, districts: ["Mitte", "Kreuzberg", "Neukölln", "Prenzlauer Berg", "Friedrichshain", "Wedding"] },
  en: { city: "London", lat: 51.5072, lon: -0.1276, districts: ["Shoreditch", "Camden", "Brixton", "Hackney", "Islington", "Peckham"] },
  fr: { city: "Paris", lat: 48.8566, lon: 2.3522, districts: ["Le Marais", "Belleville", "Montmartre", "Bastille", "Oberkampf", "Batignolles"] },
  es: { city: "Madrid", lat: 40.4168, lon: -3.7038, districts: ["Malasaña", "Lavapiés", "Chueca", "La Latina", "Chamberí", "Retiro"] },
  it: { city: "Milano", lat: 45.4642, lon: 9.19, districts: ["Navigli", "Brera", "Isola", "Porta Romana", "NoLo", "Città Studi"] },
  nl: { city: "Amsterdam", lat: 52.3676, lon: 4.9041, districts: ["De Pijp", "Jordaan", "Oost", "West", "Noord", "Centrum"] },
};

/** Common first names per language (no surnames — a fictional cast never needs one). */
const NAMES: Record<string, string[]> = {
  de: ["Mia", "Jonas", "Emma", "Luca", "Lea", "Finn", "Hannah", "Noah", "Lina", "Elias", "Clara", "Ben"],
  en: ["Olivia", "Jack", "Amelia", "Leo", "Isla", "Oscar", "Ava", "Harry", "Freya", "Theo", "Ruby", "Alfie"],
  fr: ["Jade", "Louis", "Léa", "Gabriel", "Chloé", "Arthur", "Manon", "Jules", "Inès", "Hugo", "Lou", "Nathan"],
  es: ["Lucía", "Hugo", "Sofía", "Mateo", "Martina", "Leo", "Valeria", "Pablo", "Carla", "Álvaro", "Noa", "Dani"],
  it: ["Giulia", "Leonardo", "Sofia", "Francesco", "Aurora", "Tommaso", "Ginevra", "Lorenzo", "Alice", "Mattia", "Emma", "Riccardo"],
  nl: ["Emma", "Noah", "Julia", "Daan", "Tess", "Sem", "Sophie", "Luuk", "Zoë", "Finn", "Lotte", "Milan"],
};

const SPOTS: Record<string, Array<[string, string, string]>> = {
  // [name, category, what the photo shows]
  de: [["Eisdiele Venezia", "ice_cream", "two scoops of gelato in a waffle cone held up against a sunny street"], ["Kiezcourts", "sports", "a basketball hoop on an outdoor court in golden evening light"], ["Café Morgenrot", "cafe", "a flat white and a croissant on a small wooden café table"], ["Pizzeria Da Nino", "restaurant", "a fresh margherita pizza on a checkered tablecloth"], ["Volkspark Ufer", "park", "a picnic blanket with snacks on the grass by a lake"], ["Spätkauf Ecke", "shop", "colourful soda bottles in a corner-shop fridge at night"], ["Halle 7 Bouldern", "sports", "colourful bouldering holds on a climbing wall"], ["Flohmarkt am Kanal", "market", "vintage records in a crate at a flea market stall"]],
  en: [["Sunny Side Café", "cafe", "an iced coffee and a pastry on a windowsill"], ["Riverside Courts", "sports", "a basketball hoop at sunset"], ["Mario's Slice", "restaurant", "a slice of pepperoni pizza on a paper plate"], ["Fields Park", "park", "a picnic blanket on the grass in the afternoon sun"], ["Vinyl Corner", "shop", "a crate of vintage records"], ["The Wall Climbing", "sports", "colourful climbing holds on a wall"]],
};

const BIOS: Record<string, string[]> = {
  de: ["Immer auf der Suche nach dem besten Eis der Stadt 🍦", "Basketball, Kaffee, Wiederholung 🏀", "Kamera immer dabei 📸", "Mehr draußen als drinnen 🌿", "Pizza ist ein Lebensgefühl 🍕", "Bouldern & Brunch 🧗", "Flohmarkt-Profi 🎶", "Neu in der Stadt, sag hi 👋"],
  en: ["Always hunting for the best ice cream 🍦", "Basketball, coffee, repeat 🏀", "Camera always on me 📸", "More outside than inside 🌿", "Pizza is a lifestyle 🍕", "Climbing & brunch 🧗", "Flea market pro 🎶", "New in town, say hi 👋"],
};

const CAPTIONS: Record<string, string[]> = {
  de: ["Endlich wieder Eiswetter ☀️", "Wer kommt noch? 🏀", "Bester Flat White im Kiez", "Margherita-Abend mit den Jungs 🍕", "Picknick-Zeit 🧺", "Kurz was holen 😅", "Neues Projekt an der Wand 🧗", "Was für ein Fund 🎶"],
  en: ["Ice cream weather at last ☀️", "Who's coming? 🏀", "Best flat white around", "Pizza night with the crew 🍕", "Picnic time 🧺", "Quick snack run 😅", "New climbing route 🧗", "What a find 🎶"],
};

const COMMENTS: Record<string, string[]> = { de: ["Bin in 10 Min da!", "Neid 😍", "Nächstes Mal komm ich mit", "Sieht mega aus", "Wo genau?"], en: ["Be there in 10!", "Jealous 😍", "Next time I'm in", "Looks amazing", "Where exactly?"] };

const LOOKS = ["curly dark hair, warm smile, denim jacket", "short blond hair, hoodie, freckles", "long brown hair, round glasses, striped shirt", "buzz cut, friendly grin, sports jacket", "wavy red hair, knit sweater", "black braids, bright yellow jacket", "shoulder-length hair, cap, oversized shirt", "short dark hair, small earrings, green jacket", "light brown hair in a bun, white t-shirt", "beard stubble, beanie, flannel shirt"];

const pick = <T>(r: () => number, list: T[]): T => list[Math.floor(r() * list.length)]!;
const ascii = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** The seeded built-in cast for a language (also what `fakeCastModel` answers). Pure. */
export function fakeCastDraft(o: { language: string; seed: number; count?: number }): CastDraft {
  const r = rng(o.seed);
  const lang = NAMES[o.language] ? o.language : "en";
  const at = CITY[lang] ?? CITY.en!;
  const names = [...NAMES[lang]!].sort(() => r() - 0.5).slice(0, Math.min(10, Math.max(LIMITS.people[0], o.count ?? 8)));
  const bios = BIOS[lang] ?? BIOS.en!;
  const people = names.map((n, i) => ({ key: `p${i + 1}`, displayName: n, username: `${ascii(n)}${i % 3 === 0 ? "" : `.${pick(r, ["k", "m", "b", "s", "x"])}`}`, age: 19 + Math.floor(r() * 9), city: at.city, bio: bios[i % bios.length]!, look: LOOKS[i % LOOKS.length]!, avatar: null }));
  const spots = SPOTS[lang] ?? SPOTS.en!;
  const places = spots.slice(0, 6).map(([name, category], i) => ({ key: `pl${i + 1}`, name, category, district: at.districts[i % at.districts.length]!, city: at.city, lat: Math.round((at.lat + (r() - 0.5) * 0.06) * 1e5) / 1e5, lon: Math.round((at.lon + (r() - 0.5) * 0.1) * 1e5) / 1e5 }));
  const caps = CAPTIONS[lang] ?? CAPTIONS.en!;
  const times = [2, 8, 25, 70, 140, 300, 600, 1500];
  const moments = places.map((pl, i) => ({ key: `m${i + 1}`, person: people[(i + 1) % people.length]!.key, place: pl.key, caption: caps[i % caps.length]!, minutesAgo: times[i % times.length]!, visibility: (i % 4 === 3 ? "public" : "friends") as "friends" | "public", scene: spots[i]![2], photo: null }));
  moments.push({ key: `m${moments.length + 1}`, person: people[0]!.key, place: places[0]!.key, caption: caps[4 % caps.length]!, minutesAgo: 2000, visibility: "friends", scene: spots[0]![2], photo: null });
  const friendships = people.slice(1).map((p, i) => ({ a: people[0]!.key, b: p.key, status: (i === people.length - 2 ? "pending" : "accepted") as "accepted" | "pending" }));
  for (let i = 1; i + 1 < people.length; i += 2) friendships.push({ a: people[i]!.key, b: people[i + 1]!.key, status: "accepted" });
  const reactions = moments.flatMap((m, i) => people.filter((p) => p.key !== m.person).slice(0, 1 + (i % 4)).map((p) => ({ moment: m.key, person: p.key })));
  const cm = COMMENTS[lang] ?? COMMENTS.en!;
  const comments = moments.slice(0, 4).map((m, i) => ({ key: `c${i + 1}`, moment: m.key, person: people[(i + 3) % people.length]!.key, text: cm[i % cm.length]!, minutesAgo: Math.max(0, m.minutesAgo - 1) }));
  const leaderboard = people.map((p) => ({ person: p.key, points: Math.round(200 + r() * 1100) })).sort((a, b) => b.points - a.points);
  return { self: people[0]!.key, people, friendships, places, moments, reactions, comments, leaderboard };
}

/** The deterministic model for tests and offline runs: answers with the seeded cast. */
export const fakeCastModel = (seed: number): CastModel => async (prompt) => {
  const lang = /LANGUAGE: (\w+)/.exec(prompt)?.[1] ?? "en";
  return `Here is the cast.\n${CAST_MARKER}\n${JSON.stringify(fakeCastDraft({ language: lang, seed }))}`;
};

export function buildCastPrompt(c: CastContext, problems: string[] = []): string {
  const at = CITY[c.language] ?? CITY.en!;
  const city = c.city || at.city;
  return `You write the DEMO CAST for ${c.appName}: fictional people whose made-up activity fills a separate demo copy of the app, so marketing screenshots look lived-in.
The app: ${c.purpose}
Features: ${c.features.slice(0, 8).join("; ") || "(none listed)"}
Audience: ${c.audience || "(not stated)"}
LANGUAGE: ${c.language} — write every name, bio, caption and comment natively in it, in the app's UI tone (${c.tone || "plain, friendly"}).
City: ${city} (coordinates near ${at.lat}, ${at.lon} when it's ${at.city}).

Rules — any break makes the cast unusable:
- Every person is fictional and an ADULT aged ${LIMITS.minAge}–${Math.min(30, LIMITS.maxAge)} (state the age). Never a child or teenager, never a real, famous or recognizable person, never anyone's real account.
- First names common for the audience; no surnames, no @handles, no links, no emails, no phone numbers, no brands or chains.
- 8 people (key p1…p8), one of them is "self" — the demo account; self has 5+ accepted friends and 1 pending request.
- 6 places with invented names (small cafés, courts, parks…), category, district, city, lat/lon within the city.
- 8–10 moments over the last 7 days (minutesAgo), each by a person at a place, a caption ≤ ${LIMITS.caption} characters, "scene": what the photo shows — objects, food, places, no people.
- reactions (moment + person), 4–6 short comments, a weekly leaderboard (points) for everyone.
- "look": a few words on how the person looks for their profile photo (hair, clothes) — no ethnicity, no body description.
${problems.length ? `\nYour last answer was refused for: ${problems.slice(0, 8).join("; ")}. Fix exactly these.\n` : ""}
End with this marker on its own line, then JSON only:
${CAST_MARKER}
{"self":"p1","people":[{"key":"p1","displayName":"…","username":"…","age":23,"city":"${city}","bio":"…","look":"…"}],"friendships":[{"a":"p1","b":"p2","status":"accepted"}],"places":[{"key":"pl1","name":"…","category":"cafe","district":"…","city":"${city}","lat":0,"lon":0}],"moments":[{"key":"m1","person":"p2","place":"pl1","caption":"…","minutesAgo":12,"visibility":"friends","scene":"…"}],"reactions":[{"moment":"m1","person":"p3"}],"comments":[{"key":"c1","moment":"m1","person":"p4","text":"…","minutesAgo":5}],"leaderboard":[{"person":"p2","points":980}]}`;
}

/**
 * A cast for the app: the model's (checked, one retry) or the seeded
 * built-in one. Never includes images (images.ts adds them).
 */
export async function generateCast(c: CastContext, o: { model: CastModel | null; seed: number; now?: Date }): Promise<{ cast: DemoCast; note: string }> {
  const now = o.now ?? new Date();
  const base = { version: CAST_VERSION as typeof CAST_VERSION, appId: c.appId, language: c.language, locale: localeFor(c.language), createdAt: now.toISOString(), seed: o.seed, status: "draft" as const, approvedAt: null, approvedBy: null, images: { source: "none" as const, note: "No pictures yet." } };
  let problems: string[] = [];
  if (o.model) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await o.model(buildCastPrompt(c, problems)).catch(() => null);
      if (!text) break;
      const check = validateCast(afterMarker(text, CAST_MARKER));
      if (check.ok) return { cast: { ...base, generator: "model", ...check.draft }, note: check.problems.length ? `day2 wrote the cast (dropped: ${check.problems.slice(0, 3).join("; ")})` : "day2 wrote the cast" };
      problems = check.problems;
    }
  }
  const check = validateCast(fakeCastDraft({ language: c.language, seed: o.seed }));
  if (!check.ok) throw new Error(`the built-in cast is invalid: ${check.problems.join("; ")}`);
  return { cast: { ...base, generator: "fake", ...check.draft }, note: o.model ? `day2's writer couldn't make a valid cast (${problems.slice(0, 2).join("; ") || "no answer"}), so it used its built-in one` : "day2 used its built-in cast" };
}
