import { buildAuthenticityChecklist, GENERIC_CONTENT_PATTERNS } from "../ai-slop-patterns";
import { renderBrandBrief, type BrandDna } from "../brand-dna";
import { meteredQuery } from "../metered-query";
import { BODY_MAX, CTA_MAX, LOCALES, TITLE_MAX, type Locale, type Text } from "./types";

/**
 * Message texts: written by an agent in the app's brand voice, in each of
 * the users' languages, short (title ≤ 40, body ≤ 120 characters), then
 * checked twice before anything is sent:
 *  1. here, by rules (length, languages, the known generic-AI tells in
 *     English and German, fake urgency, shaming, numbers the app can't
 *     back, the brand's "never say" list);
 *  2. by a second agent that didn't write them (truthful claims against
 *     the app's real features, reads-as-generic, brand voice). It fails
 *     closed: an unreadable verdict is a failed check.
 */

export type DraftInput = {
  appName: string;
  purpose: string;
  targetUsers: string;
  features: string[];
  toneOfVoice: string | null;
  brand: BrandDna | null;
  locales: Locale[];
  /** Who it's for and what it should do, in plain words. */
  goal: string;
  /** What leading apps do for this state (retention research), if known. */
  practice?: string | null;
  /** App routes a tap may open (from the repo), if known. */
  routes?: string[];
  /** The owner's own words for an announcement. */
  ownerNote?: string | null;
};

export type Draft = { texts: Partial<Record<Locale, Text>>; route: string | null; claims: string[] };

const MARKER = "MESSAGE_TEXTS_JSON:";
const REVIEW_MARKER = "MESSAGE_REVIEW_JSON:";
const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";

export function buildDraftPrompt(i: DraftInput): string {
  const brief = renderBrandBrief(i.brand, null);
  return `You write push notifications and in-app messages for the app "${i.appName}".

The app: ${i.purpose}
Its users: ${i.targetUsers}
Real features (the only things you may mention): ${i.features.join(", ") || "(not listed)"}
Tone of voice: ${i.toneOfVoice ?? "not established — match the app's own copy"}
${brief ? `\n${brief}\n` : ""}
This message: ${i.goal}
${i.practice ? `What leading apps do here (adapt, don't copy): ${i.practice}\n` : ""}${i.ownerNote ? `The owner's words (keep their meaning): ${i.ownerNote}\n` : ""}${i.routes?.length ? `Screens a tap can open: ${i.routes.join(", ")}\n` : ""}
Write it in these languages: ${i.locales.join(", ")}. Each language is written natively, not translated word for word, in the register the app itself uses (for German: "du" if the app says "du").

Rules:
- Title at most ${TITLE_MAX} characters, body at most ${BODY_MAX}, button label (cta) at most ${CTA_MAX}. Count them.
- One concrete thing the user gets by opening the app now, tied to a real feature above.
- No fake urgency ("last chance", "nur heute"), no guilt or shaming, no "we miss you" pleading, no invented numbers, streaks, friends or rewards the app doesn't have.
- At most one exclamation mark and at most one emoji per message; no ALL CAPS.
- Never mention that day2 or an AI wrote it.

${buildAuthenticityChecklist()}

End your final message with exactly this marker on its own line, then JSON and nothing after it:
${MARKER}
{"texts": {${i.locales.map((l) => `"${l}": {"title": "...", "body": "...", "cta": "..."}`).join(", ")}}, "route": "/screen" or null, "claims": ["each factual claim the texts make about the app"]}`;
}

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max * 2) : "");

/** Pure. Null when the agent's answer can't be read. Lengths are checked later (checkTexts), not cut. */
export function parseDraft(text: string, locales: Locale[]): Draft | null {
  const at = text.lastIndexOf(MARKER);
  if (at < 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(at + MARKER.length).trim());
  } catch {
    return null;
  }
  const o = (raw ?? {}) as { texts?: Record<string, unknown>; route?: unknown; claims?: unknown };
  const texts: Partial<Record<Locale, Text>> = {};
  for (const l of locales) {
    const t = (o.texts?.[l] ?? null) as Record<string, unknown> | null;
    if (!t) continue;
    const title = clean(t.title, TITLE_MAX);
    const body = clean(t.body, BODY_MAX);
    const cta = clean(t.cta, CTA_MAX);
    if (title && body) texts[l] = { title, body, ...(cta ? { cta } : {}) };
  }
  if (!Object.keys(texts).length) return null;
  const route = typeof o.route === "string" && /^\/[A-Za-z0-9_\-/()[\].]*$/.test(o.route) ? o.route.slice(0, 120) : null;
  const claims = Array.isArray(o.claims) ? o.claims.filter((c): c is string => typeof c === "string").slice(0, 8) : [];
  return { texts, route, claims };
}

// ---------------------------------------------------------------------------
// Rule checks
// ---------------------------------------------------------------------------

/** Generic-AI and pushy-marketing tells, English and German (on top of ai-slop-patterns.ts). */
const TELLS: Array<{ id: string; re: RegExp }> = [
  { id: "unearned-superlative-vocabulary", re: /\b(game[- ]?chang\w*|revolution\w*|unlock\w*|elevate\w*|supercharge\w*|seamless\w*|effortless\w*|next[- ]level|bahnbrechend\w*|revolutionär\w*|mühelos\w*|nahtlos\w*|entfessel\w*)\b/i },
  { id: "formulaic-urgency-cta", re: /(don'?t wait|last chance|only today|hurry|act now|before it'?s too late|letzte chance|nur heute|beeil dich|worauf wartest du|jetzt oder nie|verpasse? nicht)/i },
  { id: "vague-unquantified-social-proof", re: /(thousands of|millions of|everyone'?s talking|tausende|millionen von|alle reden)/i },
  { id: "fast-paced-world-opener", re: /(in today'?s|fast[- ]paced world|in der heutigen|schnelllebig)/i },
  { id: "start-your-journey", re: /\b(journey|reise beginnt|deine reise)\b/i },
  { id: "shaming", re: /(you failed|lazy|giving up|disappointed in you|du hast versagt|faul\b|aufgegeben|enttäuscht von dir|schäm)/i },
  { id: "pleading", re: /(we miss you|come back please|wir vermissen dich|bitte komm zurück)/i },
];
const KNOWN_IDS = new Set(GENERIC_CONTENT_PATTERNS.map((p) => p.id));

export type TextCheck = { ok: boolean; issues: string[] };

/** Pure. Everything that can be decided without an agent. */
export function checkTexts(texts: Partial<Record<Locale, Text>>, opts: { locales: Locale[]; brand?: BrandDna | null; grounding?: string }): TextCheck {
  const issues: string[] = [];
  for (const l of opts.locales) if (!texts[l]) issues.push(`No ${l === "de" ? "German" : "English"} text.`);
  const grounding = (opts.grounding ?? "").toLowerCase();
  for (const l of LOCALES) {
    const t = texts[l];
    if (!t) continue;
    const name = l.toUpperCase();
    if (t.title.length > TITLE_MAX) issues.push(`${name} title is ${t.title.length} characters (at most ${TITLE_MAX}).`);
    if (t.body.length > BODY_MAX) issues.push(`${name} body is ${t.body.length} characters (at most ${BODY_MAX}).`);
    if (t.cta && t.cta.length > CTA_MAX) issues.push(`${name} button is ${t.cta.length} characters (at most ${CTA_MAX}).`);
    const all = `${t.title} ${t.body} ${t.cta ?? ""}`;
    for (const tell of TELLS) if (tell.re.test(all)) issues.push(`${name}: reads as ${KNOWN_IDS.has(tell.id) ? `generic (${tell.id})` : tell.id.replace(/-/g, " ")}.`);
    if ((all.match(/!/g) ?? []).length > 1) issues.push(`${name}: more than one exclamation mark.`);
    if ((all.match(/\p{Extended_Pictographic}/gu) ?? []).length > 1) issues.push(`${name}: more than one emoji.`);
    if (/\b[A-ZÄÖÜ]{4,}\b/.test(all.replace(/\b(OK|PDF|FAQ|USA|EU)\b/g, ""))) issues.push(`${name}: words in capitals.`);
    for (const n of all.match(/\d+([.,]\d+)?\s?%?/g) ?? []) {
      if (!grounding.includes(n.trim().toLowerCase())) issues.push(`${name}: the number "${n.trim()}" isn't backed by anything day2 knows about the app.`);
    }
    for (const never of opts.brand?.voice.dontSay ?? []) {
      const word = never.trim().toLowerCase();
      if (word.length >= 3 && word.split(/\s+/).length <= 4 && all.toLowerCase().includes(word)) issues.push(`${name}: uses "${never}", which the brand never says.`);
    }
  }
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

async function runAgent(prompt: string, label: string, maxBudgetUsd: number): Promise<string | null> {
  let text = "";
  let failed = false;
  try {
    for await (const m of meteredQuery("content_generation", label)({
      prompt,
      options: { model: MODEL, permissionMode: "bypassPermissions", maxTurns: 4, maxBudgetUsd, persistSession: false, settingSources: [], settings: { disableClaudeAiConnectors: true }, tools: [] },
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

/** Writes texts (metered to the current credit context). */
export async function draftTexts(input: DraftInput): Promise<Draft | null> {
  const text = await runAgent(buildDraftPrompt(input), "Message texts", 0.5);
  return text === null ? null : parseDraft(text, input.locales);
}

export function buildReviewPrompt(texts: Partial<Record<Locale, Text>>, claims: string[], i: Pick<DraftInput, "appName" | "purpose" | "features" | "toneOfVoice" | "brand" | "targetUsers">): string {
  return `You are an independent reviewer. You did NOT write these push / in-app message texts for the app "${i.appName}". Check them before they go to real users.

The app (the ONLY source of truth): ${i.purpose}
Real features: ${i.features.join(", ")}
Users: ${i.targetUsers}
Tone of voice: ${i.toneOfVoice ?? "not established"}
${i.brand ? renderBrandBrief(i.brand, null) : ""}

Texts:
${Object.entries(texts)
  .map(([l, t]) => `[${l}] title: ${t!.title} | body: ${t!.body}${t!.cta ? ` | button: ${t!.cta}` : ""}`)
  .join("\n")}
Claims they make: ${claims.join("; ") || "(none listed)"}

Fail them (ok: false) if any claim isn't supported by a real feature, if they read as generic could-be-any-app copy, if they pressure, shame or plead, if they break the brand's "never say" list, or if a language reads like a translation.

${buildAuthenticityChecklist()}

End your final message with exactly this marker on its own line, then JSON and nothing after it:
${REVIEW_MARKER}
{"ok": true|false, "issues": ["..."]}
An empty issues list with ok: true is the honest answer when nothing is wrong.`;
}

/** Pure. Fails closed. */
export function parseReview(text: string): TextCheck {
  const at = text.lastIndexOf(REVIEW_MARKER);
  if (at < 0) return { ok: false, issues: ["The independent check gave no readable verdict."] };
  try {
    const o = JSON.parse(text.slice(at + REVIEW_MARKER.length).trim()) as { ok?: unknown; issues?: unknown };
    if (typeof o.ok !== "boolean" || !Array.isArray(o.issues)) return { ok: false, issues: ["The independent check's verdict had the wrong shape."] };
    const issues = o.issues.filter((x): x is string => typeof x === "string").slice(0, 8);
    return { ok: o.ok, issues };
  } catch {
    return { ok: false, issues: ["The independent check's verdict wasn't valid JSON."] };
  }
}

export async function reviewTexts(texts: Partial<Record<Locale, Text>>, claims: string[], i: Parameters<typeof buildReviewPrompt>[2]): Promise<TextCheck> {
  const text = await runAgent(buildReviewPrompt(texts, claims, i), "Message texts check", 0.3);
  return text === null ? { ok: false, issues: ["The independent check couldn't run."] } : parseReview(text);
}
