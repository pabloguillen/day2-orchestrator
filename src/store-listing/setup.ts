import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NewTicketInput } from "../backlog";
import type { AppProfile } from "../onboarding";
import type { StoreStatus } from "../store-privacy";
import { walkthrough } from "../store-walkthrough";
import type { AscListingClient } from "./asc";
import type { Paid } from "./service";
import { AGE_BOOLEAN, AGE_FREQUENCY, FREQUENCY_VALUES, answersVersion, guidedPlay, normalizeAgeRating, type Guided } from "./setup-answers";
import { APPLE_CATEGORIES, type AscSetupClient } from "./setup-asc";
import { checkAppIcon, iconTicket, PREVIEW_TYPES } from "./setup-assets";
import type { PlaySetupClient } from "./setup-play";
import type { StoreListingStore } from "./store";
import type { ContentAnswers, Fact, FactKey, FactValue, FieldSpec, Graphic, GuidedKey, SetupItem, SetupState, SetupStatus } from "./setup-types";
import type { StoreFile, StoreId } from "./types";

/**
 * Store setup: the checklist per store, and the pass that fills what's
 * missing (docs/store-listing.md → "Store setup"). Idempotent: every write
 * is preceded by a read, and only what differs from the approved value is
 * written. The release flow's rules for submitting stay as they are — this
 * never sends anything to review.
 */

export type SetupDeps = {
  now: Date;
  appId: string;
  appName: string;
  repoPath: string;
  store: StoreListingStore;
  ids: { bundleId: string | null; packageName: string | null; appStoreId: string | null };
  asc: { listing: AscListingClient; setup: AscSetupClient } | null;
  play: PlaySetupClient | null;
  profile: AppProfile | null;
  paid: Paid;
  /** The content agent (reads the app's code). */
  answers(input: { appName: string; profile: AppProfile | null; usesAds: boolean; purchases: boolean }): Promise<ContentAnswers | null>;
  /** What's in the app (store-privacy practices): ads and purchases. */
  practices(): Promise<{ ads: boolean; purchases: boolean }>;
  /** Store privacy answers' state per store (store-privacy storeStatus). */
  privacy(): Promise<StoreStatus[]>;
  ticket(t: NewTicketInput): Promise<{ id: string; created: boolean }>;
  /** Makes the Google Play icon and feature graphic (setup-assets makePlayGraphics); absent = can't render here. */
  makeGraphics?: (kinds: Array<"playIcon" | "featureGraphic">) => Promise<Partial<Record<"playIcon" | "featureGraphic", string>>>;
  /** Starts recording app previews in the background (Mac only); absent = not on this server. */
  startPreviews?: () => void;
  /** A made graphic or preview as a file (null when it's gone). */
  graphicPath?: (g: Graphic) => string | null;
  /** The demo account, decrypted (only to write it into App Store Connect). */
  demo(secret: string): { username: string; password: string };
  log(text: string): void;
};

export type SetupReport = { proposed: FactKey[]; wrote: string[]; graphics: string[]; problems: string[] };

const errText = (err: unknown) => (err as Error).message.replace(/^(App Store Connect|Google Play): /, "");
const line = (f: StoreFile, now: Date, text: string) => f.log.push({ at: now.toISOString(), text });

export const FACT_TITLE: Record<FactKey, string> = {
  "ios.categories": "Categories",
  "ios.contentRights": "Content rights",
  "ios.privacyUrls": "Privacy policy and privacy choices links",
  "ios.versionInfo": "Support link, marketing link and copyright",
  "ios.ageRating": "Age rating",
  "ios.review": "App Review information",
  "ios.pricing": "Price and availability",
  "android.details": "Contact details and default language",
  "android.video": "Promo video",
};

const CATEGORY_OPTIONS: Array<[string, string]> = APPLE_CATEGORIES.map((c) => [c, c.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()).replace(" And ", " & ")]);

/** Pure. The fields of each fact, as the console edits them. */
export function fieldsFor(key: FactKey): FieldSpec[] {
  switch (key) {
    case "ios.categories":
      return [
        { key: "primary", label: "Primary category", kind: "select", options: CATEGORY_OPTIONS, required: true },
        { key: "secondary", label: "Secondary category (optional)", kind: "select", options: [["", "None"], ...CATEGORY_OPTIONS] },
      ];
    case "ios.contentRights":
      return [{ key: "usesThirdPartyContent", label: "The app shows, plays or accesses content it doesn't own (and has the rights to it)", kind: "bool" }];
    case "ios.privacyUrls":
      return [
        { key: "privacyPolicyUrl", label: "Privacy policy link", kind: "url", required: true },
        { key: "privacyChoicesUrl", label: "Privacy choices link (optional: where users manage their data)", kind: "url" },
      ];
    case "ios.versionInfo":
      return [
        { key: "supportUrl", label: "Support link", kind: "url", required: true },
        { key: "marketingUrl", label: "Marketing link (optional)", kind: "url" },
        { key: "copyright", label: "Copyright (e.g. 2026 Dotty GmbH)", kind: "text", required: true, max: 200 },
      ];
    case "ios.ageRating":
      return [
        ...AGE_FREQUENCY.map(([k, label]): FieldSpec => ({ key: k, label, kind: "select", options: FREQUENCY_VALUES })),
        ...AGE_BOOLEAN.map(([k, label]): FieldSpec => ({ key: k, label, kind: "bool" })),
      ];
    case "ios.review":
      return [
        { key: "firstName", label: "First name", kind: "text", required: true },
        { key: "lastName", label: "Last name", kind: "text", required: true },
        { key: "phone", label: "Phone (with country code, e.g. +49 30 1234567)", kind: "tel", required: true },
        { key: "email", label: "Email", kind: "email", required: true },
        { key: "signInRequired", label: "Reviewers need to sign in to see the app", kind: "bool" },
        { key: "notes", label: "Notes for the reviewer", kind: "textarea", max: 4000 },
      ];
    case "ios.pricing":
      return [
        { key: "free", label: "Free to download", kind: "bool" },
        { key: "price", label: "Price in the base territory (if not free, e.g. 2.99)", kind: "text" },
        { key: "baseTerritory", label: "Base territory (3 letters, e.g. USA, DEU)", kind: "text", required: true, max: 3 },
        { key: "territories", label: 'Countries ("all", or a list like DEU, AUT, CHE)', kind: "text", required: true },
      ];
    case "android.details":
      return [
        { key: "contactEmail", label: "Contact email", kind: "email", required: true },
        { key: "contactPhone", label: "Contact phone (optional)", kind: "tel" },
        { key: "contactWebsite", label: "Website (optional)", kind: "url" },
        { key: "defaultLanguage", label: "Default language (e.g. en-US)", kind: "text", required: true },
      ];
    case "android.video":
      return [{ key: "url", label: "YouTube link (optional)", kind: "url" }];
  }
}

/** Pure. A value from what the owner sent, coerced to the fields' kinds; throws a plain-language error when it can't be used. */
export function checkFact(key: FactKey, raw: Record<string, unknown>, before: FactValue): FactValue {
  const out: FactValue = { ...before };
  for (const f of fieldsFor(key)) {
    if (!(f.key in raw)) continue;
    const v = raw[f.key];
    if (f.kind === "bool") out[f.key] = v === true || v === "true";
    else out[f.key] = typeof v === "string" ? v.trim().slice(0, f.max ?? 2000) : v == null ? "" : String(v);
  }
  for (const f of fieldsFor(key)) {
    const v = out[f.key];
    if (f.required && (v === "" || v == null)) throw new Error(`${f.label}: please fill this in.`);
    if (typeof v !== "string" || !v) continue;
    if (f.kind === "url" && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(v)) throw new Error(`${f.label}: that isn't a web address (it starts with https://).`);
    if (f.kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error(`${f.label}: that isn't an email address.`);
    if (f.kind === "select" && f.options && !f.options.some(([o]) => o === v)) throw new Error(`${f.label}: pick one of the choices.`);
  }
  if (key === "ios.categories" && out.secondary && out.secondary === out.primary) throw new Error("The secondary category has to be different from the primary one.");
  if (key === "ios.pricing") {
    if (!out.free && !(Number(out.price) > 0)) throw new Error("Price: say what the app costs (e.g. 2.99), or make it free.");
    if (!/^[A-Z]{3}$/.test(String(out.baseTerritory).toUpperCase())) throw new Error("Base territory: three letters, e.g. USA.");
    out.baseTerritory = String(out.baseTerritory).toUpperCase();
    const t = String(out.territories).trim();
    if (t.toLowerCase() !== "all" && !t.split(/[\s,]+/).every((x) => /^[A-Za-z]{3}$/.test(x))) throw new Error('Countries: "all", or three-letter codes separated by commas.');
    out.territories = t.toLowerCase() === "all" ? "all" : t.toUpperCase().split(/[\s,]+/).join(", ");
  }
  if (key === "android.video" && out.url && !/^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(String(out.url))) throw new Error("Promo video: Google Play takes a YouTube link.");
  if (key === "ios.ageRating") return normalizeAgeRating(out) as FactValue;
  return out;
}

// ---------------------------------------------------------------------------
// Proposals (once)
// ---------------------------------------------------------------------------

/** Pure. A proposal for every fact the app's stores need and doesn't have yet. Mutates nothing; returns the new facts. */
export function proposeFacts(s: SetupState, o: { answers: ContentAnswers | null; ids: SetupDeps["ids"]; appName: string; locales: string[]; now: Date }): Partial<Record<FactKey, Fact>> {
  const a = o.answers?.facts;
  const why = (k: FactKey | "ageRating", fallback: string) => o.answers?.why[k] || (a ? fallback : "day2 couldn't read this from the code — please fill it in.");
  const make = (value: FactValue, w: string): Fact => ({ value, state: "proposed", why: w, proposedAt: o.now.toISOString(), approvedBy: null, approvedAt: null, syncedAt: null, error: null });
  const out: Partial<Record<FactKey, Fact>> = {};
  const add = (k: FactKey, value: FactValue, w: string) => {
    if (!s.facts[k]) out[k] = make(value, w);
  };
  if (o.ids.bundleId) {
    add("ios.categories", { primary: a?.primaryCategory ?? "", secondary: a?.secondaryCategory ?? "" }, why("ios.categories", "From what the app does."));
    add("ios.contentRights", { usesThirdPartyContent: a?.usesThirdPartyContent ?? false }, why("ios.contentRights", a?.usesThirdPartyContent ? "The app shows content from other sources." : "day2 found no content from other sources in the app."));
    add("ios.privacyUrls", { privacyPolicyUrl: a?.privacyPolicyUrl ?? "", privacyChoicesUrl: a?.privacyChoicesUrl ?? "" }, why("ios.privacyUrls", a?.privacyPolicyUrl ? "The links the app itself shows." : "day2 found no privacy policy link in the app — Apple needs one for every app."));
    add("ios.versionInfo", { supportUrl: a?.supportUrl ?? "", marketingUrl: a?.marketingUrl ?? "", copyright: a?.copyrightHolder ? `${o.now.getUTCFullYear()} ${a.copyrightHolder}` : "" }, why("ios.versionInfo", "From the app's config and its about screen."));
    add("ios.ageRating", normalizeAgeRating(o.answers?.ageRating) as FactValue, why("ageRating", "From the app's content and features."));
    add("ios.review", { firstName: "", lastName: "", phone: a?.contactPhone ?? "", email: a?.contactEmail ?? "", signInRequired: a?.signInRequired ?? false, notes: a?.reviewNotes ?? "" }, why("ios.review", "Apple calls or emails this person if a reviewer has a question."));
    add("ios.pricing", { free: a?.free ?? true, price: "", baseTerritory: "USA", territories: "all" }, why("ios.pricing", "Free, in every country — change it if that's not what you want."));
  }
  if (o.ids.packageName) {
    add("android.details", { contactEmail: a?.contactEmail ?? "", contactPhone: a?.contactPhone ?? "", contactWebsite: a?.marketingUrl || a?.supportUrl || "", defaultLanguage: o.locales[0] ?? "en-US" }, why("android.details", "Shown to users on the store page."));
    add("android.video", { url: "" }, "Optional: a YouTube video shown at the top of the store page.");
  }
  return out;
}

/** Owner edits a fact (and approves it, or it stays a proposal). Pure on the file. */
export function decideFact(f: StoreFile, key: FactKey, o: { value?: Record<string, unknown>; approve: boolean; by: string | null; now: Date }): StoreFile {
  const fact = f.setup.facts[key];
  if (!fact) throw new Error("day2 hasn't prepared this yet.");
  const value = checkFact(key, o.value ?? {}, fact.value);
  const changed = JSON.stringify(value) !== JSON.stringify(fact.value);
  f.setup.facts[key] = { ...fact, value, state: o.approve ? "approved" : fact.state, approvedBy: o.approve ? o.by : fact.approvedBy, approvedAt: o.approve ? o.now.toISOString() : fact.approvedAt, syncedAt: changed ? null : fact.syncedAt, error: changed ? null : fact.error, ...(changed ? { manual: [] } : {}) };
  if (o.approve) line(f, o.now, `${FACT_TITLE[key]} approved${o.by ? ` by ${o.by}` : ""} — day2 writes it into the store and keeps it there.`);
  return f;
}

// ---------------------------------------------------------------------------
// Writing approved facts (read first, write what differs)
// ---------------------------------------------------------------------------

type FactResult = { ok: boolean; wrote: boolean; error: string | null; waitsForVersion?: boolean; manual?: string[] };
const approvedValue = (s: SetupState, k: FactKey) => (s.facts[k]?.state === "approved" ? s.facts[k]!.value : null);
const sameText = (a: unknown, b: unknown) => String(a ?? "") === String(b ?? "");

/** Facts that live on an App Store version: support/marketing links, copyright, App Review details, approved previews. Used by the pass (a version being prepared) and the release hook. */
export async function applyVersionSetup(asc: { listing: AscListingClient; setup: AscSetupClient }, s: SetupState, o: { versionId: string; demo: (secret: string) => { username: string; password: string }; previewFile: (g: Graphic) => string | null }): Promise<{ facts: Partial<Record<FactKey, FactResult>>; previews: Record<string, string | null> }> {
  const facts: Partial<Record<FactKey, FactResult>> = {};
  const previews: Record<string, string | null> = {};
  const vi = approvedValue(s, "ios.versionInfo");
  if (vi) {
    try {
      let wrote = false;
      const v = await asc.setup.version(o.versionId);
      if (!sameText(v.copyright, vi.copyright)) {
        await asc.setup.setCopyright(o.versionId, String(vi.copyright));
        wrote = true;
      }
      for (const l of await asc.setup.versionLocalizations(o.versionId)) {
        const change: { supportUrl?: string; marketingUrl?: string | null } = {};
        if (!sameText(l.supportUrl, vi.supportUrl)) change.supportUrl = String(vi.supportUrl);
        if (!sameText(l.marketingUrl, vi.marketingUrl)) change.marketingUrl = vi.marketingUrl ? String(vi.marketingUrl) : null;
        if (Object.keys(change).length) {
          await asc.setup.setVersionLocalization(l.id, change);
          wrote = true;
        }
      }
      facts["ios.versionInfo"] = { ok: true, wrote, error: null };
    } catch (err) {
      facts["ios.versionInfo"] = { ok: false, wrote: false, error: errText(err) };
    }
  }
  const rv = approvedValue(s, "ios.review");
  if (rv) {
    try {
      const needsDemo = rv.signInRequired === true;
      if (needsDemo && !s.demo) throw new Error("Reviewers need to sign in: add the demo account (username and password) on this item.");
      const demo = needsDemo && s.demo ? o.demo(s.demo.secret) : null;
      const want = { contactFirstName: String(rv.firstName), contactLastName: String(rv.lastName), contactPhone: String(rv.phone), contactEmail: String(rv.email), notes: String(rv.notes ?? ""), demoAccountRequired: needsDemo, ...(demo ? { demoAccountName: demo.username, demoAccountPassword: demo.password } : {}) };
      const cur = await asc.setup.reviewDetail(o.versionId);
      const fact = s.facts["ios.review"]!;
      const demoNewer = Boolean(demo && s.demo && (!fact.syncedAt || s.demo.setAt > fact.syncedAt));
      const differs = !cur || (["contactFirstName", "contactLastName", "contactPhone", "contactEmail", "notes", "demoAccountRequired"] as const).some((k) => String(cur.attributes[k] ?? "") !== String(want[k] ?? "")) || (demo && cur.attributes.demoAccountName !== demo.username) || demoNewer;
      if (differs) await asc.setup.saveReviewDetail(o.versionId, cur?.id ?? null, want);
      facts["ios.review"] = { ok: true, wrote: Boolean(differs), error: null };
    } catch (err) {
      facts["ios.review"] = { ok: false, wrote: false, error: errText(err) };
    }
  }
  for (const g of s.graphics.filter((x) => x.kind === "preview" && x.status === "approved" && x.locale)) {
    try {
      const file = o.previewFile(g);
      if (!file) throw new Error("the preview file is gone — day2 records a new one.");
      const loc = await asc.listing.versionLocalizationId(o.versionId, g.locale!);
      for (const t of PREVIEW_TYPES) await asc.setup.replacePreview(loc, t.previewType, file);
      previews[g.id] = null;
    } catch (err) {
      previews[g.id] = errText(err);
    }
  }
  return { facts, previews };
}

async function syncIos(d: SetupDeps, f: StoreFile): Promise<{ facts: Partial<Record<FactKey, FactResult>>; previews: Record<string, string | null>; checks: SetupState["checks"] }> {
  const asc = d.asc!;
  const s = f.setup;
  const facts: Partial<Record<FactKey, FactResult>> = {};
  const checks: SetupState["checks"] = {};
  const at = d.now.toISOString();
  const appleId = await asc.listing.appIdFor(d.ids.bundleId!);
  const info = await asc.setup.appInfo(appleId);
  const versions = await asc.listing.versions(appleId);
  const run = async (k: FactKey, fn: () => Promise<boolean | FactResult>) => {
    if (!approvedValue(s, k)) return;
    try {
      const r = await fn();
      facts[k] = typeof r === "boolean" ? { ok: true, wrote: r, error: null } : r;
    } catch (err) {
      facts[k] = { ok: false, wrote: false, error: errText(err) };
    }
  };
  const needInfo = () => {
    if (!info) throw new Error("the app has no app information in App Store Connect yet.");
    return info;
  };

  await run("ios.categories", async () => {
    const want = approvedValue(s, "ios.categories")!;
    const cur = await asc.setup.categories(needInfo().id);
    const secondary = want.secondary ? String(want.secondary) : null;
    if (cur.primary === want.primary && cur.secondary === secondary) return false;
    await asc.setup.setCategories(needInfo().id, String(want.primary), secondary);
    return true;
  });
  await run("ios.contentRights", async () => {
    const want = approvedValue(s, "ios.contentRights")!.usesThirdPartyContent ? "USES_THIRD_PARTY_CONTENT" : "DOES_NOT_USE_THIRD_PARTY_CONTENT";
    if ((await asc.setup.contentRights(appleId)) === want) return false;
    await asc.setup.setContentRights(appleId, want);
    return true;
  });
  await run("ios.privacyUrls", async () => {
    const want = approvedValue(s, "ios.privacyUrls")!;
    let wrote = false;
    const locs = await asc.setup.infoLocalizations(needInfo().id);
    if (!locs.length) throw new Error("the app info has no languages yet — the name goes in first (Listing).");
    for (const l of locs) {
      const change: { privacyPolicyUrl?: string; privacyChoicesUrl?: string | null } = {};
      if (!sameText(l.privacyPolicyUrl, want.privacyPolicyUrl)) change.privacyPolicyUrl = String(want.privacyPolicyUrl);
      if (!sameText(l.privacyChoicesUrl, want.privacyChoicesUrl)) change.privacyChoicesUrl = want.privacyChoicesUrl ? String(want.privacyChoicesUrl) : null;
      if (Object.keys(change).length) {
        await asc.setup.setInfoLocalization(l.id, change);
        wrote = true;
      }
    }
    return wrote;
  });
  await run("ios.ageRating", async () => {
    const want = approvedValue(s, "ios.ageRating")!;
    const cur = await asc.setup.ageRating(needInfo().id);
    if (!cur) throw new Error("App Store Connect has no age rating for the app yet.");
    const skip = new Set(s.facts["ios.ageRating"]?.manual ?? []);
    const unset = (k: string) => (AGE_BOOLEAN.some(([b]) => b === k) ? false : k === "kidsAgeBand" ? null : "NONE");
    const differs = (attrs: Record<string, unknown>) => Object.entries(want).filter(([k, v]) => !skip.has(k) && (attrs[k] ?? unset(k)) !== v).map(([k]) => k);
    const diff = differs(cur.attributes);
    if (!diff.length) return { ok: true, wrote: false, error: null, manual: [...skip] };
    await asc.setup.setAgeRating(cur.id, Object.fromEntries(diff.map((k) => [k, want[k]])));
    // Apple doesn't take every new question through the API yet: what didn't stick is the owner's to set.
    const after = await asc.setup.ageRating(needInfo().id);
    const left = after ? differs(after.attributes) : [];
    return { ok: true, wrote: true, error: null, manual: [...skip, ...left] };
  });
  await run("ios.pricing", async () => {
    const want = approvedValue(s, "ios.pricing")!;
    const base = String(want.baseTerritory || "USA");
    const price = want.free ? "0" : String(want.price);
    let wrote = false;
    const cur = await asc.setup.currentPrice(appleId, base);
    if (cur === null || Number(cur) !== Number(price)) {
      await asc.setup.setPrice(appleId, base, await asc.setup.pricePoint(appleId, base, price));
      wrote = true;
    }
    const list = want.territories === "all" ? null : String(want.territories).split(/[\s,]+/).filter(Boolean);
    const avail = await asc.setup.availability(appleId);
    if (!avail) {
      await asc.setup.createAvailability(appleId, list ?? (await asc.setup.territories()));
      wrote = true;
    } else
      for (const t of avail.territories) {
        const should = list ? list.includes(t.territory) : true;
        if (t.available !== should) {
          await asc.setup.setTerritory(t.id, should);
          wrote = true;
        }
      }
    return wrote;
  });

  let previews: Record<string, string | null> = {};
  if (versions.editable) {
    const r = await applyVersionSetup(asc, s, { versionId: versions.editable.id, demo: d.demo, previewFile: (g) => d.graphicPath?.(g) ?? null });
    Object.assign(facts, r.facts);
    previews = r.previews;
    // Build: the release flow attaches it when it submits; read back what's there.
    try {
      const v = await asc.setup.version(versions.editable.id);
      checks["ios.build"] = { at, ok: Boolean(v.buildId), note: v.buildId ? `A build is attached to ${versions.editable.version ?? "the version being prepared"}.` : `No build on ${versions.editable.version ?? "the version being prepared"} yet — the release flow attaches it when it submits.` };
    } catch (err) {
      checks["ios.build"] = { at, ok: false, note: errText(err) };
    }
  } else
    for (const k of ["ios.versionInfo", "ios.review"] as FactKey[])
      if (approvedValue(s, k) && !s.facts[k]?.syncedAt) facts[k] = { ok: false, wrote: false, error: "Goes into the next App Store version (day2 writes it right before the release flow submits).", waitsForVersion: true };

  // Screenshots: every display type Apple requires, in the primary language.
  const target = versions.editable ?? versions.live;
  if (target) {
    try {
      const locale = f.settings.locales[0] ?? "en-US";
      const loc = (await asc.setup.versionLocalizations(target.id)).find((l) => l.locale === locale);
      const types = loc ? await asc.setup.screenshotTypes(loc.id) : [];
      const missing = requiredScreenshotTypes(supportsTablet(d.repoPath)).filter((alts) => !alts.some((t) => types.includes(t))).map((alts) => alts[0]!);
      checks["ios.screenshots"] = { at, ok: missing.length === 0, note: missing.length ? `Missing in ${locale}: ${missing.map(displayLabel).join(", ")}.` : `Every required size is there (${locale}).` };
    } catch (err) {
      checks["ios.screenshots"] = { at, ok: false, note: errText(err) };
    }
  }
  return { facts, previews, checks };
}

async function syncAndroid(d: SetupDeps, f: StoreFile): Promise<{ facts: Partial<Record<FactKey, FactResult>>; graphics: Record<string, string | null>; checks: SetupState["checks"] }> {
  const play = d.play!;
  const pkg = d.ids.packageName!;
  const s = f.setup;
  const facts: Partial<Record<FactKey, FactResult>> = {};
  const graphics: Record<string, string | null> = {};
  const checks: SetupState["checks"] = {};
  const at = d.now.toISOString();
  const det = approvedValue(s, "android.details");
  if (det) {
    try {
      const cur = await play.details(pkg);
      const change: Record<string, string> = {};
      for (const k of ["contactEmail", "contactPhone", "contactWebsite", "defaultLanguage"] as const) if (det[k] && !sameText(cur[k], det[k])) change[k] = String(det[k]);
      if (Object.keys(change).length) await play.setDetails(pkg, change);
      facts["android.details"] = { ok: true, wrote: Object.keys(change).length > 0, error: null };
    } catch (err) {
      facts["android.details"] = { ok: false, wrote: false, error: errText(err) };
    }
  }
  const vid = approvedValue(s, "android.video");
  if (vid?.url) {
    try {
      const cur = await play.videos(pkg);
      const langs = Object.keys(cur).filter((l) => cur[l] !== vid.url);
      await play.setVideo(pkg, langs, String(vid.url));
      facts["android.video"] = { ok: true, wrote: langs.length > 0, error: null };
    } catch (err) {
      facts["android.video"] = { ok: false, wrote: false, error: errText(err) };
    }
  }
  const langs = Object.keys(f.listings.android ?? {}).length ? Object.keys(f.listings.android ?? {}) : [String(det?.defaultLanguage ?? f.settings.locales[0] ?? "en-US")];
  for (const g of s.graphics.filter((x) => (x.kind === "playIcon" || x.kind === "featureGraphic") && x.status === "approved")) {
    try {
      const file = d.graphicPath?.(g);
      if (!file) throw new Error("the image file is gone — day2 makes it again.");
      for (const l of langs) await play.replaceImages(pkg, l, g.kind === "playIcon" ? "icon" : "featureGraphic", [file]);
      graphics[g.id] = null;
    } catch (err) {
      graphics[g.id] = errText(err);
    }
  }
  try {
    const tracks = await play.trackNotes(pkg);
    const withRelease = tracks.filter((t) => t.release);
    const lacking = withRelease.filter((t) => !t.languages.length).map((t) => t.track);
    checks["android.releaseNotes"] = { at, ok: withRelease.length > 0 && lacking.length === 0, note: !withRelease.length ? "No release on any track yet — the release flow writes the notes with the first one." : lacking.length ? `No release notes on: ${lacking.join(", ")}. The release flow writes them with the next release.` : `Release notes on ${withRelease.map((t) => t.track).join(", ")}.` };
  } catch (err) {
    checks["android.releaseNotes"] = { at, ok: false, note: errText(err) };
  }
  try {
    const types = ["phoneScreenshots", ...(f.settings.tablet ? (["sevenInchScreenshots", "tenInchScreenshots"] as const) : [])] as Array<"phoneScreenshots" | "sevenInchScreenshots" | "tenInchScreenshots">;
    const n = await play.imageCounts(pkg, langs[0]!, types);
    const missing = types.filter((t) => (n[t] ?? 0) < 2);
    checks["android.screenshots"] = { at, ok: !missing.length, note: missing.length ? `Fewer than 2 ${missing.map((t) => ({ phoneScreenshots: "phone", sevenInchScreenshots: '7" tablet', tenInchScreenshots: '10" tablet' })[t]).join(", ")} screenshots in ${langs[0]}.` : `Screenshots are there (${langs[0]}).` };
  } catch (err) {
    checks["android.screenshots"] = { at, ok: false, note: errText(err) };
  }
  return { facts, graphics, checks };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

const ANSWERS_RETRY_MS = 24 * 3_600_000;
const SYNC_EVERY_MS = 6 * 3_600_000;

/** Pure. Whether a pass is due: never ran, six hours since the last, or the owner approved something since. */
export function setupDue(s: SetupState, now: Date): boolean {
  if (!s.lastPassAt) return true;
  if (now.getTime() - Date.parse(s.lastPassAt) >= SYNC_EVERY_MS) return true;
  const since = s.lastPassAt;
  return Object.values(s.facts).some((x) => x?.state === "approved" && (x.approvedAt ?? "") > since) || s.graphics.some((g) => g.status === "approved" && !g.uploadedAt && !g.error) || Boolean(s.demo && s.demo.setAt > since);
}

/**
 * One setup pass: work out the answers once (agent), propose what's
 * missing, make the Play graphics, write every approved fact that differs
 * from the store, upload approved graphics, and read back what can be
 * checked. Logs what it did; does nothing when everything matches.
 */
export async function setupPass(d: SetupDeps, o: { force?: boolean } = {}): Promise<SetupReport> {
  const report: SetupReport = { proposed: [], wrote: [], graphics: [], problems: [] };
  let f = await d.store.load(d.appId);
  if (!o.force && !setupDue(f.setup, d.now)) return report;
  const practices = await d.practices().catch(() => ({ ads: false, purchases: false }));

  // 1. Answers from the code, once (retried a day later if the agent failed).
  // (Needs the app scan first, like research; until then the proposals start empty for the owner to fill.)
  let answers = f.setup.answers;
  if (!answers && d.profile && (!f.setup.answersAt || d.now.getTime() - Date.parse(f.setup.answersAt) >= ANSWERS_RETRY_MS) && (d.ids.bundleId || d.ids.packageName)) {
    try {
      answers = (await d.paid("agent_work", "Store setup answers", 0.8, () => d.answers({ appName: d.appName, profile: d.profile, usesAds: practices.ads, purchases: practices.purchases }))).result;
    } catch (err) {
      report.problems.push(`answers: ${errText(err)}`);
    }
  }

  // 2. Proposals for what's missing; the Play graphics.
  const proposals = proposeFacts(f.setup, { answers, ids: d.ids, appName: d.appName, locales: f.settings.locales, now: d.now });
  report.proposed = Object.keys(proposals) as FactKey[];
  const made: Graphic[] = [];
  if (d.ids.packageName && d.makeGraphics && d.profile) {
    const need = (["playIcon", "featureGraphic"] as const).filter((k) => !f.setup.graphics.some((g) => g.kind === k && g.status !== "failed"));
    if (need.length) {
      try {
        const files = await d.makeGraphics([...need]);
        const auto = f.settings.autonomy.listing === "auto";
        for (const k of need)
          if (files[k]) made.push({ id: `SG-${d.now.getTime().toString(36)}-${k}`, kind: k, file: files[k]!, locale: null, previewType: null, status: auto ? "approved" : "draft", at: d.now.toISOString(), uploadedAt: null, error: null });
      } catch (err) {
        report.problems.push(`graphics: ${errText(err)}`);
      }
    }
  }
  const fresh = answers !== f.setup.answers;
  const tried = Boolean(d.profile) && !answers;
  if (fresh || tried || report.proposed.length || made.length)
    f = await d.store.update(d.appId, (x) => {
      if (fresh && answers && !x.setup.answers) {
        x.setup.answers = answers;
        x.setup.answersAt = d.now.toISOString();
        // Proposals made before the answers (no app scan yet) get the blanks filled.
        const late = proposeFacts({ ...x.setup, facts: {} }, { answers, ids: d.ids, appName: d.appName, locales: x.settings.locales, now: d.now });
        for (const [k, v] of Object.entries(late) as Array<[FactKey, Fact]>) {
          const have = x.setup.facts[k];
          if (have?.state !== "proposed") continue;
          if (k === "ios.ageRating") have.value = v.value;
          else for (const [field, val] of Object.entries(v.value)) if (have.value[field] === "" || have.value[field] == null) have.value[field] = val;
          have.why = v.why;
        }
      }
      if (tried) x.setup.answersAt = d.now.toISOString();
      for (const [k, v] of Object.entries(proposals)) if (!x.setup.facts[k as FactKey]) x.setup.facts[k as FactKey] = v;
      x.setup.graphics.push(...made);
      if (report.proposed.length) line(x, d.now, `Store setup: ${report.proposed.length} answer${report.proposed.length === 1 ? "" : "s"} ready for your OK (${report.proposed.map((k) => FACT_TITLE[k]).join(", ")}).`);
      if (made.length) line(x, d.now, `Store setup: made the Google Play ${made.map((g) => (g.kind === "playIcon" ? "icon" : "feature graphic")).join(" and ")}${made[0]!.status === "draft" ? " — waiting for your OK" : ""}.`);
      return { file: x, result: x };
    });
  if (made.length) report.graphics.push(...made.map((g) => g.id));

  // 3. The icon check (and a ticket when it's wrong).
  const icon = d.ids.bundleId ? checkAppIcon(d.repoPath) : null;
  if (icon && !icon.ok && icon.path) await d.ticket(iconTicket(icon)).catch(() => null);

  // 4. Approved facts and graphics into the stores; read-backs.
  const results: Partial<Record<FactKey, FactResult>> = {};
  const graphics: Record<string, string | null> = {};
  const checks: SetupState["checks"] = {};
  if (icon) checks["ios.icon"] = { at: d.now.toISOString(), ok: icon.ok, note: icon.ok ? "1024×1024 PNG without transparency." : icon.problems.join(" ") };
  if (d.asc && d.ids.bundleId) {
    try {
      const r = await syncIos(d, f);
      Object.assign(results, r.facts);
      Object.assign(graphics, r.previews);
      Object.assign(checks, r.checks);
    } catch (err) {
      report.problems.push(`App Store: ${errText(err)}`);
    }
  }
  if (d.play && d.ids.packageName) {
    try {
      const r = await syncAndroid(d, f);
      Object.assign(results, r.facts);
      Object.assign(graphics, r.graphics);
      Object.assign(checks, r.checks);
    } catch (err) {
      report.problems.push(`Google Play: ${errText(err)}`);
    }
  }
  // Previews: once; after a failed try, again a week later (each try builds the app).
  const lastPreview = f.setup.graphics.filter((g) => g.kind === "preview").at(-1);
  if (d.ids.bundleId && (!lastPreview || (lastPreview.status === "failed" && d.now.getTime() - Date.parse(lastPreview.at) >= 7 * 86_400_000))) d.startPreviews?.();

  await d.store.update(d.appId, (x) => {
    recordResults(x, results, graphics, d.now, report);
    x.setup.checks = { ...x.setup.checks, ...checks };
    x.setup.lastPassAt = d.now.toISOString();
    if (report.wrote.length) line(x, d.now, `Store setup: wrote ${report.wrote.join(", ")}.`);
    return { file: x, result: null };
  });
  if (report.wrote.length) d.log(`Store setup: wrote ${report.wrote.join(", ")}.`);
  return report;
}

/** Mutates `f`: fact and graphic results from a write. */
export function recordResults(f: StoreFile, results: Partial<Record<FactKey, FactResult>>, graphics: Record<string, string | null>, now: Date, report?: SetupReport): void {
  for (const [k, r] of Object.entries(results) as Array<[FactKey, FactResult]>) {
    const fact = f.setup.facts[k];
    if (!fact || fact.state !== "approved") continue;
    fact.error = r.error;
    fact.waitsForVersion = Boolean(r.waitsForVersion);
    if (r.manual) fact.manual = [...new Set(r.manual)];
    if (r.ok) fact.syncedAt = now.toISOString();
    if (r.wrote) report?.wrote.push(FACT_TITLE[k].toLowerCase());
    if (r.error && !r.waitsForVersion) report?.problems.push(`${FACT_TITLE[k]}: ${r.error}`);
  }
  for (const [id, error] of Object.entries(graphics)) {
    const g = f.setup.graphics.find((x) => x.id === id);
    if (!g) continue;
    g.error = error;
    if (!error) {
      g.status = "uploaded";
      g.uploadedAt = now.toISOString();
      report?.wrote.push(g.kind === "preview" ? `the ${g.locale} app preview` : g.kind === "playIcon" ? "the Google Play icon" : "the feature graphic");
    }
  }
}

// ---------------------------------------------------------------------------
// The checklist
// ---------------------------------------------------------------------------

export const supportsTablet = (repoPath: string): boolean => {
  try {
    const j = JSON.parse(readFileSync(join(repoPath, "app.json"), "utf-8")) as { expo?: { ios?: { supportsTablet?: boolean } } };
    return j.expo?.ios?.supportsTablet === true;
  } catch {
    return false;
  }
};

/** Apple's required screenshot sizes: an iPhone set (6.9" or 6.5"), and the 13" iPad when the app runs on iPad. */
export const requiredScreenshotTypes = (tablet: boolean): string[][] => [["APP_IPHONE_67", "APP_IPHONE_65"], ...(tablet ? [["APP_IPAD_PRO_3GEN_129", "APP_IPAD_PRO_129"]] : [])];
const displayLabel = (t: string) => ({ APP_IPHONE_67: 'iPhone 6.9"', APP_IPHONE_65: 'iPhone 6.5"', APP_IPAD_PRO_3GEN_129: 'iPad 13"' })[t] ?? t;

/** Export compliance answered in the app config (ITSAppUsesNonExemptEncryption), or null when it isn't. */
export function encryptionAnswer(repoPath: string): boolean | null {
  try {
    const j = JSON.parse(readFileSync(join(repoPath, "app.json"), "utf-8")) as { expo?: { ios?: { config?: { usesNonExemptEncryption?: boolean }; infoPlist?: { ITSAppUsesNonExemptEncryption?: boolean } } } };
    const ios = j.expo?.ios;
    return ios?.config?.usesNonExemptEncryption ?? ios?.infoPlist?.ITSAppUsesNonExemptEncryption ?? null;
  } catch {
    return null;
  }
}

export type ChecklistContext = {
  appId: string;
  appName: string;
  repoPath: string;
  ids: SetupDeps["ids"];
  connected: Record<StoreId, boolean>;
  privacy: StoreStatus[];
  practices: { ads: boolean; purchases: boolean };
  /** Previews can be recorded here (a Mac with the iPhone Simulator). */
  canRecord: boolean;
  fileUrl: (file: string) => string;
};

function factItem(id: string, store: StoreId, s: SetupState, key: FactKey, connected: boolean): SetupItem {
  const fact = s.facts[key];
  const title = FACT_TITLE[key];
  const base = { id, store, title, how: "api" as const };
  if (!fact) return { ...base, status: "pending", detail: "day2 is working out the answers from the app's code." };
  const view = { key, value: fact.value, state: fact.state, why: fact.why, fields: fieldsFor(key), approvedBy: fact.approvedBy, syncedAt: fact.syncedAt };
  if (key === "android.video" && !fact.value.url) return { ...base, status: "not_needed", detail: "Optional. Add a YouTube link if you have a video; day2 puts it on the store page.", fact: view };
  if (fact.state === "proposed") return { ...base, status: "waiting", detail: `${fact.why} Check it, change what's wrong, then approve — day2 writes it and keeps it in sync.`, fact: view };
  if (!connected) return { ...base, status: "pending", detail: `Approved. day2 writes it once ${store === "ios" ? "App Store Connect" : "Google Play"} is connected (Releases page).`, fact: view };
  if (fact.error && fact.waitsForVersion) return { ...base, status: "pending", detail: fact.error, fact: view };
  if (fact.error) return { ...base, status: "problem", detail: fact.error, fact: view, error: fact.error };
  if (fact.syncedAt) return { ...base, status: "done", detail: `In the store; day2 keeps it there. Checked ${fact.syncedAt.slice(0, 10)}.`, fact: view };
  return { ...base, status: "pending", detail: "Approved. day2 writes it in its next pass.", fact: view };
}

function guidedItem(id: GuidedKey, store: StoreId, s: SetupState, g: Guided): SetupItem {
  const version = answersVersion(g.answers);
  const c = s.confirmed[id];
  const done = c?.version === version;
  return {
    id,
    store,
    title: g.title,
    how: "guided",
    status: done ? "done" : "owner",
    detail: done ? `You did this${c?.by ? ` (${c.by})` : ""} on ${c!.at.slice(0, 10)}. Google offers no way to read it back; day2 asks again when its answers change.` : `Google has no API for this. day2 prepared the answers (${g.where}) — copy each one, then say "Done".`,
    answers: g.answers,
    steps: g.steps,
    version,
    confirmedAt: c?.at ?? null,
  };
}

function checkItem(id: string, store: StoreId, title: string, s: SetupState, o: { how?: SetupItem["how"]; whenUnknown: string; okStatus?: SetupStatus; notOkStatus?: SetupStatus }): SetupItem {
  const c = s.checks[id];
  if (!c) return { id, store, title, how: o.how ?? "check", status: "pending", detail: o.whenUnknown };
  return { id, store, title, how: o.how ?? "check", status: c.ok ? (o.okStatus ?? "done") : (o.notOkStatus ?? "problem"), detail: c.note };
}

/** Pure-ish (reads the app config). Every item per store, with its status. */
export function setupItems(f: StoreFile, ctx: ChecklistContext): { ios: SetupItem[]; android: SetupItem[] } {
  const s = f.setup;
  const ios: SetupItem[] = [];
  const android: SetupItem[] = [];
  const graphicsOf = (kind: Graphic["kind"]) => s.graphics.filter((g) => g.kind === kind).slice(-3).map((g) => ({ id: g.id, kind: g.kind, status: g.status, url: ctx.fileUrl(g.file), locale: g.locale, error: g.error }));
  const locale = f.settings.locales[0] ?? "en-US";
  const pendingTexts = (store: StoreId, fields: string[]) => f.proposals.some((p) => p.store === store && p.status === "pending" && fields.includes(p.field));
  const textsItem = (id: string, store: StoreId, title: string, fields: string[], required: string[]): SetupItem => {
    const have = (store === "ios" ? f.listings.ios : f.listings.android)?.[locale] as Record<string, string | undefined> | undefined;
    const missing = required.filter((k) => !have?.[k]?.trim());
    if (pendingTexts(store, fields)) return { id, store, title, how: "api", status: "waiting", detail: "day2 wrote new texts — they're waiting for your OK on the Listing tab." };
    if (!missing.length) return { id, store, title, how: "api", status: "done", detail: `In the store (${locale}). day2 researches and improves them every 30 days (Listing tab).` };
    return { id, store, title, how: "api", status: "pending", detail: `Not in the store yet (${locale}): ${missing.join(", ")}. day2 writes them with its next research (Listing tab).` };
  };

  if (ctx.ids.bundleId) {
    ios.push(textsItem("ios.nameSubtitle", "ios", "Name and subtitle", ["name", "subtitle"], ["name"]));
    ios.push(factItem("ios.categories", "ios", s, "ios.categories", ctx.connected.ios));
    ios.push(factItem("ios.contentRights", "ios", s, "ios.contentRights", ctx.connected.ios));
    ios.push(factItem("ios.privacyUrls", "ios", s, "ios.privacyUrls", ctx.connected.ios));
    ios.push(textsItem("ios.versionTexts", "ios", "Description, keywords, promotional text, what's new", ["description", "keywords", "promotionalText", "whatsNew"], ["description", "keywords"]));
    ios.push(factItem("ios.versionInfo", "ios", s, "ios.versionInfo", ctx.connected.ios));
    const age = factItem("ios.ageRating", "ios", s, "ios.ageRating", ctx.connected.ios);
    const manual = s.facts["ios.ageRating"]?.manual ?? [];
    if (manual.length && age.status === "done") {
      const labels = Object.fromEntries([...AGE_FREQUENCY, ...AGE_BOOLEAN]);
      const v = s.facts["ios.ageRating"]!.value;
      const answers = manual.map((k) => ({ q: labels[k] ?? k, a: typeof v[k] === "boolean" ? (v[k] ? "Yes" : "No") : (FREQUENCY_VALUES.find(([x]) => x === v[k])?.[1] ?? String(v[k])) }));
      const version = answersVersion(answers);
      const done = s.confirmed["ios.ageRating"]?.version === version;
      ios.push({ ...age, how: "guided", status: done ? "done" : "owner", detail: done ? "day2 wrote the rest; you set these in App Store Connect." : "day2 wrote every answer Apple takes through its API. Apple didn't take these — set them in App Store Connect → App Information → Age Rating → Edit, then say \"Done\".", answers, version, link: { label: "Open App Store Connect", url: ctx.ids.appStoreId ? `https://appstoreconnect.apple.com/apps/${ctx.ids.appStoreId}/distribution/info` : "https://appstoreconnect.apple.com/apps" } });
    } else ios.push(age);
    const review = factItem("ios.review", "ios", s, "ios.review", ctx.connected.ios);
    review.demo = { set: Boolean(s.demo), label: s.demo?.label ?? null, setAt: s.demo?.setAt ?? null };
    if (s.facts["ios.review"]?.value.signInRequired && !s.demo && review.status !== "waiting") Object.assign(review, { status: "owner", detail: "Reviewers need to sign in: add a demo account. day2 stores it encrypted, never shows it again, and writes it into App Store Connect." });
    ios.push(review);
    ios.push(factItem("ios.pricing", "ios", s, "ios.pricing", ctx.connected.ios));
    ios.push(checkItem("ios.icon", "ios", "App icon", s, { whenUnknown: "day2 checks the app's icon (1024×1024, no transparency) with its next pass." }));
    const shots = checkItem("ios.screenshots", "ios", "Screenshots", s, { whenUnknown: "day2 checks the sizes in App Store Connect once it's connected.", notOkStatus: "pending" });
    if (shots.status !== "done") shots.detail += f.screenshots.some((x) => x.status === "approved" && !x.uploaded.ios) ? " Approved screenshots go in with the next version." : f.screenshots.some((x) => x.status === "draft") ? " New screenshots are waiting for your OK (Screenshots tab)." : " day2 makes them on the Screenshots tab.";
    if (f.screenshots.some((x) => x.status === "draft") && shots.status !== "done") shots.status = "waiting";
    ios.push(shots);
    const allPreviews = graphicsOf("preview");
    const previews = allPreviews.filter((g) => g.status !== "failed");
    const lastTry = allPreviews.at(-1);
    ios.push({
      id: "ios.previews",
      store: "ios",
      title: "App previews (video)",
      how: "api",
      graphics: previews,
      ...(lastTry?.status === "failed" && !previews.length
        ? { status: "problem" as const, detail: `The last recording didn't work: ${lastTry.error ?? "no video came out"}. day2 tries again in a week.`, error: lastTry.error }
        : previews.some((g) => g.status === "draft")
        ? { status: "waiting", detail: "day2 recorded a preview on the iPhone Simulator — watch it and approve. It goes in with the next App Store version." }
        : previews.some((g) => g.status === "uploaded")
          ? { status: "done", detail: "In the store." }
          : previews.some((g) => g.status === "approved")
            ? { status: "pending", detail: "Approved. Goes in with the next App Store version." }
            : ctx.canRecord
              ? { status: "pending", detail: "Optional. day2 records a 15–30 second preview on this Mac's iPhone Simulator while the app's flow runs (needs ffmpeg)." }
              : { status: "not_needed", detail: "Optional. Previews are recorded on a Mac with the iPhone Simulator and ffmpeg (local mode); this server can't." }),
    });
    ios.push(checkItem("ios.build", "ios", "Build for the version", s, { how: "release", whenUnknown: "The release flow picks the build and attaches it when it submits a version.", notOkStatus: "pending" }));
    const enc = encryptionAnswer(ctx.repoPath);
    ios.push({ id: "ios.exportCompliance", store: "ios", title: "Export compliance (encryption)", how: "release", status: "done", detail: enc === false ? "Answered in the app config: no encryption beyond what's exempt (HTTPS)." : enc === true ? "The app config says it uses non-exempt encryption — Apple asks for the export documents in App Store Connect." : "The release flow answers it for each build: no encryption beyond what's exempt (HTTPS)." });
    const priv = ctx.privacy.find((p) => p.store === "ios");
    ios.push({ id: "ios.privacy", store: "ios", title: "App Privacy", how: "guided", status: priv?.upToDate ? "done" : "owner", detail: priv?.upToDate ? "Your answers match what's in the app." : "Apple has no API for App Privacy. day2 prepared the exact answers on the Privacy page.", link: { label: "Open the Privacy page", url: `/apps/${ctx.appId}/privacy` }, ...(priv && !priv.upToDate ? { answers: priv.steps.map((x, i) => ({ q: `Change ${i + 1}`, a: x })), steps: walkthrough("ios", priv.steps, { appName: ctx.appName, appStoreId: ctx.ids.appStoreId }) } : {}) });
  }

  if (ctx.ids.packageName) {
    android.push(textsItem("android.listing", "android", "Title, short and full description", ["title", "shortDescription", "fullDescription"], ["title", "shortDescription", "fullDescription"]));
    android.push(factItem("android.details", "android", s, "android.details", ctx.connected.android));
    for (const [kind, title, size] of [["playIcon", "Hi-res icon", "512×512 PNG"], ["featureGraphic", "Feature graphic", "1024×500"]] as const) {
      const gs = graphicsOf(kind);
      android.push({
        id: `android.${kind}`,
        store: "android",
        title,
        how: "api",
        graphics: gs,
        ...(gs.some((g) => g.status === "draft")
          ? { status: "waiting", detail: `day2 made it (${size}) in the app's colors — approve it and it goes up.` }
          : gs.some((g) => g.status === "uploaded")
            ? { status: "done", detail: "On Google Play." }
            : gs.some((g) => g.status === "approved" && g.error)
              ? { status: "problem", detail: gs.find((g) => g.error)!.error!, error: gs.find((g) => g.error)!.error }
              : gs.some((g) => g.status === "approved")
                ? { status: "pending", detail: ctx.connected.android ? "Approved. day2 uploads it in its next pass." : "Approved. day2 uploads it once Google Play is connected." }
                : { status: "pending", detail: `day2 makes it (${size}) from the app icon and the brand's colors.` }),
      });
    }
    const shots = checkItem("android.screenshots", "android", f.settings.tablet ? "Screenshots (phone, 7\" and 10\" tablet)" : "Screenshots (phone)", s, { whenUnknown: "day2 checks them on Google Play once it's connected.", notOkStatus: "pending" });
    if (shots.status !== "done") shots.detail += " day2 makes them on the Screenshots tab.";
    android.push(shots);
    android.push(factItem("android.video", "android", s, "android.video", ctx.connected.android));
    android.push(checkItem("android.releaseNotes", "android", "Release notes per track", s, { how: "release", whenUnknown: "The release flow writes the notes with every release.", notOkStatus: "pending" }));
    const priv = ctx.privacy.find((p) => p.store === "android");
    android.push({ id: "android.dataSafety", store: "android", title: "Data safety", how: "guided", status: priv?.upToDate ? "done" : "owner", detail: priv?.upToDate ? "Your answers match what's in the app." : "day2 prepared the exact answers on the Privacy page (step by step).", link: { label: "Open the Privacy page", url: `/apps/${ctx.appId}/privacy` }, ...(priv && !priv.upToDate ? { answers: priv.steps.map((x, i) => ({ q: `Change ${i + 1}`, a: x })), steps: walkthrough("android", priv.steps, { appName: ctx.appName, appStoreId: null }) } : {}) });
    const a = s.answers;
    if (a) {
      const review = s.facts["ios.review"]?.value;
      const details = s.facts["android.details"]?.value;
      const g = guidedPlay(a, { appName: ctx.appName, contactEmail: String(details?.contactEmail || review?.email || a.facts.contactEmail || ""), containsAds: ctx.practices.ads || a.play.containsAds, purchases: ctx.practices.purchases, signInRequired: Boolean(review?.signInRequired ?? a.facts.signInRequired), ageRating: (s.facts["ios.ageRating"]?.value ?? a.ageRating) as Record<string, unknown> });
      for (const k of ["android.category", "android.contentRating", "android.targetAudience", "android.ads", "android.appAccess", "android.declarations"] as GuidedKey[]) if (g[k]) android.push(guidedItem(k, "android", s, g[k]!));
    } else
      android.push({ id: "android.forms", store: "android", title: "Content rating, target audience, ads, app access, declarations, category", how: "guided", status: "pending", detail: "day2 is preparing the answers from the app's code." });
  }
  return { ios, android };
}

/** Pure. The Play guided steps' current answers, by key (to confirm the version the owner saw). */
export function guidedVersion(f: StoreFile, ctx: ChecklistContext, key: GuidedKey): string | null {
  const items = setupItems(f, ctx);
  return [...items.ios, ...items.android].find((i) => i.id === key)?.version ?? null;
}

export const countByStatus = (items: SetupItem[]) => items.reduce<Record<SetupStatus, number>>((acc, i) => ({ ...acc, [i.status]: acc[i.status] + 1 }), { done: 0, waiting: 0, owner: 0, not_needed: 0, pending: 0, problem: 0 });

/** What waits for the owner (the Store page's tab badge). */
export const setupWaiting = (f: StoreFile) => Object.values(f.setup.facts).filter((x) => x?.state === "proposed").length + f.setup.graphics.filter((g) => g.status === "draft").length;
