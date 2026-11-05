import { createHash } from "node:crypto";
import { sandboxConfig } from "../agent-sandbox";
import { meteredQuery } from "../metered-query";
import type { AppProfile } from "../onboarding";
import { APPLE_CATEGORIES } from "./setup-asc";
import { afterMarker } from "./research";
import type { ContentAnswers, GuidedKey, WalkStep } from "./setup-types";

/**
 * What day2 reads out of the app's code for store setup — in one agent run
 * (Read/Grep/Glob only): the facts it proposes (links, contact, categories,
 * whether sign-in is needed), Apple's age rating answers, and the answers
 * for Google Play's forms that have no API (content rating, target
 * audience, ads, declarations). Pure prompt, parser and answer builders.
 */

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
const MARKER = "STORE_SETUP_JSON:";
export const ANSWERS_MAX_USD = 0.8;

// ---- Apple's age rating questionnaire (ageRatingDeclarations attributes) ----

/** Frequency questions: NONE, INFREQUENT_OR_MILD, FREQUENT_OR_INTENSE. */
export const AGE_FREQUENCY: Array<[string, string]> = [
  ["violenceCartoonOrFantasy", "Cartoon or fantasy violence"],
  ["violenceRealistic", "Realistic violence"],
  ["violenceRealisticProlongedGraphicOrSadistic", "Prolonged, graphic or sadistic realistic violence"],
  ["gunsOrOtherWeapons", "Guns or other weapons"],
  ["sexualContentOrNudity", "Sexual content or nudity"],
  ["sexualContentGraphicAndNudity", "Graphic sexual content and nudity"],
  ["profanityOrCrudeHumor", "Profanity or crude humor"],
  ["alcoholTobaccoOrDrugUseOrReferences", "Alcohol, tobacco or drug use or references"],
  ["matureOrSuggestiveThemes", "Mature or suggestive themes"],
  ["horrorOrFearThemes", "Horror or fear themes"],
  ["medicalOrTreatmentInformation", "Medical or treatment information"],
  ["gamblingSimulated", "Simulated gambling"],
  ["contests", "Contests"],
];
/** Yes/no questions, including the 2025 questionnaire's capabilities and age assurance. */
export const AGE_BOOLEAN: Array<[string, string]> = [
  ["gambling", "Real-money gambling"],
  ["lootBox", "Loot boxes (paid random items)"],
  ["unrestrictedWebAccess", "Unrestricted web access (an in-app browser to any site)"],
  ["userGeneratedContent", "User-generated content others can see"],
  ["messagingAndChat", "Messaging or chat between users"],
  ["advertising", "Advertising"],
  ["healthOrWellnessTopics", "Health or wellness topics"],
  ["parentalControls", "Parental controls"],
  ["ageAssurance", "Age assurance (the app checks users' age)"],
];
export const FREQUENCY_VALUES: Array<[string, string]> = [
  ["NONE", "None"],
  ["INFREQUENT_OR_MILD", "Infrequent or mild"],
  ["FREQUENT_OR_INTENSE", "Frequent or intense"],
];
export const AGE_OVERRIDE_VALUES = ["NONE", "NINE_PLUS", "THIRTEEN_PLUS", "SIXTEEN_PLUS", "EIGHTEEN_PLUS", "UNRATED"];

/** Pure. A complete, valid declaration from whatever the agent (or the owner) gave; unknown answers default to the safe "none"/"no". */
export function normalizeAgeRating(raw: Record<string, unknown> | null | undefined): Record<string, string | boolean | null> {
  const r = raw ?? {};
  const out: Record<string, string | boolean | null> = {};
  const levels = FREQUENCY_VALUES.map(([v]) => v);
  const legacy: Record<string, string> = { INFREQUENT: "INFREQUENT_OR_MILD", FREQUENT: "FREQUENT_OR_INTENSE" };
  for (const [k] of AGE_FREQUENCY) {
    const v = typeof r[k] === "string" ? (legacy[r[k] as string] ?? (r[k] as string)) : "NONE";
    out[k] = levels.includes(v) ? v : "NONE";
  }
  for (const [k] of AGE_BOOLEAN) out[k] = r[k] === true || r[k] === "true";
  out.kidsAgeBand = ["FIVE_AND_UNDER", "SIX_TO_EIGHT", "NINE_TO_ELEVEN"].includes(String(r.kidsAgeBand)) ? String(r.kidsAgeBand) : null;
  out.ageRatingOverrideV2 = AGE_OVERRIDE_VALUES.includes(String(r.ageRatingOverrideV2)) ? String(r.ageRatingOverrideV2) : "NONE";
  return out;
}

// ---- The agent ----

export function buildAnswersPrompt(i: { appName: string; profile: AppProfile | null; usesAds: boolean; purchases: boolean }): string {
  return `You prepare ${i.appName}'s App Store Connect and Google Play setup. The app's code is in the current directory: read it (Read/Grep/Glob only). Answer only from what you find; where the code says nothing, use the safe default given.
${i.profile ? `\nWhat day2 knows: ${i.profile.purpose} For: ${i.profile.targetUsers}. Features: ${i.profile.featureMap.join("; ")}.` : ""}
day2 knows: in-app ads ${i.usesAds ? "yes" : "no"}; in-app purchases ${i.purchases ? "yes" : "no"}.

Find:
1. Links: privacy policy URL, privacy choices URL (a page where users manage their data; "" if none), support URL, marketing (website) URL — from the app config, README, settings/about screens, legal screens. "" when not found; never invent a URL.
2. Contact: a support email and phone shown in the app or README ("" if none). The copyright holder (company or person, e.g. from package.json author, LICENSE or the about screen).
3. Categories: Apple primary and secondary category (one of ${APPLE_CATEGORIES.join(", ")}; secondary may be ""); the Google Play category (its English name, e.g. "Productivity") and up to 5 Play tags (short English phrases).
4. Third-party content: does the app show, play or access content it doesn't own (other people's music, videos, articles, a feed from another service)?
5. Sign-in: can a reviewer see the main features without an account? If not, signInRequired = true, and reviewNotes explains in 2–4 plain sentences where to sign in and what to try (no credentials).
6. Apple's age rating — every one of these keys:
   frequency (NONE | INFREQUENT_OR_MILD | FREQUENT_OR_INTENSE): ${AGE_FREQUENCY.map(([k]) => k).join(", ")};
   true/false: ${AGE_BOOLEAN.map(([k]) => k).join(", ")}.
   Base each on the app's real content and features (chat, user posts, web views, ads SDKs, health topics, age checks, parental controls).
7. Google Play: target age groups (any of "13-15", "16-17", "18+"; include younger groups like "9-12" only if the app is made for children), whether the listing could appeal to children, contains ads, whether it is a news app, a health app, offers financial features (payments, loans, crypto, banking), or is a government app; and contentNotes: 2–4 sentences describing violence, sexual content, language, controlled substances, gambling, user interaction, location sharing and digital purchases for the IARC questionnaire.
8. free: true unless the code clearly expects a paid download.

End with this marker on its own line, then JSON, nothing after:
${MARKER}
{"facts":{"privacyPolicyUrl":"","privacyChoicesUrl":"","supportUrl":"","marketingUrl":"","contactEmail":"","contactPhone":"","copyrightHolder":"","primaryCategory":"","secondaryCategory":"","playCategory":"","playTags":[],"usesThirdPartyContent":false,"signInRequired":false,"reviewNotes":"","free":true},
"ageRating":{"violenceCartoonOrFantasy":"NONE","userGeneratedContent":false},
"play":{"targetAges":["18+"],"appealsToChildren":false,"containsAds":false,"news":false,"health":false,"financial":false,"government":false,"sharesLocation":false,"contentNotes":""},
"why":{"ios.categories":"…","ios.ageRating":"…","ios.review":"…","ios.privacyUrls":"…"}}`;
}

const url = (v: unknown) => (typeof v === "string" && /^https?:\/\/[^\s]+\.[^\s]+$/i.test(v.trim()) ? v.trim() : "");
const str = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const bool = (v: unknown) => v === true || v === "true";

/** Pure. The agent's answer, checked: bad URLs and unknown categories dropped, every age rating key present. Null when unusable. */
export function parseAnswers(text: string): ContentAnswers | null {
  const raw = afterMarker(text, MARKER) as { facts?: Record<string, unknown>; ageRating?: Record<string, unknown>; play?: Record<string, unknown>; why?: Record<string, unknown> } | null;
  if (!raw || typeof raw !== "object" || !raw.facts) return null;
  const f = raw.facts;
  const cat = (v: unknown) => (typeof v === "string" && APPLE_CATEGORIES.includes(v.trim().toUpperCase()) ? v.trim().toUpperCase() : "");
  const email = str(f.contactEmail, 120);
  const p = raw.play ?? {};
  const ages = Array.isArray(p.targetAges) ? p.targetAges.filter((a): a is string => typeof a === "string" && /^(\d{1,2}-\d{1,2}|\d{1,2}\+|5 and under)$/.test(a)) : [];
  const primary = cat(f.primaryCategory);
  const secondary = cat(f.secondaryCategory);
  return {
    facts: {
      privacyPolicyUrl: url(f.privacyPolicyUrl),
      privacyChoicesUrl: url(f.privacyChoicesUrl),
      supportUrl: url(f.supportUrl),
      marketingUrl: url(f.marketingUrl),
      contactEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "",
      contactPhone: str(f.contactPhone, 40),
      copyrightHolder: str(f.copyrightHolder, 100),
      primaryCategory: primary,
      secondaryCategory: secondary === primary ? "" : secondary,
      playCategory: str(f.playCategory, 40),
      playTags: Array.isArray(f.playTags) ? f.playTags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean).slice(0, 5) : [],
      usesThirdPartyContent: bool(f.usesThirdPartyContent),
      signInRequired: bool(f.signInRequired),
      reviewNotes: str(f.reviewNotes, 3800),
      free: f.free !== false,
    },
    ageRating: normalizeAgeRating(raw.ageRating),
    play: {
      targetAges: ages.length ? ages : ["18+"],
      appealsToChildren: bool(p.appealsToChildren),
      containsAds: bool(p.containsAds),
      news: bool(p.news),
      health: bool(p.health),
      financial: bool(p.financial),
      government: bool(p.government),
      contentNotes: str(p.contentNotes, 1200) + (bool(p.sharesLocation) ? " The app shares the user's location with other users." : ""),
    },
    why: Object.fromEntries(Object.entries(raw.why ?? {}).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, str(v, 300)])),
  };
}

/** One agent run over the app's code (metered to the current credit context). */
export async function deriveAnswers(repoPath: string, i: Parameters<typeof buildAnswersPrompt>[0]): Promise<ContentAnswers | null> {
  let text = "";
  for await (const m of meteredQuery("agent_work", "Store setup answers")({
    prompt: buildAnswersPrompt(i),
    options: { cwd: repoPath, model: MODEL, permissionMode: "bypassPermissions", maxTurns: 25, maxBudgetUsd: ANSWERS_MAX_USD, persistSession: false, settingSources: [], settings: { disableClaudeAiConnectors: true }, tools: ["Read", "Grep", "Glob"], sandbox: sandboxConfig() },
  })) {
    const msg = m as { type?: string; result?: string };
    if (msg.type === "result") text = msg.result ?? "";
  }
  return parseAnswers(text);
}

// ---- Guided steps (no API) ----

export type Guided = { title: string; where: string; answers: Array<{ q: string; a: string }>; steps: WalkStep[] };

const yes = (b: boolean) => (b ? "Yes" : "No");
const PLAY_CONSOLE = { label: "Open the Play Console", url: "https://play.google.com/console" };

function appContentSteps(appName: string, section: string, answers: Array<{ q: string; a: string }>, finish = "Click Save. Google may review the answer; your app stays available meanwhile."): WalkStep[] {
  return [
    { title: `Open ${section}`, detail: `Sign in to the Play Console, open ${appName}, then in the left menu: Policy and programs → App content. Find "${section}" and click Start (or Manage).`, link: PLAY_CONSOLE },
    ...answers.map((x, i) => ({ title: `Question ${i + 1} of ${answers.length}`, detail: `${x.q}\n\nAnswer: ${x.a}` })),
    { title: "Save", detail: finish },
  ];
}

/** Pure. The IARC content rating answers from the age rating facts and what day2 knows. */
export function contentRatingAnswers(a: ContentAnswers, o: { contactEmail: string; purchases: boolean; ageRating: Record<string, unknown> }): Array<{ q: string; a: string }> {
  const r = o.ageRating;
  const some = (...keys: string[]) => keys.some((k) => r[k] && r[k] !== "NONE");
  const game = a.facts.primaryCategory === "GAMES";
  return [
    { q: "Email address (IARC sends the rating certificate here)", a: o.contactEmail || "your developer contact email" },
    { q: "Category", a: game ? "Game" : a.facts.primaryCategory === "SOCIAL_NETWORKING" ? "Social Networking, Forums, Blogs and UGC Sharing" : a.facts.primaryCategory === "NEWS" || a.facts.primaryCategory === "REFERENCE" || a.facts.primaryCategory === "EDUCATION" ? "Reference, News, or Educational" : a.facts.primaryCategory === "ENTERTAINMENT" ? "Entertainment" : "All Other App Types" },
    { q: "Does the app contain violence?", a: some("violenceCartoonOrFantasy", "violenceRealistic", "violenceRealisticProlongedGraphicOrSadistic", "gunsOrOtherWeapons") ? "Yes — answer the follow-ups as described in the notes below" : "No" },
    { q: "Does the app contain sexual content or nudity?", a: yes(some("sexualContentOrNudity", "sexualContentGraphicAndNudity")) },
    { q: "Does the app contain offensive language or crude humor?", a: yes(some("profanityOrCrudeHumor")) },
    { q: "Does the app reference or show alcohol, tobacco or drugs?", a: yes(some("alcoholTobaccoOrDrugUseOrReferences")) },
    { q: "Does the app contain fear or horror themes?", a: yes(some("horrorOrFearThemes")) },
    { q: "Does the app contain gambling (simulated or real money)?", a: yes(Boolean(r.gambling) || some("gamblingSimulated")) },
    { q: "Can users interact or exchange content with each other?", a: yes(Boolean(r.messagingAndChat) || Boolean(r.userGeneratedContent)) },
    { q: "Does the app share the user's current location with other users?", a: yes(/shares the user's location/.test(a.play.contentNotes)) },
    { q: "Does the app allow users to purchase digital goods?", a: yes(o.purchases || Boolean(r.lootBox)) },
    { q: "Does the app give unrestricted access to the internet (a browser)?", a: yes(Boolean(r.unrestrictedWebAccess)) },
    ...(a.play.contentNotes ? [{ q: "What these answers rest on (day2's notes from the code)", a: a.play.contentNotes }] : []),
  ];
}

/** Pure. Every guided Google Play step day2 prepares, with its answers and walkthrough. */
export function guidedPlay(a: ContentAnswers, o: { appName: string; contactEmail: string; containsAds: boolean; purchases: boolean; signInRequired: boolean; ageRating: Record<string, unknown> }): Partial<Record<GuidedKey, Guided>> {
  const rating = contentRatingAnswers(a, o);
  const audience = [
    { q: "Target age groups", a: a.play.targetAges.join(", ") },
    { q: "Could your store listing unintentionally appeal to children?", a: yes(a.play.appealsToChildren) },
  ];
  const ads = [{ q: "Does your app contain ads?", a: o.containsAds ? "Yes, my app contains ads" : "No, my app does not contain ads" }];
  const access = o.signInRequired
    ? [
        { q: "App access", a: "All or some functionality in my app is restricted" },
        { q: "Instructions (Add instructions)", a: "Name: Demo account. Username and password: the demo account you entered on the App Review item in day2 (day2 never shows it again). Any other information: " + (a.facts.reviewNotes || "Sign in on the first screen.") },
      ]
    : [{ q: "App access", a: "All functionality in my app is available without any access restrictions" }];
  const decl = [
    { q: "News apps: Is your app a news app?", a: yes(a.play.news) },
    { q: "Health apps: Does your app have health features?", a: a.play.health ? "Yes — tick the health features the app has" : "My app does not have any health features" },
    { q: "Financial features: Does your app provide financial features?", a: a.play.financial ? "Yes — tick the features the app offers" : "My app doesn't provide any financial features" },
    { q: "Government apps: Is your app developed by or for a government?", a: yes(a.play.government) },
  ];
  const category = [
    { q: "App or game", a: a.facts.primaryCategory === "GAMES" ? "Game" : "App" },
    { q: "Category", a: a.facts.playCategory || "Pick the closest category" },
    ...(a.facts.playTags.length ? [{ q: "Tags (Manage tags → add up to 5)", a: a.facts.playTags.join(", ") }] : []),
  ];
  return {
    "android.contentRating": { title: "Content rating", where: "App content → Content rating", answers: rating, steps: appContentSteps(o.appName, "Content rating", rating, "Click Save, then Submit. IARC sends the rating to the email above; it shows on the store page within a few hours.") },
    "android.targetAudience": { title: "Target audience and content", where: "App content → Target audience and content", answers: audience, steps: appContentSteps(o.appName, "Target audience and content", audience) },
    "android.ads": { title: "Ads", where: "App content → Ads", answers: ads, steps: appContentSteps(o.appName, "Ads", ads) },
    "android.appAccess": { title: "App access", where: "App content → App access", answers: access, steps: appContentSteps(o.appName, "App access", access) },
    "android.declarations": { title: "News, health, financial and government declarations", where: "App content", answers: decl, steps: appContentSteps(o.appName, "News apps", decl, "Each declaration is its own section on App content: open each one (News apps, Health apps, Financial features, Government apps), answer as above and Save.") },
    "android.category": {
      title: "Category and tags",
      where: "Grow users → Store presence → Store settings",
      answers: category,
      steps: [
        { title: "Open Store settings", detail: `Sign in to the Play Console, open ${o.appName}, then in the left menu: Grow users → Store presence → Store settings.`, link: PLAY_CONSOLE },
        ...category.map((x, i) => ({ title: `Step ${i + 1} of ${category.length}`, detail: `${x.q}\n\nAnswer: ${x.a}` })),
        { title: "Save", detail: "Click Save. The category shows on the store page right away." },
      ],
    },
  };
}

/** Changes when the answers change, so a confirmed step comes back when day2's answers do. */
export const answersVersion = (answers: Array<{ q: string; a: string }>) => createHash("sha256").update(JSON.stringify(answers)).digest("hex").slice(0, 12);
