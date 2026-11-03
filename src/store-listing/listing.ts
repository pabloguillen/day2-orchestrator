import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APPLE_FIELDS, LIMITS, PLAY_FIELDS, type ApplyHow, type ListingField, type Proposal, type StoreFile, type StoreId } from "./types";

/**
 * Pure rules for listing texts: the stores' limits, Apple's keyword format,
 * how each change reaches the store, and proposals from what the writer
 * suggested.
 */

const utf8 = new TextEncoder();

/** Characters for every field; bytes for Apple's keywords (Apple counts bytes there). */
export function measure(field: ListingField, text: string): number {
  return field === "keywords" ? utf8.encode(text).length : [...text].length;
}

/** Pure. Apple keywords: comma-separated, no spaces after commas, no duplicates, no empty items. */
export function normalizeKeywords(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of text.split(",")) {
    const t = k.replace(/\s+/g, " ").trim();
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.join(",");
}

/** Pure. Why a text can't go into the store as it is, or null. */
export function checkField(field: ListingField, text: string, o: { appName?: string } = {}): string | null {
  const limit = LIMITS[field];
  const n = measure(field, text);
  if (!text.trim() && field !== "whatsNew" && field !== "promotionalText") return "it's empty";
  if (n > limit) return `${n} ${field === "keywords" ? "bytes" : "characters"} — the limit is ${limit}`;
  if ((field === "name" || field === "title") && /[™®©]|\bfree\b|#1|\bbest\b/i.test(text)) return "store names can't carry prices, rankings or symbols like ™";
  if (field === "keywords") {
    if (/,\s/.test(text)) return "keywords are separated by commas without spaces";
    const name = o.appName?.toLowerCase();
    if (name && text.toLowerCase().split(",").includes(name)) return "the app's name is already searched — it wastes keyword space";
  }
  if (/<[a-z][\s\S]*>/i.test(text)) return "the stores don't show HTML";
  return null;
}

export function fieldsFor(store: StoreId): ListingField[] {
  return store === "ios" ? APPLE_FIELDS : PLAY_FIELDS;
}

export function isField(store: StoreId, f: unknown): f is ListingField {
  return typeof f === "string" && (fieldsFor(store) as string[]).includes(f);
}

/** Pure. Promotional text needs no review, other Apple texts go with a version, Play goes with an edit commit. */
export function applyHowFor(store: StoreId, field: ListingField): ApplyHow {
  if (store === "android") return "edit_commit";
  return field === "promotionalText" ? "now" : "next_version";
}

export const FIELD_LABEL: Record<ListingField, string> = {
  name: "App name",
  subtitle: "Subtitle",
  keywords: "Keywords",
  promotionalText: "Promotional text",
  description: "Description",
  whatsNew: "What's New",
  title: "Title",
  shortDescription: "Short description",
  fullDescription: "Full description",
};

export type Suggestion = { store: StoreId; locale: string; field: ListingField; text: string; reason: string };

/**
 * Pure. Proposals from the writer's suggestions: only real changes that fit
 * the store's rules; a newer suggestion for the same store/locale/field
 * replaces one still waiting. Returns the new file and what was dropped (why).
 */
export function addProposals(
  file: StoreFile,
  suggestions: Suggestion[],
  o: { now: Date; researchId: string | null; appName?: string; auto: boolean },
): { file: StoreFile; added: Proposal[]; dropped: Array<{ what: string; why: string }> } {
  const f = structuredClone(file);
  const added: Proposal[] = [];
  const dropped: Array<{ what: string; why: string }> = [];
  for (const s of suggestions) {
    const what = `${s.store} ${s.locale} ${FIELD_LABEL[s.field]}`;
    const text = s.field === "keywords" ? normalizeKeywords(s.text) : s.text.trim();
    const current = (s.store === "ios" ? f.listings.ios?.[s.locale]?.[s.field as never] : f.listings.android?.[s.locale]?.[s.field as never]) ?? "";
    if (text === current) continue;
    const why = checkField(s.field, text, { appName: o.appName });
    if (why) {
      dropped.push({ what, why });
      continue;
    }
    f.proposals = f.proposals.filter((p) => !(p.status === "pending" && p.store === s.store && p.locale === s.locale && p.field === s.field));
    const p: Proposal = {
      id: `SP-${f.nextProposal++}`,
      store: s.store,
      locale: s.locale,
      field: s.field,
      before: current,
      after: text,
      reason: s.reason.trim().slice(0, 400),
      chars: { before: measure(s.field, current), after: measure(s.field, text), limit: LIMITS[s.field] },
      applyHow: applyHowFor(s.store, s.field),
      status: o.auto ? "approved" : "pending",
      researchId: o.researchId,
      createdAt: o.now.toISOString(),
      decidedBy: o.auto ? "day2" : null,
      decidedAt: o.auto ? o.now.toISOString() : null,
      appliedAt: null,
      appliedTo: null,
      error: null,
    };
    f.proposals.push(p);
    added.push(p);
  }
  f.proposals = f.proposals.slice(-200);
  return { file: f, added, dropped };
}

/** Pure. The owner approves (optionally with edited text) or rejects a waiting proposal. */
export function decideProposal(file: StoreFile, id: string, d: { approve: boolean; text?: string; by: string | null; now: Date; appName?: string }): StoreFile {
  const f = structuredClone(file);
  const p = f.proposals.find((x) => x.id === id);
  if (!p) throw new Error(`There's no proposal ${id}.`);
  if (p.status !== "pending") throw new Error(`${id} is already ${p.status}.`);
  if (d.approve && typeof d.text === "string") {
    const text = p.field === "keywords" ? normalizeKeywords(d.text) : d.text.trim();
    const why = checkField(p.field, text, { appName: d.appName });
    if (why) throw new Error(`${FIELD_LABEL[p.field]}: ${why}.`);
    p.after = text;
    p.chars.after = measure(p.field, text);
  }
  p.status = d.approve ? "approved" : "rejected";
  p.decidedBy = d.by;
  p.decidedAt = d.now.toISOString();
  return f;
}

/** Store locales to work on, from the languages the app is written in (i18n folders, app.json locales). */
export function appLocales(repoPath: string): string[] {
  const found = new Set<string>();
  const add = (code: string) => {
    const c = code.toLowerCase().replace("_", "-");
    const base = c.split("-")[0]!;
    const map: Record<string, string> = { en: "en-US", de: "de-DE", fr: "fr-FR", es: "es-ES", it: "it", nl: "nl-NL", pt: "pt-BR", ja: "ja", ko: "ko", zh: "zh-Hans", sv: "sv", da: "da", no: "no", fi: "fi", pl: "pl", tr: "tr" };
    if (map[base]) found.add(map[base]!);
  };
  try {
    const j = JSON.parse(readFileSync(join(repoPath, "app.json"), "utf-8")) as { expo?: { locales?: Record<string, unknown> } };
    for (const k of Object.keys(j.expo?.locales ?? {})) add(k);
  } catch {
    // no app.json
  }
  for (const dir of ["locales", "src/locales", "i18n", "src/i18n", "translations", "src/translations", "assets/locales"]) {
    const p = join(repoPath, dir);
    if (!existsSync(p)) continue;
    for (const e of readdirSync(p)) {
      const m = e.match(/^([a-z]{2})([-_][A-Za-z]{2})?(\.json|\.ts|\.js)?$/);
      if (m) add(m[1]!);
    }
  }
  const out = [...found];
  // German-first apps (like Dotty) list German first; English is always worth having.
  if (!out.includes("en-US")) out.push("en-US");
  return out.sort((a, b) => (a === "en-US" ? 1 : 0) - (b === "en-US" ? 1 : 0)).slice(0, 6);
}

/** "de-DE" → "de" (iTunes country for a locale: "de-DE" → "de", "en-US" → "us"). */
export function countryFor(locale: string): string {
  const [lang, region] = locale.split("-");
  if (region && /^[A-Z]{2}$/.test(region)) return region.toLowerCase();
  return ({ ja: "jp", ko: "kr", zh: "cn", sv: "se", da: "dk", no: "no", fi: "fi", pl: "pl", tr: "tr", it: "it" } as Record<string, string>)[lang ?? ""] ?? "us";
}
