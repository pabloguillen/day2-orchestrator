import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findNotice, noticeKey, noticeSection, noticeTicket, noticeVersion, type NoticeFacts } from "./privacy-notice";

/** The privacy notice section for what day2 does, and finding the app's own notice. */

const base: NoticeFacts = { mobile: true, fieldChecks: true, identify: true, treatments: true, deviceId: false, adPlatforms: [], adConsent: false };

describe("the section", () => {
  test("nothing to say before field checks are in the app", () => {
    expect(noticeSection({ ...base, fieldChecks: false }, "Buddy", "en")).toBeNull();
  });

  test("what, why, legal basis and how long — from what's actually in the app", () => {
    const s = noticeSection(base, "Buddy", "en")!;
    expect(s).toContain("## How we improve Buddy (day2)");
    expect(s).toContain("as our processor");
    expect(s).toContain("a salted hash of your account ID, never your name or email address");
    expect(s).toContain("A random ID per app launch, which isn't stored.");
    expect(s).toContain("a random share of people don't, so we can measure whether they help");
    expect(s).toContain("Art. 6(1)(f) GDPR");
    expect(s).toContain("error reports 30 days, usage data 180 days, the pseudonymous user ID up to 2 years after last use");
    expect(s).not.toContain("Advertising");
  });

  test("ad conversions: on the web with IP for 7 days; in mobile apps only with consent", () => {
    const web = noticeSection({ ...base, mobile: false, adPlatforms: ["TikTok", "Meta"] }, "Buddy", "en")!;
    expect(web).toContain("we tell that ad network (TikTok, Meta)");
    expect(web).toContain("your IP address and browser details, which we delete after 7 days");
    const app = noticeSection({ ...base, adPlatforms: ["TikTok"], adConsent: true }, "Buddy", "en")!;
    expect(app).toContain('"Allow tracking" prompt');
    expect(app).toContain("Without your agreement nothing is shared");
    expect(app).not.toContain("IP address");
  });

  test("German for German notices", () => {
    const s = noticeSection({ ...base, deviceId: true }, "Buddy", "de")!;
    expect(s).toContain("## Wie wir Buddy verbessern (day2)");
    expect(s).toContain("Auftragsverarbeitung");
    expect(s).toContain("Art. 6 Abs. 1 lit. f DSGVO");
    expect(s).toContain("zufällige Gerätekennung");
    expect(s).toContain("bis 2 Jahre nach der letzten Nutzung");
  });

  test("the version follows the text", () => {
    const a = noticeSection(base, "Buddy", "en")!;
    expect(noticeVersion(a)).toBe(noticeVersion(a));
    expect(noticeVersion(a)).not.toBe(noticeVersion(noticeSection({ ...base, deviceId: true }, "Buddy", "en")!));
  });
});

describe("finding the app's notice", () => {
  const root = mkdtempSync(join(tmpdir(), "day2-notice-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("a page that talks about personal data — not a component that's merely named privacy", () => {
    const repo = join(root, "a");
    mkdirSync(join(repo, "src/components"), { recursive: true });
    mkdirSync(join(repo, "app"), { recursive: true });
    writeFileSync(join(repo, "src/components/PrivacyToggle.tsx"), "export const PrivacyToggle = () => null;");
    writeFileSync(join(repo, "app/privacy.tsx"), "<h1>Privacy policy</h1><p>We process personal data under the GDPR. The controller is Buddy GmbH.</p>");
    expect(findNotice(repo)).toEqual({ path: "app/privacy.tsx", lang: "en", version: null });
    expect(findNotice(join(root, "none"))).toBeNull();
  });

  test("German notices, and day2's section version when it's already in there", () => {
    const repo = join(root, "b");
    mkdirSync(join(repo, "content"), { recursive: true });
    writeFileSync(join(repo, "content/datenschutz.md"), "# Datenschutzerklärung\n\nWir verarbeiten personenbezogene Daten nach der DSGVO. Verantwortlich ist die Buddy GmbH und die Daten werden ...\n\n<!-- day2:privacy-start v=abc123def456 -->\n## Wie wir …\n<!-- day2:privacy-end -->\n");
    expect(findNotice(repo)).toEqual({ path: "content/datenschutz.md", lang: "de", version: "abc123def456" });
  });

  test("the ticket says where, with markers, and nothing else changes", () => {
    const section = noticeSection(base, "Buddy", "en")!;
    const v = noticeVersion(section);
    const t = noticeTicket({ path: "app/privacy.tsx", lang: "en", version: null }, section, v);
    expect(t.title).toBe("Privacy notice: add the section about day2");
    expect(t.description).toContain(`JSX comments ({/* … */}): day2:privacy-start v=${v}`);
    expect(t.description).toContain(section);
    expect(t.source.key).toBe(noticeKey(v));
    const upd = noticeTicket({ path: "content/datenschutz.md", lang: "de", version: "abc123def456" }, section, v);
    expect(upd.description).toContain("Replace everything between the markers");
  });
});
