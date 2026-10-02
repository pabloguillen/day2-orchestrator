import { query } from "@anthropic-ai/claude-agent-sdk";
import { chromium } from "playwright";
import { ingestCandidate, loadPatternLibrary, savePatternLibrary, type PatternLibrary, type RawCandidate } from "./pattern-library";
import { isValidMechanismDependsOn, type ContextDimension } from "./pattern-transferability";
import {
  fetchRedditHotPosts,
  fetchYoutubeTrendingVideos,
  renderRedditPostsForPrompt,
  renderYoutubeTrendingForPrompt,
  type RedditPost,
  type YoutubeTrendingVideo,
} from "./growth-trend-sources";

/**
 * Track B — trend/timely detection (docs/distribution-intelligence.md,
 * "Trends need a second, deliberately non-rigorous track").
 *
 * A multi-stage adversarial-verification pipeline (Track A, `pattern-
 * library.ts`) cannot validate a trend with a few days' relevance — there
 * is no disconfirming evidence to find yet for something 3 days old, and
 * by the time the pipeline finished the trend would already be dead. This
 * is a category error, not a speed problem, so Track B is a genuinely
 * different, faster, deliberately non-rigorous mechanism rather than a
 * faster Track A:
 *
 *   - No adversarial pass. A `TrendSignal` is explicitly `validated: false`
 *     with a `relevanceWindowDays`, never Track A's tier vocabulary
 *     (`single_observation`/`replicated_*`) — nobody should be able to
 *     mistake "trending today" for "validated pattern."
 *   - Tags FORMAT, not mechanism. Track A asks "why does this work" (a
 *     causal claim worth the adversarial rigor); Track B only needs "what
 *     is this, structurally" (`"pov-format"`, `"duet-stitch-reaction"`) —
 *     enough for creative generation to execute it, not a transferability
 *     claim.
 *   - Short TTL. `isTrendExpired` retires a signal once its window
 *     passes — the opposite of Track A, where staleness is flagged but
 *     the pattern stays visible.
 *   - Pull-based, not pre-seeded (unlike `seed-pattern-library-cli.ts`'s
 *     proactive sweep) — computing today's trends for a category nobody's
 *     about to post in just goes stale before anyone uses it.
 *   - Primary source is a real rendered page, not a scraper. TikTok's
 *     Creative Center Trends page is client-rendered — its trend data
 *     only exists after the page's own JS runs, so a plain WebFetch GET
 *     sees an empty app shell. `fetchRenderedTrendsPageText` uses
 *     Playwright (same direct `chromium` idiom as `growth-render.ts`,
 *     mechanical/no-judgment IO, not agent-mediated) to render exactly
 *     that one public, no-login-required page TikTok itself intentionally
 *     publishes for marketers, then hands the real rendered text to the
 *     agent as grounding. Deliberately NOT a general scraper — it
 *     renders this one public marketing page and nothing else. Reaching
 *     into login-gated TikTok/Instagram surfaces would mean defeating
 *     anti-bot detection against platforms whose ToS explicitly prohibit
 *     it, a line this file doesn't cross.
 *
 *     Live verification found TikTok's own edge returns a flat HTTP 403
 *     to this render — an active bot-detection block on even this public
 *     page, not a layout/timing issue. Rather than chase that with
 *     fingerprint spoofing (the exact evasion this file won't do),
 *     `growth-trend-sources.ts` adds two genuinely compliant real-data
 *     sources that sidestep the problem entirely by being official,
 *     authenticated APIs instead of rendered pages: YouTube Data API's
 *     `chart=mostPopular` and Reddit's OAuth2 API. Neither replaces
 *     TikTok-native trend granularity, but both are real, fetched,
 *     non-scraped data, not a hope that WebSearch happens to surface
 *     something. A fourth option — a licensed trend-data vendor that's
 *     already solved compliant TikTok access — is documented in
 *     docs/distribution-intelligence.md as a real alternative, not built
 *     here (it would reverse this project's margin-preserving
 *     no-external-tools stance). If every real source fails for any
 *     reason, it fails closed to `null`/empty + an honest caveat, and the
 *     prompt tells the agent to fall back to WebSearch and disclose that
 *     honestly in `source` — never silently treated as "nothing
 *     trending."
 *
 * The promotion path is what keeps Track B's inherently disposable
 * material from being pure waste: any individual trend is short-lived,
 * but the underlying FORMAT often recurs across many independent trend
 * cycles ("POV: ___" is dead in a week; the POV format itself has
 * recurred for years). `countIndependentCycles`/`shouldPromoteFormat`
 * track that recurrence; once a format crosses the threshold,
 * `articulatePromotedFormatMechanism` + `promoteFormatIntoLibrary` fold it
 * into Track A's durable library as a real, evidence-tagged meta-pattern
 * — reusing `pattern-library.ts`'s own `ingestCandidate`, not a parallel
 * ingestion path.
 */

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
const MAX_TURNS = 15;
const MAX_BUDGET_USD = 0.5;

// ---------------------------------------------------------------------------
// Real page render (see file header — one specific public page, not a
// general scraper)
// ---------------------------------------------------------------------------

const CREATIVE_CENTER_TRENDS_URL = "https://ads.tiktok.com/business/creativecenter/trends/pc/en";
const PAGE_RENDER_TIMEOUT_MS = 20_000;
/** Caps how much rendered text gets dumped into the prompt — this page's
 * nav/footer chrome alone can run long; the trend content itself is
 * always near the top. */
const MAX_RENDERED_TEXT_CHARS = 20_000;

/** Thin, Playwright-driven IO wrapper — mechanical, no LLM judgment,
 * same class of function as `growth-render.ts`'s direct `chromium` use.
 * Fails closed to `null` on any error (navigation timeout, layout
 * change, bot-detection block) rather than throwing — a failed render is
 * a normal, expected outcome here, not something that should crash the
 * research call. Zero unit coverage by nature (launches a real browser
 * against a real external page), validated only live. */
export async function fetchRenderedTrendsPageText(url: string): Promise<string | null> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: PAGE_RENDER_TIMEOUT_MS });
    const text = await page.innerText("body");
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed.slice(0, MAX_RENDERED_TEXT_CHARS) : null;
  } catch {
    return null;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export type TrendSignal = {
  id: string;
  /** The specific, dated trend — e.g. "POV: you just realized your
   * budget app tracks this for you." Disposable by design. */
  description: string;
  /** The durable structural shape — e.g. "pov-format" — what the
   * promotion path actually tracks recurrence of. */
  format: string;
  platform: string;
  detectedAt: string;
  /** A real, disclosed judgment call per signal (the agent's own
   * estimate), not a fixed constant — some trends move faster than
   * others. */
  relevanceWindowDays: number;
  source: string;
};

const TREND_RESULT_MARKER = "TREND_SIGNALS_JSON:";

function buildTrendResearchPrompt(
  category: string,
  renderedPageText: string | null,
  youtube: { videos: YoutubeTrendingVideo[]; caveat: string },
  reddit: { posts: RedditPost[]; caveat: string },
): string {
  const primarySourceSection = renderedPageText
    ? `Here is the real, just-rendered text content of TikTok's own public
Trends page (${CREATIVE_CENTER_TRENDS_URL}, fetched with a real browser so
its client-side-rendered content is actually visible) — treat this as
your primary, most current source:

"""
${renderedPageText}
"""

`
    : `TikTok's own public Trends page could not be rendered this time
(network issue, layout change, or bot detection) — don't pretend you
fetched it. Rely on the real data below plus WebSearch for secondary
coverage (recent trend-roundup journalism, etc.) and say so honestly in
each signal's \`source\` field.

`;

  const youtubeSection =
    youtube.videos.length > 0
      ? `Real YouTube trending videos right now (official YouTube Data API, not
scraped — these are genuinely trending, not a search result):
${renderYoutubeTrendingForPrompt(youtube.videos)}

`
      : `YouTube trending data unavailable this run (${youtube.caveat || "no videos returned"}) — don't fabricate YouTube coverage.

`;

  const redditSection =
    reddit.posts.length > 0
      ? `Real, currently-hot Reddit posts from trend-discussion communities
(official Reddit API, not scraped):
${renderRedditPostsForPrompt(reddit.posts)}

`
      : `Reddit data unavailable this run (${reddit.caveat || "no posts returned"}) — don't fabricate Reddit coverage.

`;

  return `${primarySourceSection}${youtubeSection}${redditSection}You are scanning for what's genuinely trending RIGHT NOW for the "${category}"
category — not proven patterns, not case studies, what's hot today and
likely stale within days. The YouTube/Reddit data above is real but
general-purpose (not category-specific) — use your judgment on what, if
anything, in it is actually relevant to "${category}"; most of it won't
be, and that's fine, don't force a connection that isn't there.

For each real, currently-active trend you find, report:
- A specific description of the actual trend (what's happening right now).
- The durable STRUCTURAL FORMAT underneath it, as a short slug (e.g.
  "pov-format", "duet-stitch-reaction", "day-in-the-life") — the shape
  that will outlive this specific instance, not the specific instance
  itself.
- Which platform.
- Your own honest estimate of how many more days this specific trend
  likely stays relevant (a real judgment call, typically 3-14 days for a
  genuine trend — don't default to the same number every time).

Do NOT attempt an adversarial/counter-evidence search here — that's a
different, slower process for durable patterns. This is a fast scan of
what's current, not a verified claim.

When finished, end your final message with exactly this marker on its own
line, followed by a JSON array (and nothing else after it):
${TREND_RESULT_MARKER}
[{"description": "...", "format": "...", "platform": "...", "relevanceWindowDays": <number>, "source": "..."}, ...]

Find 1-4 real, currently-active trends; report fewer if you can't verify
that many — don't pad. An empty array (${TREND_RESULT_MARKER}\n[]) is a
legitimate, honest answer if nothing genuinely active and relevant was
found.`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

/** Pure, unit-tested. Fails closed to `[]`, same discipline as every
 * other research parser in this codebase. */
export function parseTrendSignals(finalText: string): TrendSignal[] {
  const markerIndex = finalText.indexOf(TREND_RESULT_MARKER);
  if (markerIndex === -1) return [];

  const jsonText = finalText.slice(markerIndex + TREND_RESULT_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const now = new Date().toISOString();
  return parsed
    .filter((item): item is { description: string; format: string; platform: string; relevanceWindowDays: number; source: string } => {
      if (typeof item !== "object" || item === null) return false;
      const { description, format, platform, relevanceWindowDays, source } = item as Record<string, unknown>;
      return (
        typeof description === "string" &&
        description.trim().length > 0 &&
        typeof format === "string" &&
        format.trim().length > 0 &&
        typeof platform === "string" &&
        platform.trim().length > 0 &&
        typeof relevanceWindowDays === "number" &&
        relevanceWindowDays > 0 &&
        typeof source === "string" &&
        source.trim().length > 0
      );
    })
    .map((item) => ({
      id: slugify(`${item.format}-${item.description}`),
      description: item.description,
      format: slugify(item.format),
      platform: item.platform,
      detectedAt: now,
      relevanceWindowDays: item.relevanceWindowDays,
      source: item.source,
    }));
}

/** Thin, agent-invoking wrapper — zero unit coverage, validated only
 * live. Renders the real Creative Center page first (mechanical, see
 * `fetchRenderedTrendsPageText`), fetches real YouTube/Reddit data via
 * their official APIs (`growth-trend-sources.ts`), then hands all of it
 * to the agent alongside WebSearch/WebFetch for secondary sources, no
 * adversarial pass (deliberately — see the file header). */
export async function researchCurrentTrends(category: string): Promise<TrendSignal[]> {
  const [renderedPageText, youtube, reddit] = await Promise.all([
    fetchRenderedTrendsPageText(CREATIVE_CENTER_TRENDS_URL),
    fetchYoutubeTrendingVideos(),
    fetchRedditHotPosts(),
  ]);
  let finalText = "";
  let isError = false;
  try {
    for await (const message of query({
      prompt: buildTrendResearchPrompt(category, renderedPageText, youtube, reddit),
      options: {
        model: MODEL,
        permissionMode: "bypassPermissions",
        maxTurns: MAX_TURNS,
        maxBudgetUsd: MAX_BUDGET_USD,
        persistSession: false,
        settingSources: [],
        settings: { disableClaudeAiConnectors: true },
        tools: ["WebSearch", "WebFetch"],
      },
    })) {
      if (message.type === "result") {
        finalText = message.result ?? "";
        isError = Boolean(message.is_error);
      }
    }
  } catch (err) {
    isError = true;
    finalText = `(agent run threw before producing a result: ${(err as Error).message})`;
  }
  if (isError) return [];
  return parseTrendSignals(finalText);
}

/** Pure, unit-tested. The short-TTL half of Track B — once a signal's own
 * estimated window has passed, it's retired from active use entirely,
 * not just flagged (unlike Track A's staleness, which stays visible with
 * a warning). */
export function isTrendExpired(signal: TrendSignal, now: Date): boolean {
  const ageMs = now.getTime() - new Date(signal.detectedAt).getTime();
  return ageMs > signal.relevanceWindowDays * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Format-recurrence tracking and promotion into Track A
// ---------------------------------------------------------------------------

export type FormatOccurrence = {
  format: string;
  category: string;
  platform: string;
  detectedAt: string;
};

export type FormatRecurrenceLog = { occurrences: FormatOccurrence[] };

export const FORMAT_RECURRENCE_LOG_FILENAME = ".day2-format-recurrence.json";

export function loadFormatRecurrenceLog(path: string): FormatRecurrenceLog {
  const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
  if (!existsSync(path)) return { occurrences: [] };
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  if (typeof raw !== "object" || raw === null || !Array.isArray(raw.occurrences)) {
    throw new Error(`${path} exists but doesn't look like a valid format-recurrence log — refusing to guess or overwrite it.`);
  }
  return raw as FormatRecurrenceLog;
}

export function saveFormatRecurrenceLog(path: string, log: FormatRecurrenceLog): void {
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  writeFileSync(path, `${JSON.stringify(log, null, 2)}\n`);
}

export function recordFormatOccurrence(log: FormatRecurrenceLog, occurrence: FormatOccurrence): FormatRecurrenceLog {
  return { occurrences: [...log.occurrences, occurrence] };
}

/** A disclosed judgment call, not derived from anything: two sightings of
 * the same format within this many days are "still the same wave," not
 * independent evidence it keeps coming back. */
const MIN_GAP_DAYS_FOR_SEPARATE_CYCLE = 7;

/** Pure, unit-tested. Counts genuinely separate waves of the same format,
 * not just raw sighting count — polling daily while one trend is still
 * hot would otherwise inflate the count without any real new evidence
 * that the FORMAT itself (as opposed to this one trend) keeps recurring. */
export function countIndependentCycles(occurrences: FormatOccurrence[], format: string): number {
  const dates = occurrences
    .filter((o) => o.format === format)
    .map((o) => new Date(o.detectedAt).getTime())
    .sort((a, b) => a - b);
  if (dates.length === 0) return 0;

  let cycles = 1;
  let lastCycleStart = dates[0]!;
  for (let i = 1; i < dates.length; i++) {
    if (dates[i]! - lastCycleStart > MIN_GAP_DAYS_FOR_SEPARATE_CYCLE * 24 * 60 * 60 * 1000) {
      cycles++;
      lastCycleStart = dates[i]!;
    }
  }
  return cycles;
}

/** A disclosed judgment call: three genuinely independent cycles is the
 * bar for "this format itself recurs," not just "this format happened to
 * come up more than once." */
const MIN_CYCLES_FOR_PROMOTION = 3;

export function shouldPromoteFormat(occurrences: FormatOccurrence[], format: string): boolean {
  return countIndependentCycles(occurrences, format) >= MIN_CYCLES_FOR_PROMOTION;
}

const PROMOTION_MECHANISM_MARKER = "PROMOTED_FORMAT_MECHANISM_JSON:";

function buildPromotionMechanismPrompt(format: string, occurrences: FormatOccurrence[]): string {
  const contexts = occurrences
    .filter((o) => o.format === format)
    .map((o) => `- ${o.category} / ${o.platform}, detected ${o.detectedAt}`)
    .join("\n");
  return `A content FORMAT (not any one specific trend) has now recurred across
multiple independent trend cycles over time:

Format: "${format}"
Real occurrences recorded:
${contexts}

Unlike a single trend (which is disposable), a format recurring this many
times independently is worth asking WHY it keeps working — articulate the
real structural/psychological mechanism (not "it was popular"), then
classify which context dimensions that mechanism depends on, from exactly
this set: "category", "platform", "stage", "era". Use an empty array only
if you're confident the mechanism is genuinely general.

When finished, end your final message with exactly this marker on its own
line, followed by JSON (and nothing else after it):
${PROMOTION_MECHANISM_MARKER}
{"mechanism": "...", "mechanismDependsOn": ["category"|"platform"|"stage"|"era", ...]}`;
}

/** Pure, unit-tested. Fails closed to a generic, maximally-honest fallback
 * mechanism rather than blocking promotion outright on a parse failure —
 * the recurrence itself (3+ independent cycles) is already real evidence
 * even if the agent's articulation of *why* fails to parse; an empty
 * `mechanismDependsOn` here is the conservative choice (claims full
 * generality, which Stage 4 will test hard against future observations
 * anyway), not an overclaim. */
export function parsePromotionMechanism(finalText: string): { mechanism: string; mechanismDependsOn: ContextDimension[] } {
  const markerIndex = finalText.indexOf(PROMOTION_MECHANISM_MARKER);
  if (markerIndex === -1) return { mechanism: "Recurred across independent trend cycles; no further mechanism could be parsed.", mechanismDependsOn: [] };
  const jsonText = finalText.slice(markerIndex + PROMOTION_MECHANISM_MARKER.length).trim();
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    if (typeof parsed.mechanism === "string" && parsed.mechanism.trim().length > 0 && isValidMechanismDependsOn(parsed.mechanismDependsOn)) {
      return { mechanism: parsed.mechanism, mechanismDependsOn: parsed.mechanismDependsOn };
    }
  } catch {
    // fall through to the honest default below
  }
  return { mechanism: "Recurred across independent trend cycles; no further mechanism could be parsed.", mechanismDependsOn: [] };
}

/** Thin, agent-invoking wrapper — zero unit coverage, validated only
 * live. Pure text in/out, no tools. */
export async function articulatePromotedFormatMechanism(format: string, occurrences: FormatOccurrence[]): Promise<{ mechanism: string; mechanismDependsOn: ContextDimension[] }> {
  let finalText = "";
  let isError = false;
  try {
    for await (const message of query({
      prompt: buildPromotionMechanismPrompt(format, occurrences),
      options: {
        model: MODEL,
        permissionMode: "bypassPermissions",
        maxTurns: MAX_TURNS,
        maxBudgetUsd: MAX_BUDGET_USD,
        persistSession: false,
        settingSources: [],
        settings: { disableClaudeAiConnectors: true },
        tools: [],
      },
    })) {
      if (message.type === "result") {
        finalText = message.result ?? "";
        isError = Boolean(message.is_error);
      }
    }
  } catch (err) {
    isError = true;
    finalText = `(agent run threw: ${(err as Error).message})`;
  }
  if (isError) return { mechanism: "Recurred across independent trend cycles; agent run failed before articulating a mechanism.", mechanismDependsOn: [] };
  return parsePromotionMechanism(finalText);
}

/** Pure given an already-articulated mechanism — constructs the
 * `RawCandidate` `pattern-library.ts`'s real ingestion pipeline expects,
 * one observation per real recorded occurrence of this format so Stage 4
 * computes tier from the ACTUAL recurrence history, not a single
 * synthetic "it recurred" observation. */
export function buildPromotionCandidates(
  format: string,
  occurrences: FormatOccurrence[],
  mechanism: string,
  mechanismDependsOn: ContextDimension[],
): RawCandidate[] {
  return occurrences
    .filter((o) => o.format === format)
    .map((o) => ({
      description: `The "${format}" content format recurs across independent trend cycles.`,
      mechanism,
      mechanismDependsOn,
      rawEvidenceTag: "platform_trending",
      sourceDescription: `Recurring trend format observed on ${o.platform} (${o.category}), ${o.detectedAt}`,
      context: { categories: [o.category], platforms: [o.platform] },
    }));
}

/** Thin IO wrapper tying the promotion path together: loads the real
 * pattern library, ingests one candidate per real recorded occurrence
 * (via `pattern-library.ts`'s own `ingestCandidate` — the same Stage 2/3
 * pipeline every other candidate goes through, no shortcut for promoted
 * formats), and persists. Zero unit coverage by nature (calls real
 * agents via `ingestCandidate`), validated only live. */
export async function promoteFormatIntoLibrary(libraryPath: string, format: string, occurrences: FormatOccurrence[], category: string): Promise<PatternLibrary> {
  const { mechanism, mechanismDependsOn } = await articulatePromotedFormatMechanism(format, occurrences);
  const candidates = buildPromotionCandidates(format, occurrences, mechanism, mechanismDependsOn);

  let library = loadPatternLibrary(libraryPath);
  const now = new Date().toISOString();
  for (const candidate of candidates) {
    library = await ingestCandidate(library, candidate, category, now);
  }
  savePatternLibrary(libraryPath, library);
  return library;
}
