/**
 * The strict filter in front of everything day2 remembers (app memory) and
 * shares (the cross-app outcome library). Two jobs:
 *  - `scrub`: redact secrets and personal data from owner input before an
 *    agent ever reads it;
 *  - `unsafeReason`: refuse to store a memory item that still contains
 *    anything that looks like a secret or data about an end user.
 * Prompts tell the memory keeper the same rules; this is the part that
 * doesn't depend on the agent listening.
 */

/** `keep`: a match that is fine after all (a date isn't a phone number). */
type Pattern = { name: string; re: RegExp; keep?: (m: string) => boolean };

const digits = (m: string) => m.replace(/\D/g, "").length;
const isDateOrVersion = (m: string) => /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(m.trim()) || /^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(m.trim()) || /^\d+(\.\d+){1,3}$/.test(m.trim());

/** Shannon entropy in bits per character. */
export function entropy(t: string): number {
  const counts = new Map<string, number>();
  for (const c of t) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / t.length) * Math.log2(n / t.length);
  return h;
}

/**
 * A random-looking token (a key, a secret, a signature) rather than a word,
 * a setting name, a camelCase identifier, a path or a URL: mixed case with
 * several digits, or base64 symbols with mixed case, and high entropy.
 */
export function looksRandom(m: string): boolean {
  const t = m.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9=]+$/g, "");
  if (t.length < 20) return false;
  const count = (re: RegExp) => (t.match(re) ?? []).length;
  const up = count(/[A-Z]/g);
  const lo = count(/[a-z]/g);
  const dg = count(/\d/g);
  const sym = count(/[+/=]/g);
  const mixed = (dg >= 3 && up >= 2 && lo >= 2) || (sym >= 1 && up >= 3 && lo >= 3) || (dg >= 8 && up + lo >= 8);
  return mixed && entropy(t) >= 3.5;
}

const KEEP_VERSION_TAGS = /^(latest|next|beta|alpha|canary|rc|stable|nightly|legacy)$/i;

/** Secrets: API keys, tokens, private keys, passwords. */
const SECRETS: Pattern[] = [
  { name: "a private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { name: "an API key", re: /\b(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}\b/g },
  { name: "a GitHub token", re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: "a GitLab token", re: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
  { name: "a webhook secret", re: /\bwhsec_[A-Za-z0-9+/=_-]{12,}/g },
  { name: "an AWS key", re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "a Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: "a Google key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: "a token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  // A short prefix and a mixed-case or digit-heavy tail: tokens of services day2 doesn't know by name.
  { name: "a token", re: /\b[a-z]{2,10}[-_](?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Z]|(?:[A-Za-z0-9_-]*\d){4})[A-Za-z0-9_-]{12,}/g },
  { name: "a password", re: /\b(password|passwort|passwd|pwd|passcode|pin|secret|token|api[ _-]?key|access[ _-]?key|secret[ _-]?key)\s*(?:is|was|ist|=|:)\s*["'“]?\S{3,}/gi },
  { name: "a password", re: /\b(password|passwort|passwd|pwd|secret|token|api[ _-]?key|access[ _-]?key|secret[ _-]?key)\s+["'“]?(?:(?=\S*\d)\S{6,}|(?=\S*[A-Z])(?=\S*[a-z])\S{12,})/gi },
  { name: "a URL with credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@\S+/gi },
  { name: "a URL with a key", re: /\bhttps?:\/\/\S*[?&](key|token|sig|signature|secret|access_token|auth)=\S+/gi },
  // Long random-looking strings (mixed letters and digits, 32+ chars): keys, hashes, ids.
  { name: "a key or id", re: /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g },
  // Shorter random-looking tokens, base64 included (an AWS secret key has / and +).
  { name: "a key or secret", re: /[A-Za-z0-9+/=_-]{20,}/g, keep: (m) => !looksRandom(m) },
];

/** Personal data about the app's users. */
const PERSONAL: Pattern[] = [
  // Unicode names and hosts too (jürgen@münchen.de, jane@localhost); "pkg@latest" is a version, not an address.
  { name: "an email address", re: /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@\p{L}[\p{L}\p{N}-]*(?:\.[\p{L}\p{N}-]+)*/gu, keep: (m) => KEEP_VERSION_TAGS.test(m.split("@")[1] ?? "") },
  { name: "an email address", re: /[\p{L}\p{N}._%+-]+\s*(?:\[at\]|\(at\)|\{at\}|\sat\s)\s*[\p{L}\p{N}-]+\s*(?:\[dot\]|\(dot\)|\{dot\}|\sdot\s)\s*\p{L}{2,}/giu },
  { name: "a phone number", re: /(?<![\w.])\+?\d[\d ()./-]{7,}\d(?![\w.])/g, keep: (m) => digits(m) < 8 || isDateOrVersion(m) },
  { name: "a card or account number", re: /\b(?:\d[ -]?){13,19}\b/g },
  // With or without spaces, any case, a shorter last group.
  { name: "an IBAN", re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{1,4}){3,8}\b/gi, keep: (m) => digits(m) < 10 },
  { name: "an IP address", re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { name: "a device or user id", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { name: "a hashed user", re: /\bu_[a-z0-9]{8,}\b/gi },
  { name: "a push token", re: /\bExpo(nent)?PushToken\[[^\]]+\]/g },
  // "Jane Miller complained / said / wrote …" — someone by name. Plain names elsewhere aren't caught (see docs).
  {
    name: "a person's name",
    re: /\b(?!(?:The|Our|Your|My|An?|This|That|These|Those|Apple|Google|App|Play|Store|Every|Each|Most|Many|Some|One|Two|All|No|Our)\b)[A-Z][a-z]{1,15} [A-Z][a-z]{1,20} (?:complained|said|wrote|emailed|reported|called|asked|messaged|mentioned|told|tweeted|posted)\b/g,
  },
];

/** Words that say the text is about one particular end user. */
const ABOUT_A_USER = /\b(user|customer|subscriber|kunde|nutzer|player)\s+(named|called|with the (e-?mail|name|id)|#?\d{3,})\b/i;

/** Redacts secrets and personal data. Used on owner input before an agent reads it. */
export function scrub(text: string): string {
  let out = text;
  for (const p of SECRETS) out = out.replace(p.re, (m) => (p.keep?.(m) ? m : "[secret removed]"));
  for (const p of PERSONAL) out = out.replace(p.re, (m) => (p.keep?.(m) ? m : "[personal data removed]"));
  return out;
}

/** Why a text can't be remembered or shared (null: it's fine). */
export function unsafeReason(text: string): string | null {
  for (const p of [...SECRETS, ...PERSONAL]) {
    const hits = text.match(p.re) ?? [];
    if (hits.some((m) => !p.keep?.(m))) return `it looks like it contains ${p.name}`;
  }
  if (ABOUT_A_USER.test(text)) return "it looks like it's about one particular user";
  if (/\[(secret|personal data) removed\]/.test(text)) return "it refers to something the privacy filter removed";
  return null;
}

/** Short, single-line, plain text. */
export function tidy(text: string, max = 280): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
