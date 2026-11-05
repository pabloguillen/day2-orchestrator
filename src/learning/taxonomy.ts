/**
 * The small fixed vocabulary the outcome library (docs/memory-and-learning.md)
 * speaks in: what kind of app, what kind of change, measured how. Nothing
 * here can carry an app's name, texts or numbers — only these words.
 */

export const CATEGORIES = [
  "games",
  "health_fitness",
  "education",
  "productivity",
  "finance",
  "lifestyle",
  "social",
  "photo_video",
  "music_audio",
  "food_drink",
  "travel",
  "shopping",
  "utilities",
  "kids",
  "news_reading",
  "business",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Families of categories whose users behave alike — "similar apps". */
const FAMILIES: Category[][] = [
  ["health_fitness", "lifestyle", "food_drink"],
  ["productivity", "business", "utilities", "finance"],
  ["education", "kids", "news_reading"],
  ["social", "photo_video", "music_audio"],
  ["games"],
  ["travel", "shopping"],
];

export const PRODUCT_TYPES = ["habit", "routine", "episodic", "work", "transactional", "unknown"] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const PLATFORMS = ["ios", "android", "both", "web"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const METRICS = ["d7_retention", "conversion", "revenue_per_user", "store_conversion", "return_rate", "click_rate", "install_cost"] as const;
export type Metric = (typeof METRICS)[number];

export const METRIC_LABEL: Record<Metric, string> = {
  d7_retention: "D7 retention",
  conversion: "conversion",
  revenue_per_user: "revenue per user",
  store_conversion: "store page conversion",
  return_rate: "users coming back",
  click_rate: "click rate",
  install_cost: "cost per install",
};

/** What a change's effect depends on — how much a result from another category says about this one (pattern-transferability.ts' mechanismDependsOn). */
type DependsOn = "category" | "platform" | "little";

export const CHANGE_KINDS = {
  "onboarding.skip_signup": { label: "Let people try before signing up", depends: "little" },
  "onboarding.length": { label: "Shorter or longer onboarding", depends: "category" },
  "onboarding.copy": { label: "Onboarding wording", depends: "category" },
  "paywall.trial_length": { label: "Free trial length", depends: "category" },
  "paywall.layout": { label: "Paywall layout", depends: "little" },
  "paywall.copy": { label: "Paywall wording", depends: "category" },
  "paywall.timing": { label: "When the paywall shows", depends: "category" },
  "price.tier_change": { label: "Which plans are offered", depends: "category" },
  "price.level": { label: "Price level", depends: "category" },
  "ads.interstitial_frequency": { label: "How often full-screen ads show", depends: "category" },
  "ads.rewarded_placement": { label: "Rewarded ads", depends: "category" },
  "ads.banner": { label: "Banner ads on or off", depends: "little" },
  "push.onboarding_d1": { label: "A push on day 1", depends: "category" },
  "push.winback": { label: "Win-back push for lapsing users", depends: "category" },
  "push.at_risk": { label: "Push for users about to drop off", depends: "category" },
  "push.trigger": { label: "Push when something happens for the user", depends: "little" },
  "push.permission_timing": { label: "When to ask for push permission", depends: "platform" },
  "inapp.message": { label: "In-app message", depends: "category" },
  "store.subtitle_benefit": { label: "Store subtitle that names the benefit", depends: "category" },
  "store.title_keywords": { label: "Store title keywords", depends: "category" },
  "store.keywords": { label: "Store keywords", depends: "category" },
  "store.description": { label: "Store description", depends: "category" },
  "store.promo_text": { label: "Store promotional text", depends: "category" },
  "store.screenshots": { label: "Store screenshots", depends: "category" },
  "store.review_prompt_timing": { label: "When to ask for a rating", depends: "little" },
  "retention.new": { label: "Treatment for new users", depends: "category" },
  "retention.current": { label: "Treatment for current users", depends: "category" },
  "retention.back": { label: "Treatment for returning users", depends: "category" },
  "retention.at_risk": { label: "Treatment for users about to drop off", depends: "category" },
  "retention.lapsing": { label: "Treatment for lapsing users", depends: "category" },
  "acquisition.creative_format": { label: "Ad creative format", depends: "category" },
  "acquisition.channel": { label: "Ad channel", depends: "category" },
  "ui.copy": { label: "Wording in the app", depends: "category" },
  "ui.layout": { label: "Screen layout", depends: "little" },
  "other": { label: "Other change", depends: "category" },
} as const satisfies Record<string, { label: string; depends: DependsOn }>;
export type ChangeKind = keyof typeof CHANGE_KINDS;
export const isChangeKind = (v: unknown): v is ChangeKind => typeof v === "string" && Object.prototype.hasOwnProperty.call(CHANGE_KINDS, v);
export const isCategory = (v: unknown): v is Category => typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);

/**
 * How much a result from category `b` says about an app in category `a`,
 * for a kind of change: 1 same category, a family member less, others least
 * — and kinds whose effect hardly depends on the category transfer more.
 */
export function similarity(a: Category, b: Category, kind: ChangeKind): number {
  const depends = CHANGE_KINDS[kind].depends;
  if (a === b) return 1;
  const family = FAMILIES.some((f) => f.includes(a) && f.includes(b));
  if (depends === "category") return family ? 0.5 : 0.15;
  return family ? 0.8 : 0.5;
}

/** Same family (what "similar apps" counts). */
export const similarApps = (a: Category, b: Category) => a === b || FAMILIES.some((f) => f.includes(a) && f.includes(b));

const CATEGORY_WORDS: Array<[Category, RegExp]> = [
  ["kids", /\b(kid|kids|child|children|toddler|preschool|kinder)\b/i],
  ["games", /\b(game|games|puzzle|arcade|quiz|trivia|spiel)\b/i],
  ["health_fitness", /\b(fitness|workout|health|meditat\w*|sleep|yoga|running|diet|calorie|habit|wellbeing|mental)\b/i],
  ["education", /\b(learn\w*|language|course|study|school|teach\w*|lesson|vocabulary|flashcard)\b/i],
  ["finance", /\b(budget\w*|finance|money|expense\w*|invest\w*|bank\w*|saving|tax)\b/i],
  ["productivity", /\b(task|todo|to-do|notes?|productiv\w*|calendar|planner|focus|timer)\b/i],
  ["food_drink", /\b(recipe\w*|cook\w*|meal|food|restaurant|drink|coffee)\b/i],
  ["travel", /\b(travel|trip|flight|hotel|map|booking)\b/i],
  ["shopping", /\b(shop\w*|store|marketplace|deal\w*|e-?commerce)\b/i],
  ["social", /\b(chat|social|friends|community|dating|messag\w*)\b/i],
  ["photo_video", /\b(photo\w*|video\w*|camera|edit\w*)\b/i],
  ["music_audio", /\b(music|audio|podcast|radio|song\w*)\b/i],
  ["news_reading", /\b(news|reading|books?|magazine|article\w*)\b/i],
  ["business", /\b(crm|team\w*|business|invoice\w*|sales|client\w*)\b/i],
  ["lifestyle", /\b(lifestyle|journal\w*|diary|dating|fashion|home)\b/i],
  ["utilities", /\b(tool|utility|scanner|converter|calculator|weather)\b/i],
];

/** The app's category from what day2 knows about it (store category, research, purpose). */
export function categorize(...texts: Array<string | null | undefined>): Category {
  for (const t of texts) {
    if (!t) continue;
    const direct = t.toLowerCase().replace(/[^a-z]+/g, "_");
    if (isCategory(direct)) return direct;
    for (const [c, re] of CATEGORY_WORDS) if (re.test(t)) return c;
  }
  return "other";
}

export const N_BUCKETS = ["<100", "100-1k", "1k-10k", "10k+"] as const;
export type NBucket = (typeof N_BUCKETS)[number];

/** Sizes only as buckets — never a user count. */
export function nBucket(n: number): NBucket {
  if (n < 100) return "<100";
  if (n < 1000) return "100-1k";
  if (n < 10_000) return "1k-10k";
  return "10k+";
}

/** Which kind of change a Live experiment is, from the settings it changes. */
export function kindForKeys(keys: string[], title = ""): ChangeKind {
  const k = `${keys.join(" ")} ${title}`.toLowerCase();
  if (/trial/.test(k)) return "paywall.trial_length";
  if (/price|tier|plan_?s?\b/.test(k)) return /tier|plans?\b/.test(k) ? "price.tier_change" : "price.level";
  if (/paywall/.test(k)) return /layout|order|highlight|design/.test(k) ? "paywall.layout" : /when|timing|after|placement|show/.test(k) ? "paywall.timing" : "paywall.copy";
  if (/interstitial|ads?\.(freq|every|cap)|frequency/.test(k)) return "ads.interstitial_frequency";
  if (/reward/.test(k)) return "ads.rewarded_placement";
  if (/banner/.test(k)) return "ads.banner";
  if (/sign_?up|signup|account|login|skip/.test(k)) return "onboarding.skip_signup";
  if (/onboard/.test(k)) return /steps|length|pages|screens/.test(k) ? "onboarding.length" : "onboarding.copy";
  if (/permission|push\.ask|notif\w*\.ask/.test(k)) return "push.permission_timing";
  if (/review|rating/.test(k)) return "store.review_prompt_timing";
  if (/title|text|copy|label|cta|button|headline/.test(k)) return "ui.copy";
  if (/layout|order|position|color|colour|size/.test(k)) return "ui.layout";
  return "other";
}
