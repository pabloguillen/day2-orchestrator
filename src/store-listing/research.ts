import { renderBrandBrief } from "../brand-dna";
import { meteredQuery } from "../metered-query";
import type { AppProfile } from "../onboarding";
import { difficulty } from "./itunes";
import { FIELD_LABEL, isField, type Suggestion } from "./listing";
import { LIMITS, type Competitor, type KeywordStat, type Listings, type StoreId } from "./types";

/**
 * The agent side of store research: which search terms to look up, then
 * the listing texts — grounded in the app profile and brand DNA, the
 * current listing, real App Store search numbers and competitors' titles
 * and subtitles. Pure prompt builders and parsers; the runs are metered.
 */

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
const TERMS = "STORE_TERMS_JSON:";
const WRITE = "STORE_LISTING_JSON:";
export const TERMS_MAX_USD = 0.3;
export const WRITE_MAX_USD = 0.8;

export type WriteInput = {
  appName: string;
  profile: AppProfile;
  listings: Listings;
  locales: string[];
  stores: StoreId[];
  keywords: KeywordStat[];
  competitors: Competitor[];
  /** What the store tests and reviews taught so far, in a sentence or two. */
  learned?: string;
  /** What day2 knows about the app (memory/runtime.ts). */
  memory?: string;
  /** Listing changes the owner said no to ("store.text:subtitle:en-us"). */
  avoid?: string[];
  /** What worked in similar apps (learning/priors.ts). */
  worked?: string[];
};

/** A listing change's hard-filter targets: the field in that language, and the field anywhere. */
export const textTargets = (x: { field: string; locale: string }): string[] => [`${x.field}:${x.locale}`, x.field];

export function buildTermsPrompt(i: { appName: string; profile: AppProfile; locales: string[]; current: string[] }): string {
  return `You help an app be found in the App Store. List the search terms its future users would type, per language.

The app: ${i.appName} — ${i.profile.purpose}
For: ${i.profile.targetUsers}
Features: ${i.profile.featureMap.join("; ")}
Languages (store locales): ${i.locales.join(", ")}
Its current keywords: ${i.current.join(", ") || "none yet"}

For each locale give 8–12 short terms (1–3 words) in that language that people really search for this kind of app — generic needs and use cases, not brand names of other apps. Include the current keywords that still fit.

End with this marker on its own line, then JSON, nothing after:
${TERMS}
{"terms":{"de-DE":["…"],"en-US":["…"]}}`;
}

/** Pure. Terms per locale from the answer (≤ 12 each, 1–40 chars). */
export function parseTerms(text: string, locales: string[]): Record<string, string[]> {
  const raw = afterMarker(text, TERMS) as { terms?: Record<string, unknown> } | null;
  const out: Record<string, string[]> = {};
  for (const l of locales) {
    const list = raw?.terms?.[l];
    out[l] = Array.isArray(list) ? [...new Set(list.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter((x) => x.length > 0 && x.length <= 40))].slice(0, 12) : [];
  }
  return out;
}

const currentBlock = (l: Listings, locales: string[], stores: StoreId[]) =>
  stores
    .flatMap((s) =>
      locales.map((loc) => {
        const t = (s === "ios" ? l.ios?.[loc] : l.android?.[loc]) as Record<string, string> | undefined;
        if (!t) return `${s} ${loc}: (no listing in this language yet)`;
        return `${s} ${loc}:\n${Object.entries(t)
          .filter(([, v]) => v)
          .map(([k, v]) => `  ${k}: ${JSON.stringify(v.length > 600 ? `${v.slice(0, 600)}…` : v)}`)
          .join("\n")}`;
      }),
    )
    .join("\n");

export function buildWritePrompt(i: WriteInput): string {
  const brand = renderBrandBrief(i.profile.brand ?? null, "ads");
  const kw = i.keywords.map((k) => `${k.country}: "${k.term}" — ${k.results} apps, difficulty ${difficulty(k)}/100, ${k.rank ? `we rank #${k.rank}` : "we're not in the top 50"}; top: ${k.topApps.slice(0, 3).join(", ")}`).join("\n");
  const comp = i.competitors.map((c) => `${c.country}: ${c.name}${c.subtitle ? ` — "${c.subtitle}"` : ""} (${c.ratings} ratings${c.rating ? `, ${c.rating}★` : ""})`).join("\n");
  const fields = (s: StoreId) =>
    s === "ios"
      ? `ios fields: name (≤${LIMITS.name}), subtitle (≤${LIMITS.subtitle}), keywords (≤${LIMITS.keywords} BYTES, comma-separated, no spaces after commas, no words already in the name or subtitle, singular forms, no other apps' brand names), promotionalText (≤${LIMITS.promotionalText}, can change any time), description (≤${LIMITS.description})`
      : `android fields: title (≤${LIMITS.title}), shortDescription (≤${LIMITS.shortDescription}), fullDescription (≤${LIMITS.fullDescription}; Google indexes it — use the important terms naturally, never stuff them)`;
  return `You are an App Store optimization writer. Improve this app's store listing so the right people find it and want it — in each language, written natively (not translated word for word).

The app: ${i.appName} — ${i.profile.purpose}
For: ${i.profile.targetUsers}
Real features (the ONLY things you may claim): ${i.profile.featureMap.join("; ")}
Business model: ${i.profile.businessModel ?? "not established — don't mention prices or 'free'"}
Tone: ${i.profile.toneOfVoice ?? "plain and friendly"}
${brand ? `${brand}\n` : ""}
Current listing:
${currentBlock(i.listings, i.locales, i.stores)}

App Store search, real numbers (difficulty = how big the top apps are):
${kw || "(no search numbers this time)"}

Apps that come up for these searches:
${comp || "(none found)"}
${i.learned ? `\nWhat earlier tests and reviews showed: ${i.learned}\n` : ""}${i.worked?.length ? `\nWhat worked in similar apps (anonymous results from other apps; still a test here):\n${i.worked.map((w) => `- ${w}`).join("\n")}\n` : ""}${i.avoid?.length ? `\nThe owner said no to these changes before — don't suggest them again: ${i.avoid.map((a) => a.replace(/^store\.text:/, "")).join("; ")}\n` : ""}${i.memory ? `\n${i.memory}\n` : ""}
Rules:
- Only suggest a field when the change is clearly better; keep what already works. Fewer, better changes.
- ${i.stores.map(fields).join("\n- ")}
- Prefer terms with a real audience that we can win (difficulty below ~60, or where we already rank).
- Never use other apps' names or trademarks, rankings ("#1", "best"), prices or claims the features don't support. No emoji in names or titles.
- The name/title keeps the app's brand name "${i.appName}" first.
- Each suggestion has a short reason in plain English for the owner (what it adds, which searches it targets).

End with this marker on its own line, then JSON, nothing after:
${WRITE}
{"summary":"one or two sentences on the strategy","suggestions":[{"store":"ios","locale":"${i.locales[0] ?? "en-US"}","field":"subtitle","text":"…","reason":"…"}]}`;
}

/** Pure. The writer's suggestions — only stores, locales and fields that exist. */
export function parseWrite(text: string, o: { locales: string[]; stores: StoreId[] }): { summary: string; suggestions: Suggestion[] } | null {
  const raw = afterMarker(text, WRITE) as { summary?: unknown; suggestions?: unknown } | null;
  if (!raw || !Array.isArray(raw.suggestions)) return null;
  const suggestions: Suggestion[] = [];
  for (const s of raw.suggestions.slice(0, 40)) {
    const x = (s ?? {}) as Record<string, unknown>;
    const store = x.store === "ios" || x.store === "android" ? x.store : null;
    if (!store || !o.stores.includes(store)) continue;
    if (typeof x.locale !== "string" || !o.locales.includes(x.locale)) continue;
    if (!isField(store, x.field) || typeof x.text !== "string") continue;
    // The writer doesn't touch release notes: those come from the release.
    if (x.field === "whatsNew") continue;
    suggestions.push({ store, locale: x.locale, field: x.field, text: x.text, reason: typeof x.reason === "string" ? x.reason : `New ${FIELD_LABEL[x.field].toLowerCase()}.` });
  }
  return { summary: typeof raw.summary === "string" ? raw.summary.trim().slice(0, 500) : "", suggestions };
}

export function afterMarker(text: string, marker: string): unknown {
  const i = text.lastIndexOf(marker);
  if (i === -1) return null;
  try {
    return JSON.parse(text.slice(i + marker.length).trim());
  } catch {
    return null;
  }
}

/** One text-only agent run (no tools), metered to the current credit context. */
export async function runText(prompt: string, o: { service: "agent_work" | "content_generation"; label: string; maxUsd: number }): Promise<string | null> {
  let text = "";
  let failed = false;
  try {
    for await (const m of meteredQuery(o.service, o.label)({
      prompt,
      options: { model: MODEL, permissionMode: "bypassPermissions", maxTurns: 3, maxBudgetUsd: o.maxUsd, persistSession: false, settingSources: [], settings: { disableClaudeAiConnectors: true }, tools: [] },
    })) {
      const msg = m as { type?: string; result?: string; is_error?: boolean };
      if (msg.type === "result") {
        text = msg.result ?? "";
        failed = Boolean(msg.is_error);
      }
    }
  } catch {
    failed = true;
  }
  return failed ? null : text;
}

export async function suggestTerms(i: Parameters<typeof buildTermsPrompt>[0]): Promise<Record<string, string[]>> {
  const text = await runText(buildTermsPrompt(i), { service: "agent_work", label: "Store search terms", maxUsd: TERMS_MAX_USD });
  return text ? parseTerms(text, i.locales) : Object.fromEntries(i.locales.map((l) => [l, i.current]));
}

export async function writeListing(i: WriteInput): Promise<{ summary: string; suggestions: Suggestion[] } | null> {
  const text = await runText(buildWritePrompt(i), { service: "content_generation", label: "Store listing texts", maxUsd: WRITE_MAX_USD });
  return text ? parseWrite(text, { locales: i.locales, stores: i.stores }) : null;
}
