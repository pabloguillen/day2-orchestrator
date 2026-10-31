import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { NewTicketInput } from "./backlog";
import { EVENT_DAYS, FAILURE_DAYS, USER_DAYS } from "./field-store";

/**
 * The section of the app's privacy notice that covers what day2 adds — and,
 * when the notice lives in the app's own code, an offer to put it there.
 *
 * Generated from the same facts as the store answers (store-privacy.ts):
 * field checks, the hashed user id, retention treatments, a fixed device id,
 * and ad conversions. It's marked in the notice
 * (`day2:privacy-start v=<version>` … `day2:privacy-end`), so day2 can tell
 * whether the notice is current and replace only its own section later.
 * day2 drafts; it's not legal advice — the owner (or their lawyer) decides.
 */

export const NOTICE_KEY = "privacy-notice:update";
export const noticeKey = (version: string) => `${NOTICE_KEY}:${version}`;

export type NoticeFacts = {
  mobile: boolean;
  fieldChecks: boolean;
  identify: boolean;
  treatments: boolean;
  deviceId: boolean;
  /** Ad platforms day2 sends sign-ups back to (by name); empty = none. */
  adPlatforms: string[];
  /** Mobile apps: click ids only after the user agreed (ATT). */
  adConsent: boolean;
};

export type Lang = "en" | "de";

const days = (n: number, lang: Lang) => (n % 365 === 0 ? (lang === "de" ? `${n / 365} Jahre` : `${n / 365} years`) : lang === "de" ? `${n} Tage` : `${n} days`);

/** Pure. The section as Markdown, or null when there's nothing to say yet. */
export function noticeSection(f: NoticeFacts, appName: string, lang: Lang): string | null {
  if (!f.fieldChecks) return null;
  const de = lang === "de";
  const lines: string[] = [];
  const ads = f.adPlatforms.length > 0;
  if (de) {
    lines.push(`## Wie wir ${appName} verbessern (day2)`);
    lines.push("");
    lines.push(`Wir nutzen day2, um zu prüfen, ob ${appName} zuverlässig funktioniert, und um die App zu verbessern. day2 verarbeitet die Daten in unserem Auftrag (Auftragsverarbeitung).`);
    lines.push("");
    lines.push("**Welche Daten:**");
    lines.push("- Diagnosedaten: Abstürze und Fehler, Hänger und Ladezeiten, fehlgeschlagene Prüfungen sowie Gerätedaten (Betriebssystem, Modell, Bildschirmgröße, Sprache).");
    lines.push(`- Nutzungsdaten: welche ${f.mobile ? "Bildschirme" : "Seiten"} aufgerufen und welche Funktionen genutzt werden, Registrierung und erste Nutzung, woher ein Besuch kam (z. B. eine Anzeige oder ein geteilter Link).`);
    if (f.identify) lines.push("- Eine pseudonyme Nutzerkennung: ein verschlüsselter Hash Ihrer Nutzer-ID, nie Ihr Name oder Ihre E-Mail-Adresse. Damit sehen wir, ob Nutzer wiederkommen.");
    lines.push(f.deviceId ? "- Eine zufällige Gerätekennung, die auf dem Gerät gespeichert wird (nicht die Werbe-ID)." : `- Eine zufällige Kennung pro ${f.mobile ? "App-Start" : "Sitzung"}, die nicht gespeichert wird.`);
    lines.push("");
    lines.push("**Wozu:** um Fehler zu finden und zu beheben, die App zu verbessern und zu messen, was Nutzern hilft." + (f.treatments ? " Einige Nutzer sehen Hinweise oder Abläufe, die zu ihrer Nutzung passen (z. B. eine Erinnerung nach einer Pause); einem zufälligen Teil der Nutzer zeigen wir sie nicht, um ihre Wirkung zu messen." : ""));
    lines.push("");
    lines.push("**Rechtsgrundlage:** unser berechtigtes Interesse an einer funktionierenden und verbesserten App (Art. 6 Abs. 1 lit. f DSGVO)" + (f.identify ? "; die pseudonyme Nutzerkennung nutzen wir nur, wenn Sie eingewilligt haben, sofern das erforderlich ist (Art. 6 Abs. 1 lit. a DSGVO)" : "") + ".");
    if (ads) {
      lines.push("");
      lines.push(
        f.mobile
          ? `**Werbung:** Wenn Sie über eine unserer Anzeigen kommen und der Messung zustimmen (auf dem iPhone über die Abfrage „App-Tracking"), teilen wir dem jeweiligen Werbenetzwerk (${f.adPlatforms.join(", ")}) mit, dass sich jemand über diese Anzeige registriert hat: die Klick-Kennung der Anzeige und die pseudonyme Nutzerkennung. Ohne Ihre Zustimmung wird nichts davon geteilt. Rechtsgrundlage: Ihre Einwilligung (Art. 6 Abs. 1 lit. a DSGVO), jederzeit widerrufbar.`
          : `**Werbung:** Wenn Sie über eine unserer Anzeigen kommen und sich registrieren, teilen wir das dem jeweiligen Werbenetzwerk (${f.adPlatforms.join(", ")}) mit, damit es unsere Anzeigen Menschen mit ähnlichen Interessen zeigen kann: die Klick-Kennung der Anzeige, die pseudonyme Nutzerkennung und — nur dafür — Ihre IP-Adresse und Browserkennung, die wir nach 7 Tagen löschen. Die Netzwerke verarbeiten diese Daten in eigener Verantwortung.`,
      );
    }
    lines.push("");
    lines.push(`**Speicherdauer:** Fehlerberichte ${days(FAILURE_DAYS, lang)}, Nutzungsdaten ${days(EVENT_DAYS, lang)}${f.identify ? `, die pseudonyme Nutzerkennung bis ${days(USER_DAYS, lang)} nach der letzten Nutzung` : ""}.`);
  } else {
    lines.push(`## How we improve ${appName} (day2)`);
    lines.push("");
    lines.push(`We use day2 to check that ${appName} works reliably and to improve it. day2 processes this data on our behalf, as our processor.`);
    lines.push("");
    lines.push("**What data:**");
    lines.push("- Diagnostics: crashes and errors, freezes and loading times, failed checks, and device details (operating system, model, screen size, language).");
    lines.push(`- Usage: which ${f.mobile ? "screens" : "pages"} are opened and which features are used, sign-up and first use, and where a visit came from (for example an ad or a shared link).`);
    if (f.identify) lines.push("- A pseudonymous user ID: a salted hash of your account ID, never your name or email address. It lets us see whether people come back.");
    lines.push(f.deviceId ? "- A random device ID kept on your device (not the advertising ID)." : `- A random ID per ${f.mobile ? "app launch" : "session"}, which isn't stored.`);
    lines.push("");
    lines.push("**Why:** to find and fix problems, improve the app, and measure what helps people." + (f.treatments ? " Some people see tips or flows that fit how they use the app (for example a reminder after a break); a random share of people don't, so we can measure whether they help." : ""));
    lines.push("");
    lines.push("**Legal basis:** our legitimate interest in an app that works and improves (Art. 6(1)(f) GDPR)" + (f.identify ? "; where consent is required, we use the pseudonymous user ID only after you've given it (Art. 6(1)(a) GDPR)" : "") + ".");
    if (ads) {
      lines.push("");
      lines.push(
        f.mobile
          ? `**Advertising:** If you arrive through one of our ads and agree to ad measurement (on iPhone, through the "Allow tracking" prompt), we tell that ad network (${f.adPlatforms.join(", ")}) that someone signed up through the ad: the ad's click ID and the pseudonymous user ID. Without your agreement nothing is shared. Legal basis: your consent (Art. 6(1)(a) GDPR), which you can withdraw at any time.`
          : `**Advertising:** If you arrive through one of our ads and sign up, we tell that ad network (${f.adPlatforms.join(", ")}) so it can show our ads to people like you: the ad's click ID, the pseudonymous user ID and — only for this — your IP address and browser details, which we delete after 7 days. The ad networks process this data as independent controllers.`,
      );
    }
    lines.push("");
    lines.push(`**How long:** error reports ${days(FAILURE_DAYS, lang)}, usage data ${days(EVENT_DAYS, lang)}${f.identify ? `, the pseudonymous user ID up to ${days(USER_DAYS, lang)} after last use` : ""}.`);
  }
  return lines.join("\n");
}

export const noticeVersion = (section: string) => createHash("sha256").update(section).digest("hex").slice(0, 12);

// ---------------------------------------------------------------------------
// Finding the app's own privacy notice
// ---------------------------------------------------------------------------

export type FoundNotice = { path: string; lang: Lang; version: string | null };

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".expo", "ios", "android", "coverage", ".turbo", "day2"]);
const EXT = /\.(md|mdx|tsx|jsx|ts|js|html|vue|svelte|astro|txt)$/i;
const NAME = /(privacy|datenschutz|privacidad|confidentialit)/i;
const MARK = /day2:privacy-start v=([a-f0-9]{6,})/;

/** A file in the app that holds its privacy notice (by name and content), with day2's section version if it's in there. */
export function findNotice(repoPath: string, maxFiles = 4000): FoundNotice | null {
  const hits: Array<{ path: string; score: number; text: string }> = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || seen > maxFiles) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e) || e.startsWith(".")) continue;
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (EXT.test(e) && st.size < 400_000) {
        seen++;
        const rel = relative(repoPath, p);
        if (!NAME.test(rel)) continue;
        const text = readFileSync(p, "utf-8");
        // A notice talks about personal data; a component merely named "PrivacyToggle" doesn't.
        const signals = (text.match(/personal data|personenbezogen|GDPR|DSGVO|data protection|Datenschutz|controller|Verantwortlich/gi) ?? []).length;
        if (signals >= 2 || MARK.test(text)) hits.push({ path: rel, score: signals + (MARK.test(text) ? 100 : 0) + (/\.(md|mdx|html)$/i.test(e) ? 1 : 0), text });
      }
    }
  };
  if (!existsSync(repoPath)) return null;
  walk(repoPath, 0);
  const best = hits.sort((a, b) => b.score - a.score)[0];
  if (!best) return null;
  const de = (best.text.match(/\b(die|und|der|Daten|wir|Ihre)\b/g) ?? []).length > (best.text.match(/\b(the|and|we|your|data)\b/gi) ?? []).length;
  return { path: best.path, lang: de ? "de" : "en", version: best.text.match(MARK)?.[1] ?? null };
}

/** The code change that puts (or replaces) day2's section in the app's own notice. */
export function noticeTicket(found: FoundNotice, section: string, version: string): NewTicketInput {
  const comment = /\.(tsx|jsx)$/i.test(found.path) ? "JSX comments ({/* … */})" : /\.(md|mdx|html|vue|svelte|astro)$/i.test(found.path) ? "HTML comments (<!-- … -->)" : "comments";
  return {
    title: `Privacy notice: ${found.version ? "update" : "add"} the section about day2`,
    type: "task",
    description: [
      `The owner asked day2 to ${found.version ? "update" : "add"} the section of the privacy notice that covers what day2 does in the app, in ${found.path}.`,
      "",
      found.version
        ? `Replace everything between the markers day2:privacy-start and day2:privacy-end with the text below, and change the start marker to day2:privacy-start v=${version}.`
        : `Add the text below as its own section — after the part about analytics or tracking if there is one, otherwise before the section on users' rights — wrapped in ${comment}: day2:privacy-start v=${version} before it and day2:privacy-end after it.`,
      "Render it the way the rest of the notice is written (Markdown, HTML or components), keep the notice's headings style, and change nothing else in the notice.",
      "",
      "---",
      section,
      "---",
    ].join("\n"),
    doneWhen: [`${found.path} contains the section between the markers, with v=${version}`, "Nothing else in the notice changed", "The app builds and its tests pass"],
    priority: 2,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: noticeKey(version) },
    actor: "day2",
    createdNote: "The owner asked day2 to edit the privacy notice.",
  };
}
