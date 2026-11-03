import { describe, expect, test } from "bun:test";
import { buildDraftPrompt, checkTexts, parseDraft, parseReview } from "./texts";

const brand = {
  positioning: "x",
  personality: ["playful"],
  audience: { primary: "teens", segments: [], painPoints: [], motivations: [] },
  voice: { tone: "friendly, du", doSay: [], dontSay: ["Kunde", "synergy"], sampleLines: [] },
  visual: { palette: [], typography: null, imagery: null, designLanguage: null },
  channels: { ads: null, social: null, email: null, outreach: null },
};

describe("drafting", () => {
  test("the prompt carries the limits, languages, brand and slop checklist", () => {
    const p = buildDraftPrompt({ appName: "Dotty", purpose: "Dot art", targetUsers: "Teens", features: ["Daily dot puzzle"], toneOfVoice: "playful", brand, locales: ["de", "en"], goal: "Bring a new user back" });
    expect(p).toContain("at most 40 characters");
    expect(p).toContain("de, en");
    expect(p).toContain('"du"');
    expect(p).toContain("Kunde");
    expect(p).toContain("[formulaic-urgency-cta]");
  });
  test("parseDraft reads the marker JSON, per locale", () => {
    const d = parseDraft('blah\nMESSAGE_TEXTS_JSON:\n{"texts":{"de":{"title":"Dein Rätsel wartet","body":"Heute: ein neues Punktebild.","cta":"Los"},"en":{"title":"Your puzzle","body":"A new dot picture today."}},"route":"/today","claims":["daily puzzle"]}', ["de", "en"]);
    expect(d).toEqual({
      texts: { de: { title: "Dein Rätsel wartet", body: "Heute: ein neues Punktebild.", cta: "Los" }, en: { title: "Your puzzle", body: "A new dot picture today." } },
      route: "/today",
      claims: ["daily puzzle"],
    });
    expect(parseDraft("no marker", ["de"])).toBeNull();
    expect(parseDraft('MESSAGE_TEXTS_JSON:\n{"texts":{"fr":{"title":"x","body":"y"}}}', ["de"])).toBeNull();
    expect(parseDraft('MESSAGE_TEXTS_JSON:\n{"texts":{"de":{"title":"x","body":"y"}},"route":"https://evil.example"}', ["de"])!.route).toBeNull();
  });
});

describe("checkTexts", () => {
  const good = { de: { title: "Dein Rätsel wartet", body: "Heute gibt es ein neues Punktebild für dich." }, en: { title: "Your puzzle is ready", body: "A new dot picture is waiting today." } };
  test("good texts pass", () => {
    expect(checkTexts(good, { locales: ["de", "en"], brand, grounding: "" })).toEqual({ ok: true, issues: [] });
  });
  test("length, language, slop, urgency, shaming, caps, numbers, brand never-say", () => {
    const r = checkTexts(
      {
        de: { title: "LETZTE CHANCE heute!!", body: "Nur heute: 50% mehr Punkte, lieber Kunde. Wir vermissen dich." },
        en: { title: "x".repeat(41), body: "Unlock a game-changing journey — join thousands of fans." },
      },
      { locales: ["de", "en"], brand, grounding: "Daily puzzle" },
    );
    const all = r.issues.join("\n");
    expect(r.ok).toBe(false);
    expect(all).toContain("EN title is 41 characters");
    expect(all).toContain("formulaic-urgency-cta");
    expect(all).toContain("unearned-superlative-vocabulary");
    expect(all).toContain("vague-unquantified-social-proof");
    expect(all).toContain("pleading");
    expect(all).toContain("exclamation");
    expect(all).toContain("capitals");
    expect(all).toContain('"50%"');
    expect(all).toContain('"Kunde"');
    expect(checkTexts({ en: good.en }, { locales: ["de", "en"] }).issues).toEqual(["No German text."]);
  });
  test("numbers the app's own facts back are fine", () => {
    expect(checkTexts({ en: { title: "3 new puzzles", body: "Three a day." } }, { locales: ["en"], grounding: "3 new puzzles every day" }).ok).toBe(true);
  });
});

test("parseReview fails closed", () => {
  expect(parseReview('MESSAGE_REVIEW_JSON:\n{"ok":true,"issues":[]}')).toEqual({ ok: true, issues: [] });
  expect(parseReview('MESSAGE_REVIEW_JSON:\n{"ok":false,"issues":["claims a streak the app lacks"]}')).toEqual({ ok: false, issues: ["claims a streak the app lacks"] });
  expect(parseReview("looks fine to me").ok).toBe(false);
  expect(parseReview("MESSAGE_REVIEW_JSON:\n{nope").ok).toBe(false);
  expect(parseReview('MESSAGE_REVIEW_JSON:\n{"ok":"yes"}').ok).toBe(false);
});
