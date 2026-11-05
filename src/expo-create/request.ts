import { creditsForCost } from "../credits";
import { MAX_SCREENS as MAX_SCREENS_ } from "./plan";
import { LOOKS, MONEY, type CreateRequest, type Identifiers, type Money, type Platform } from "./types";

/** Pure. Checks what the owner typed; plain-language reasons. */
export function validateCreateRequest(raw: unknown): { ok: true; request: CreateRequest } | { ok: false; reason: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string).trim() : "");
  const name = s("name");
  const description = s("description");
  if (!/^[a-z][a-z0-9-]{1,48}[a-z0-9]$/.test(name)) return { ok: false, reason: "Name it with lowercase letters, numbers and dashes (3–50 characters, starting with a letter), like habit-loop." };
  if (description.length < 20) return { ok: false, reason: "Describe what the app should do in a sentence or two." };
  if (description.length > 4000) return { ok: false, reason: "Keep the description under 4,000 characters." };
  const platforms = Array.isArray(r.platforms) ? [...new Set(r.platforms.filter((p): p is Platform => p === "ios" || p === "android"))] : ["ios", "android"];
  if (!platforms.length) return { ok: false, reason: "Pick iPhone, Android or both." };
  const money: Money = MONEY.includes(r.money as Money) ? (r.money as Money) : "undecided";
  const look = Array.isArray(r.look) ? r.look.filter((l): l is string => typeof l === "string" && LOOKS.includes(l)) : [];
  const audience = s("audience").slice(0, 300);
  let domain: string | undefined;
  if (s("domain")) {
    domain = cleanDomain(s("domain")) ?? undefined;
    if (!domain) return { ok: false, reason: "The domain should look like habitloop.com (leave it empty if you don't have one)." };
  }
  const displayName = (s("displayName") || titleCase(name)).slice(0, 30);
  return {
    ok: true,
    request: { name, displayName, description, ...(audience ? { audience } : {}), ...(look.length ? { look } : {}), platforms: platforms as Platform[], money, ...(domain ? { domain } : {}) },
  };
}

export const titleCase = (slug: string) =>
  slug
    .split("-")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");

/** "https://www.HabitLoop.com/about" → "habitloop.com"; null when it isn't a domain. */
export function cleanDomain(input: string): string | null {
  const d = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^www\./, "");
  return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(d) ? d : null;
}

/** Java keywords can't be package segments on Android. */
const RESERVED = new Set(
  "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record yield".split(" "),
);

/** One segment valid for both an iOS bundle id and an Android package: [a-z][a-z0-9_]*. */
export function segment(s: string): string {
  let out = s.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!out) out = "app";
  if (!/^[a-z]/.test(out)) out = `a${out}`;
  if (RESERVED.has(out)) out = `${out}app`;
  return out.slice(0, 40);
}

/**
 * Pure. The app's identifiers. From the owner's domain (habitloop.com +
 * habit-loop → com.habitloop, or com.acme.habitloop for acme.com), else
 * from the owner's name (com.pabloguillen.habitloop), else app.day2.<name>.
 * The same id is used for iOS and Android (valid for both).
 */
export function identifiersFor(r: Pick<CreateRequest, "name" | "displayName" | "domain">, ownerName?: string | null): Identifiers {
  const app = segment(r.name);
  let base: string[];
  if (r.domain) {
    base = r.domain.split(".").reverse().map(segment);
    if (base[base.length - 1] !== app) base.push(app);
  } else {
    const owner = ownerName ? segment(ownerName) : "";
    base = owner && owner !== "app" ? ["com", owner, app] : ["app", "day2", app];
  }
  const id = base.join(".");
  return { bundleId: id, androidPackage: id, scheme: app, displayName: r.displayName, slug: r.name };
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/** What each part may cost at most (USD, day2's real cost before the app_build markup). */
export const BUDGET_USD = {
  /** The plan with its screen inventory (each version). */
  plan: 1,
  /** The design system (each version). */
  style: 0.6,
  /** Each screen's drawing. */
  screen: 0.6,
  /** runBuildAgent's own cap per run (agent.ts FIX_MAX_BUDGET_USD). */
  step: 3,
} as const;
/** A typical first version has about this many screens (state screens included). */
export const TYPICAL_SCREENS = 10;
export { MAX_SCREENS } from "./plan";
/** theme, screens, backend, polish. */
export const BUILD_STEPS = 4;
/** One fix attempt per step when its checks fail. */
export const MAX_ATTEMPTS = 2;

/**
 * Pure. Typical and worst-case cost in credits (what the console shows before starting):
 * the first version of the screen flow, one round of changes, and the four build steps.
 */
export function estimateCreate(): { usd: number; maxUsd: number; credits: number; maxCredits: number } {
  // Typical: writing uses about half its cap; one round of changes redraws ~3 screens; each step one run at ~2/3 of its cap.
  const firstVersion = BUDGET_USD.plan * 0.5 + BUDGET_USD.style * 0.5 + TYPICAL_SCREENS * BUDGET_USD.screen * 0.5;
  const oneRound = BUDGET_USD.plan * 0.5 + 3 * BUDGET_USD.screen * 0.5;
  const usd = firstVersion + oneRound + BUILD_STEPS * BUDGET_USD.step * 0.66;
  // Worst case: the most screens, retries on the writing, every step twice plus its one fix of mismatches with the drawings.
  const maxUsd = BUDGET_USD.plan * 2 + BUDGET_USD.style * 2 + MAX_SCREENS_ * BUDGET_USD.screen + BUILD_STEPS * BUDGET_USD.step * (MAX_ATTEMPTS + 1);
  return { usd, maxUsd, credits: creditsForCost(usd, "app_build"), maxCredits: creditsForCost(maxUsd, "app_build") };
}

/** Pure. The most one round of changes can cost (checked against the balance before it starts). */
export function estimateRound(screens: number, styleChanged: boolean): { usd: number; credits: number } {
  const usd = BUDGET_USD.plan + (styleChanged ? BUDGET_USD.style : 0) + Math.max(1, screens) * BUDGET_USD.screen;
  return { usd, credits: creditsForCost(usd, "app_build") };
}
