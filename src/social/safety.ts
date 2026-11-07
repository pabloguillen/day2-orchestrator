import type { Post, Target } from "./types";

/**
 * The content safety check every post passes before the owner sees it (and
 * again after every edit). Deterministic rules here; day2's two independent
 * agent checks (truthful claims, authenticity — growth-creative.ts) run on
 * new drafts too. A post with issues can't be approved until they're fixed.
 *
 * Rules: no invented numbers, stats, rankings or testimonials; no competitor
 * names; no medical or financial promises; nothing unsuitable for a young
 * audience; no personal data (emails, phone numbers, handles of real
 * people); platform basics (caption length, hashtag counts).
 */

export type SafetyInput = {
  appName: string;
  /** Competitors day2's research found (names only). */
  competitors: string[];
  /** Numbers the app's real features mention (allowed). */
  allowedNumbers?: string[];
  /** The only links a post may contain: the app's smart link and its own website (URL prefixes). */
  allowedLinks?: string[];
};

const URLISH = /\bhttps?:\/\/[^\s)"'<>]+|\bwww\.[^\s)"'<>]+|\b(?:[a-z0-9][a-z0-9-]*\.)+(?:com|de|net|org|io|app|ly|me|co|info|xyz|link|gg|tv|at|ch|eu|uk|us|shop|site|online|page|to|so|ai)\b(?:\/[^\s)"'<>]*)?/gi;

/** Every link or bare domain in a text. Pure. */
export function linksIn(text: string): string[] {
  return [...text.matchAll(URLISH)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
}

/** A link is allowed when it is (under) one of the allowed URL prefixes. Pure. */
export function linkAllowed(link: string, allowed: string[]): boolean {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
  } catch {
    return false;
  }
  return allowed.some((a) => {
    try {
      const p = new URL(a);
      return u.hostname.toLowerCase() === p.hostname.toLowerCase() && (u.pathname === p.pathname || u.pathname.startsWith(p.pathname.endsWith("/") ? p.pathname : `${p.pathname}/`) || p.pathname === "/");
    } catch {
      return false;
    }
  });
}

/** Whether any of a post's words contain a link (such posts never go out on their own). Pure. */
export const postHasLink = (p: Pick<Post, "targets" | "idea">) => linksIn([p.idea.title, ...p.targets.map((t) => t.caption)].join(" ")).length > 0;

const STAT = /(\b\d{1,3}([.,]\d+)?\s?%|\b\d+([.,]\d+)?\s?(k|m|mio\.?|tsd\.?|million(en)?|tausend|thousand)\b|\b\d[\d.,]*\s?\+?\s?(users|nutzer\w*|downloads|people|menschen|kund\w*|customers|reviews|bewertungen|sterne|stars)\b|\b(nr\.?|no\.?|number|nummer)\s?1\b|#1\b|\btop[- ]?\d+\b|\bplatz\s?1\b)/i;
const TESTIMONIAL = /\b(says?|sagt|meint)\b.{0,40}["„“]|["„“][^"„“”]{8,}["”]\s*[-–—]\s*\p{Lu}/u;
const SUPERLATIVE = /\b(best(e[nrs]?)?|beste|bestes|world'?s|weltweit|einzige[nrs]?|only app|die einzige|garantiert|guaranteed|100 ?%)\b/i;
const MEDICAL = /\b(heil\w*|cure[sd]?|heal(s|ing)?|therap\w*|diagnos\w*|depress\w*|anxiety|angststörung\w*|adhs|adhd|abnehm\w*|lose weight|weight loss|medizin\w*|medical|clinically|klinisch|arzt|doctor)\b/i;
const FINANCIAL = /\b(geld verdienen|earn money|make money|passives? einkommen|passive income|reich werden|get rich|invest\w*|rendite|returns?|krypto\w*|crypto\w*|gewinn(e|en)? garantiert|kredit\w*|loan|schulden)\b/i;
const ADULT = /\b(sex\w*|porn\w*|nackt|nude|alkohol\w*|alcohol|beer|bier|wein|wine|vodka|rauch\w*|smok\w*|vape\w*|cigarette\w*|zigarette\w*|drug\w*|droge\w*|cannabis|weed|gambl\w*|glücksspiel\w*|casino|wett(e|en)|bet(s|ting)?|waffe\w*|weapon\w*|gun|kill\w*|töte\w*|blut\w*|blood)\b/i;
const SHAMING = /\b(fett|fat|ugly|hässlich|loser|dumm|stupid|idiot)\b/i;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const PHONE = /(\+\d{1,3}[\s-]?)?\(?\d{2,5}\)?[\s-]?\d{3,4}[\s-]?\d{3,5}/;
const HANDLE = /(^|\s)@[A-Za-z0-9_.]{3,}/;

export const CAPTION_MAX: Record<Target["platform"], number> = { instagram: 2200, facebook: 5000, tiktok: 2200 };
export const HASHTAG_MAX: Record<Target["platform"], number> = { instagram: 30, facebook: 10, tiktok: 10 };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Issues in one piece of text. Pure. */
export function textIssues(text: string, s: SafetyInput): string[] {
  const out: string[] = [];
  const t = text.replace(new RegExp(EMAIL.source, "g"), " ").replace(URLISH, " ").replace(new RegExp(esc(s.appName), "gi"), "the app");
  const allowed = (s.allowedNumbers ?? []).map((n) => n.toLowerCase());
  const stat = STAT.exec(t);
  if (stat && !allowed.some((a) => a.includes(stat[0].toLowerCase().trim()))) out.push(`a number or ranking day2 can't back up ("${stat[0].trim()}")`);
  if (TESTIMONIAL.test(t)) out.push("reads like a quote from a real person");
  const sup = SUPERLATIVE.exec(t);
  if (sup) out.push(`a claim that can't be proven ("${sup[0]}")`);
  const med = MEDICAL.exec(t);
  if (med) out.push(`sounds like a health or medical promise ("${med[0]}")`);
  const fin = FINANCIAL.exec(t);
  if (fin) out.push(`sounds like a money or finance promise ("${fin[0]}")`);
  const adult = ADULT.exec(t);
  if (adult) out.push(`not right for a young audience ("${adult[0]}")`);
  if (SHAMING.test(t)) out.push("could shame or hurt someone");
  for (const c of s.competitors) if (c.trim().length >= 3 && new RegExp(`\\b${esc(c.trim())}\\b`, "i").test(t)) out.push(`names a competitor (${c.trim()})`);
  if (EMAIL.test(text)) out.push("contains an email address");
  if (PHONE.test(t.replace(STAT, ""))) out.push("contains what looks like a phone number");
  if (HANDLE.test(t)) out.push("mentions someone's account (@…)");
  for (const l of linksIn(text.replace(new RegExp(EMAIL.source, "g"), " "))) if (!linkAllowed(l, s.allowedLinks ?? [])) out.push(`a link that isn't the app's own (${l.slice(0, 60)})`);
  return out;
}

/** Every issue in a post's words, per platform. Pure. */
export function checkPost(p: Pick<Post, "targets" | "idea">, s: SafetyInput): string[] {
  const issues = new Set<string>();
  for (const i of textIssues(p.idea.title, s)) issues.add(`On the video: ${i}`);
  for (const t of p.targets) {
    const label = t.platform === "instagram" ? "Instagram" : t.platform === "facebook" ? "Facebook" : "TikTok";
    for (const i of textIssues(`${t.caption} ${t.hashtags.join(" ")}`, s)) issues.add(`${label}: ${i}`);
    const full = t.caption.length + t.hashtags.reduce((n, h) => n + h.length + 2, 0);
    if (full > CAPTION_MAX[t.platform]) issues.add(`${label}: the text is longer than ${CAPTION_MAX[t.platform]} characters`);
    if (t.hashtags.length > HASHTAG_MAX[t.platform]) issues.add(`${label}: more than ${HASHTAG_MAX[t.platform]} hashtags`);
    if ((t.caption.match(/#/g) ?? []).length + t.hashtags.length > 30 && t.platform === "instagram") issues.add("Instagram: more than 30 hashtags in total");
  }
  return [...issues];
}

/** Hashtags as day2 stores them: no #, no spaces, letters/digits/underscore, unique. */
export function cleanHashtags(v: unknown, max = 10): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const h of v) {
    if (typeof h !== "string") continue;
    const t = h.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "").slice(0, 40);
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out.slice(0, max);
}
