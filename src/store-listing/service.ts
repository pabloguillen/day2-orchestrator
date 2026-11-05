import { randomUUID } from "node:crypto";
import type { IncomingItem, NewTicketInput, Ticket } from "../backlog";
import type { AppProfile } from "../onboarding";
import type { AscListingClient } from "./asc";
import { research as itunesResearch, type Itunes } from "./itunes";
import { addProposals, countryFor, type Suggestion } from "./listing";
import { customPageFor, mapExperimentState, mapPageState, ppidOf, startAppleTest } from "./page-tests";
import type { PlayListingClient } from "./play-listing";
import { addSnapshot, autoSend, fromApple, fromPlay, mergeReviews, needsDraft, problemItem, problemKey, isReviewTicket, type Problem } from "./reviews";
import { sizeById } from "./screenshots";
import type { StoreListingStore } from "./store";
import type { WriteInput } from "./research";
import type { AppleListing, Competitor, KeywordStat, PlayListing, ScreenshotSet, StoreFile, StoreId, StoreReview } from "./types";

/**
 * What the Store module does, as steps the pass (growth autopilot) and the
 * console's buttons share. Every network call and agent run comes in
 * through `StoreDeps`, so the steps are tested with fakes.
 */

export type Paid = <T>(service: "agent_work" | "content_generation", label: string, maxUsd: number, fn: () => Promise<T>) => Promise<{ result: T; credits: number }>;

export type StoreAgents = {
  terms(i: { appName: string; profile: AppProfile; locales: string[]; current: string[] }): Promise<Record<string, string[]>>;
  write(i: WriteInput): Promise<{ summary: string; suggestions: Suggestion[] } | null>;
  replies(appName: string, profile: AppProfile, reviews: StoreReview[]): Promise<Map<string, string>>;
  triage(appName: string, reviews: StoreReview[], existing: Array<{ key: string; title: string }>): Promise<Problem[]>;
};

export type StoreDeps = {
  now: Date;
  appId: string;
  appName: string;
  store: StoreListingStore;
  asc: AscListingClient | null;
  play: PlayListingClient | null;
  itunes: Itunes;
  ids: { bundleId: string | null; packageName: string | null; appStoreId: string | null };
  profile: AppProfile | null;
  agents: StoreAgents;
  paid: Paid;
  /** Backlog: create once by source key, upsert signals, read tickets. */
  ticket(t: NewTicketInput): Promise<{ id: string; state: string; created: boolean }>;
  ingest(items: IncomingItem[]): Promise<void>;
  tickets(): Promise<Ticket[]>;
  /** iOS versions with the date each went live (reviews don't say which version they're about). */
  timeline(): Promise<Array<{ version: string; from: string }>>;
  /** Framed screenshots of a set at a size, as files. */
  screenshotFiles(set: ScreenshotSet, sizeId: string): string[];
  log(text: string, credits?: number): void;
  /** What day2 knows about the app and what the owner said no to (memory/runtime.ts `proposalContext`). */
  knowledge?: () => Promise<{ memory: string; avoid: string[]; blocked: { blocked: boolean; why?: string }; worked?: string[] }>;
  /** The hard filter: drops suggestions the owner already declined. */
  dropDeclined?: (s: Suggestion[]) => Promise<Suggestion[]>;
};

const line = (f: StoreFile, now: Date, text: string, credits?: number) => f.log.push({ at: now.toISOString(), text, ...(credits ? { credits } : {}) });
const errText = (err: unknown) => (err as Error).message.replace(/^(App Store Connect|Google Play): /, "");

// ---------------------------------------------------------------------------
// Listing: read, apply
// ---------------------------------------------------------------------------

/** Reads both stores' listings (what's there now) into the file. */
export async function readListings(d: StoreDeps): Promise<StoreFile> {
  const errors: Partial<Record<StoreId, string>> = {};
  let ios: Record<string, AppleListing> | null = null;
  let android: Record<string, PlayListing> | null = null;
  if (d.asc && d.ids.bundleId) {
    try {
      ios = (await d.asc.readListing(await d.asc.appIdFor(d.ids.bundleId))).locales;
    } catch (err) {
      errors.ios = errText(err);
    }
  } else errors.ios = d.ids.bundleId ? "Connect App Store Connect (Releases page) so day2 can read and change the listing." : "The app config has no iOS bundle id.";
  if (d.play && d.ids.packageName) {
    try {
      android = await d.play.readListings(d.ids.packageName);
    } catch (err) {
      errors.android = errText(err);
    }
  } else errors.android = d.ids.packageName ? "Connect Google Play (Releases page) so day2 can read and change the listing." : "The app config has no Android package.";
  return d.store.update(d.appId, (f) => {
    f.listings = { ios: ios ?? f.listings.ios, android: android ?? f.listings.android, readAt: d.now.toISOString(), errors };
    return { file: f, result: f };
  });
}

/**
 * Approved changes go out: Apple's promotional text at once; other Apple
 * texts are staged for the next App Store version (written into a version
 * being prepared right away, if there is one); Google Play's in one edit.
 */
export async function applyApproved(d: StoreDeps): Promise<{ applied: string[]; staged: string[]; failed: string[] }> {
  const f = await d.store.load(d.appId);
  const out = { applied: [] as string[], staged: [] as string[], failed: [] as string[] };
  const approved = f.proposals.filter((p) => p.status === "approved");
  const results = new Map<string, { status: "applied" | "staged" | "approved"; error: string | null; to?: string | null }>();

  const appleId = d.asc && d.ids.bundleId ? await d.asc.appIdFor(d.ids.bundleId).catch(() => null) : null;
  for (const p of approved.filter((x) => x.store === "ios")) {
    if (p.applyHow === "now") {
      if (!d.asc || !appleId) continue;
      try {
        await d.asc.setPromotionalText(appleId, p.locale, p.after);
        results.set(p.id, { status: "applied", error: null });
      } catch (err) {
        results.set(p.id, { status: "approved", error: errText(err) });
      }
    } else results.set(p.id, { status: "staged", error: null });
  }
  const play = approved.filter((x) => x.store === "android");
  if (play.length && d.play && d.ids.packageName) {
    const byLang: Record<string, PlayListing> = {};
    for (const p of play) byLang[p.locale] = { ...(byLang[p.locale] ?? {}), [p.field]: p.after };
    try {
      await d.play.writeListings(d.ids.packageName, byLang);
      for (const p of play) results.set(p.id, { status: "applied", error: null });
    } catch (err) {
      for (const p of play) results.set(p.id, { status: "approved", error: errText(err) });
    }
  }

  // A version being prepared in App Store Connect takes the staged texts now.
  let editable: { id: string; version: string | null } | null = null;
  const anyStaged = [...results.values()].some((r) => r.status === "staged") || f.proposals.some((p) => p.status === "staged");
  if (d.asc && appleId && anyStaged) editable = (await d.asc.versions(appleId).catch(() => null))?.editable ?? null;

  return d.store.update(d.appId, async (file) => {
    for (const p of file.proposals) {
      const r = results.get(p.id);
      if (!r || p.status !== "approved") continue;
      p.status = r.status;
      p.error = r.error;
      if (r.status === "applied") {
        p.appliedAt = d.now.toISOString();
        out.applied.push(p.id);
      } else if (r.status === "staged") out.staged.push(p.id);
      else out.failed.push(p.id);
    }
    if (editable && d.asc && appleId) {
      const done = await writeStaged(file, d.asc, appleId, editable.id, editable.version, d.now);
      if (done.length) line(file, d.now, `Wrote ${done.length} listing change${done.length === 1 ? "" : "s"} into App Store version ${editable.version ?? ""} (being prepared in App Store Connect).`);
    }
    if (out.applied.length) line(file, d.now, `Changed ${out.applied.length} listing text${out.applied.length === 1 ? "" : "s"} in the stores.`);
    if (out.staged.length) line(file, d.now, `${out.staged.length} App Store change${out.staged.length === 1 ? "" : "s"} wait${out.staged.length === 1 ? "s" : ""} for the next App Store version.`);
    return { file, result: out };
  });
}

/** Writes staged Apple texts into a version being prepared; marks them applied. Mutates `file`. */
export async function writeStaged(file: StoreFile, asc: AscListingClient, appleId: string, versionId: string, version: string | null, now: Date): Promise<string[]> {
  const staged = file.proposals.filter((p) => p.store === "ios" && p.status === "staged");
  if (!staged.length) return [];
  const byLocale: Record<string, AppleListing> = {};
  for (const p of staged) byLocale[p.locale] = { ...(byLocale[p.locale] ?? {}), [p.field]: p.after };
  try {
    await asc.writeVersionTexts(appleId, versionId, byLocale);
  } catch (err) {
    for (const p of staged) p.error = errText(err);
    return [];
  }
  for (const p of staged) {
    p.status = "applied";
    p.appliedAt = now.toISOString();
    p.appliedTo = version;
    p.error = null;
  }
  return staged.map((p) => p.id);
}

/**
 * The release flow's hook (mobile-release): right before day2 submits an
 * App Store version, staged texts and approved screenshots go into it.
 */
export async function prepareVersion(d: Pick<StoreDeps, "store" | "appId" | "now" | "screenshotFiles">, asc: AscListingClient, appleId: string, versionId: string, version: string | null): Promise<string[]> {
  return d.store.update(d.appId, async (file) => {
    const done = await writeStaged(file, asc, appleId, versionId, version, d.now);
    const sets = file.screenshots.filter((s) => s.status === "approved" && !s.uploaded.ios);
    for (const s of sets) {
      try {
        const loc = await asc.versionLocalizationId(versionId, s.locale);
        for (const sizeId of s.sizes) {
          const size = sizeById(sizeId);
          if (!size || size.store !== "ios" || !size.displayType) continue;
          await asc.replaceScreenshots({ kind: "appStoreVersionLocalizations", id: loc }, size.displayType, d.screenshotFiles(s, sizeId));
        }
        s.uploaded.ios = version ?? d.now.toISOString();
        if (s.uploaded.android || !s.sizes.some((x) => sizeById(x)?.store === "android")) s.status = "uploaded";
        done.push(s.id);
      } catch (err) {
        s.error = errText(err);
      }
    }
    if (done.length) line(file, d.now, `Put ${done.length} approved listing change${done.length === 1 ? "" : "s"} into App Store version ${version ?? ""}.`);
    return { file, result: done };
  });
}

/** Approved screenshot sets: Google Play's go up at once (one edit per language and type: phone, and tablets when on); Apple's wait for the next version. */
export async function uploadApprovedScreens(d: StoreDeps): Promise<string[]> {
  if (!d.play || !d.ids.packageName) return [];
  const f = await d.store.load(d.appId);
  const sets = f.screenshots.filter((s) => s.status === "approved" && !s.uploaded.android && s.sizes.includes("android-phone"));
  const done: Array<{ id: string; error: string | null }> = [];
  for (const s of sets) {
    try {
      await d.play.replacePhoneScreenshots(d.ids.packageName, s.locale, d.screenshotFiles(s, "android-phone"));
      for (const t of s.sizes.map((x) => sizeById(x)).filter((z) => z?.store === "android" && z.displayType))
        await d.play.replacePhoneScreenshots(d.ids.packageName, s.locale, d.screenshotFiles(s, t!.id), t!.displayType as "sevenInchScreenshots" | "tenInchScreenshots");
      done.push({ id: s.id, error: null });
    } catch (err) {
      done.push({ id: s.id, error: errText(err) });
    }
  }
  if (!done.length) return [];
  return d.store.update(d.appId, (file) => {
    for (const r of done) {
      const s = file.screenshots.find((x) => x.id === r.id);
      if (!s) continue;
      s.error = r.error;
      if (!r.error) {
        s.uploaded.android = d.now.toISOString();
        if (s.uploaded.ios || !s.sizes.some((x) => sizeById(x)?.store === "ios")) s.status = "uploaded";
      }
    }
    const ok = done.filter((r) => !r.error).length;
    if (ok) line(file, d.now, `Uploaded ${ok} screenshot set${ok === 1 ? "" : "s"} to Google Play.`);
    return { file, result: done.filter((r) => !r.error).map((r) => r.id) };
  });
}

// ---------------------------------------------------------------------------
// Research → proposals
// ---------------------------------------------------------------------------

export async function runResearch(d: StoreDeps, why: "schedule" | "release" | "owner", version: string | null): Promise<{ run: { id: string; proposals: string[] } | null; skipped: string | null }> {
  if (!d.profile) return { run: null, skipped: "day2 needs the app scan (App profile) before researching the store listing." };
  const file = await readListings(d);
  const stores: StoreId[] = [...(file.listings.ios || d.ids.bundleId ? (["ios"] as const) : []), ...(file.listings.android || d.ids.packageName ? (["android"] as const) : [])];
  if (!stores.length) return { run: null, skipped: "the app has no store ids in its config" };
  // Before spending credits: has the owner ruled listing changes out?
  const known = d.knowledge ? await d.knowledge() : null;
  if (known?.blocked.blocked) return { run: null, skipped: `day2 won't propose listing changes: ${known.blocked.why}` };
  const locales = file.settings.locales;
  const firstApple = file.listings.ios?.[locales[0] ?? ""] ?? Object.values(file.listings.ios ?? {})[0];
  const current = (firstApple?.keywords ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  let credits = 0;

  const terms = await d.paid("agent_work", "Store search terms", 0.3, () => d.agents.terms({ appName: d.appName, profile: d.profile!, locales, current }));
  credits += terms.credits;
  const keywords: KeywordStat[] = [];
  const competitors: Competitor[] = [];
  let ownId = d.ids.appStoreId;
  if (!ownId && d.ids.bundleId) ownId = await d.itunes.lookupBundle(d.ids.bundleId, countryFor(locales[0] ?? "en-US")).then((h) => (h?.trackId ? String(h.trackId) : null)).catch(() => null);
  for (const locale of locales) {
    const r = await itunesResearch(d.itunes, { terms: terms.result[locale] ?? current, countries: [countryFor(locale)], ownId, maxCompetitors: 6 });
    keywords.push(...r.keywords);
    for (const c of r.competitors) if (!competitors.some((x) => x.id === c.id)) competitors.push(c);
  }
  const learned = learnedFrom(file);
  const written = await d.paid("content_generation", "Store listing texts", 0.8, () => d.agents.write({ appName: d.appName, profile: d.profile!, listings: file.listings, locales, stores, keywords, competitors, ...(learned ? { learned } : {}), ...(known ? { memory: known.memory, avoid: known.avoid, ...(known.worked?.length ? { worked: known.worked } : {}) } : {}) }));
  credits += written.credits;
  if (written.result && d.dropDeclined) written.result = { ...written.result, suggestions: await d.dropDeclined(written.result.suggestions) };
  const id = `SR-${randomUUID().slice(0, 8)}`;
  return d.store.update(d.appId, (f) => {
    const auto = f.settings.autonomy.listing === "auto";
    const r = written.result ? addProposals(f, written.result.suggestions, { now: d.now, researchId: id, appName: d.appName, auto }) : { file: f, added: [], dropped: [] };
    const next = r.file;
    next.research.unshift({ id, at: d.now.toISOString(), why, version, locales, keywords, competitors, summary: written.result?.summary ?? "The writer didn't return usable suggestions this time.", proposals: r.added.map((p) => p.id), credits });
    next.researchedVersion = version ?? next.researchedVersion;
    const n = r.added.length;
    line(
      next,
      d.now,
      n
        ? `Researched ${keywords.length} App Store searches and ${competitors.length} competing apps — ${n} listing change${n === 1 ? "" : "s"} ${auto ? "approved by day2" : "waiting for your approval"}.${r.dropped.length ? ` ${r.dropped.length} suggestion${r.dropped.length === 1 ? "" : "s"} didn't fit the store's rules and were dropped.` : ""}`
        : `Researched ${keywords.length} App Store searches and ${competitors.length} competing apps — the listing holds up; no changes this time.`,
      credits,
    );
    d.log(next.log.at(-1)!.text, credits);
    return { file: next, result: { run: { id, proposals: r.added.map((p) => p.id) }, skipped: null } };
  });
}

/** Pure. What finished tests and reviews taught, for the next research. */
export function learnedFrom(f: StoreFile): string {
  const tests = f.tests.filter((t) => t.result).slice(-3).map((t) => `${t.name}: "${t.result!.winner}" won${t.result!.note ? ` (${t.result!.note})` : ""}`);
  return tests.join("; ");
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

/** Pure. Whether reviews are due (every `hours`). */
export const reviewsDue = (f: StoreFile, now: Date) => !f.reviewsFetchedAt || now.getTime() - Date.parse(f.reviewsFetchedAt) >= f.settings.reviewsEveryHours * 3_600_000;

/**
 * Reads new reviews from both stores, drafts replies in the app's voice
 * (4–5 star replies go out by themselves when the owner allows it), sends
 * approved replies, and turns 1–2 star reviews that describe a problem into
 * backlog tickets — one per problem.
 */
export async function reviewsPass(d: StoreDeps): Promise<{ added: number; drafted: number; sent: number; tickets: number; skipped: string[] }> {
  const report = { added: 0, drafted: 0, sent: 0, tickets: 0, skipped: [] as string[] };
  const file = await d.store.load(d.appId);
  const have = await d.store.reviews(d.appId);
  const fresh: StoreReview[] = [];
  if (d.asc && d.ids.bundleId) {
    try {
      const appleId = await d.asc.appIdFor(d.ids.bundleId);
      const since = have.filter((r) => r.store === "ios").map((r) => r.createdAt).sort().at(-1) ?? null;
      const timeline = await d.timeline().catch(() => []);
      fresh.push(...(await d.asc.reviews(appleId, { since })).map((r) => fromApple(r, timeline)));
    } catch (err) {
      report.skipped.push(`App Store reviews: ${errText(err)}`);
    }
  }
  if (d.play && d.ids.packageName) {
    try {
      fresh.push(...(await d.play.reviews(d.ids.packageName)).map(fromPlay));
    } catch (err) {
      report.skipped.push(`Google Play reviews: ${errText(err)}`);
    }
  }
  let { reviews, added } = mergeReviews(have, fresh);
  report.added = added.length;

  // Drafts for reviews nobody answered yet.
  const toDraft = reviews.filter(needsDraft).slice(0, 20);
  if (toDraft.length && d.profile) {
    try {
      const r = await d.paid("content_generation", "Store review replies", 0.5, () => d.agents.replies(d.appName, d.profile!, toDraft));
      reviews = reviews.map((x) => {
        if (!toDraft.includes(x)) return x;
        const text = r.result.get(x.id);
        if (!text) return { ...x, reply: { text: "", state: "skipped", by: "day2", at: d.now.toISOString(), sentAt: null, error: null } };
        return { ...x, reply: { text, state: autoSend(x, file.settings.autonomy) ? "pending" : "draft", by: "day2", at: d.now.toISOString(), sentAt: null, error: null } };
      });
      report.drafted = r.result.size;
      if (r.result.size) d.log(`Drafted ${r.result.size} review repl${r.result.size === 1 ? "y" : "ies"} in the app's voice.`, r.credits);
    } catch (err) {
      report.skipped.push(`replies: ${errText(err)}`);
    }
  }

  // Approved replies go out.
  const sent = await sendPending(d, reviews);
  reviews = sent.reviews;
  report.sent = sent.sent;

  // 1–2 stars describing a problem → backlog.
  const low = reviews.filter((r) => r.rating > 0 && r.rating <= 2 && !r.triaged && (r.body.trim() || r.title.trim()));
  if (low.length) {
    try {
      const tickets = await d.tickets();
      const existing = tickets.filter((t) => isReviewTicket(t) && t.state !== "done" && t.state !== "parked").map((t) => ({ key: t.source.key!, title: t.title }));
      const r = await d.paid("agent_work", "Store review problems", 0.4, () => d.agents.triage(d.appName, low, existing));
      const keyOf = new Map<string, string>();
      for (const p of r.result) for (const id of p.reviewIds) keyOf.set(id, p.key ?? problemKey(p.title));
      reviews = reviews.map((x) => (low.includes(x) ? { ...x, triaged: true, problemKey: keyOf.get(x.id) ?? x.problemKey } : x));
      const items = r.result.map((p) => problemItem(p, reviews, p.key ?? problemKey(p.title)));
      if (items.length) {
        await d.ingest(items);
        const after = await d.tickets();
        reviews = reviews.map((x) => (x.problemKey ? { ...x, ticketId: after.find((t) => t.source.key === x.problemKey)?.id ?? x.ticketId } : x));
        report.tickets = items.length;
        d.log(`${low.length} low-star review${low.length === 1 ? "" : "s"} read: ${items.length} problem${items.length === 1 ? "" : "s"} on the backlog.`, r.credits);
      }
    } catch (err) {
      report.skipped.push(`review problems: ${errText(err)}`);
    }
  }

  await d.store.saveReviews(d.appId, reviews);

  // The App Store's public rating, per version.
  let snapshot: { average: number | null; count: number | null; version: string | null } | null = null;
  if (d.ids.bundleId) {
    const h = await d.itunes.lookupBundle(d.ids.bundleId, countryFor(file.settings.locales[0] ?? "en-US")).catch(() => null);
    if (h) snapshot = { average: h.averageUserRating ?? null, count: h.userRatingCount ?? null, version: h.version ?? null };
  }
  await d.store.update(d.appId, (f) => {
    f.reviewsFetchedAt = d.now.toISOString();
    if (snapshot) f.ratings = addSnapshot(f.ratings, { at: d.now.toISOString(), store: "ios", ...snapshot });
    if (report.added) line(f, d.now, `${report.added} new review${report.added === 1 ? "" : "s"}${report.drafted ? `, ${report.drafted} repl${report.drafted === 1 ? "y" : "ies"} drafted` : ""}${report.sent ? `, ${report.sent} sent` : ""}.`);
    return { file: f, result: null };
  });
  return report;
}

/** Sends every approved ("pending") reply; returns the updated reviews. */
export async function sendPending(d: Pick<StoreDeps, "asc" | "play" | "ids" | "now">, reviews: StoreReview[]): Promise<{ reviews: StoreReview[]; sent: number }> {
  let sent = 0;
  const out: StoreReview[] = [];
  for (const r of reviews) {
    if (r.reply?.state !== "pending") {
      out.push(r);
      continue;
    }
    try {
      if (r.store === "ios") {
        if (!d.asc) throw new Error("App Store Connect isn't connected.");
        await d.asc.reply(r.id, r.reply.text);
      } else {
        if (!d.play || !d.ids.packageName) throw new Error("Google Play isn't connected.");
        await d.play.reply(d.ids.packageName, r.id, r.reply.text);
      }
      out.push({ ...r, existingReply: r.reply.text, reply: { ...r.reply, state: "sent", sentAt: d.now.toISOString(), error: null } });
      sent++;
    } catch (err) {
      out.push({ ...r, reply: { ...r.reply, state: "failed", error: errText(err) } });
    }
  }
  return { reviews: out, sent };
}

// ---------------------------------------------------------------------------
// Tests and custom product pages
// ---------------------------------------------------------------------------

/** Moves Apple tests and custom product pages along: create/start what's approved, follow Apple's states. */
export async function advanceTests(d: StoreDeps): Promise<string[]> {
  if (!d.asc || !d.ids.bundleId) return [];
  const asc = d.asc;
  const appleId = await asc.appIdFor(d.ids.bundleId).catch(() => null);
  if (!appleId) return [];
  const f = await d.store.load(d.appId);
  const notes: string[] = [];
  const screens = (setId: string) => {
    const set = f.screenshots.find((s) => s.id === setId);
    if (!set) return [];
    return set.sizes.map((id) => sizeById(id)).filter((s): s is NonNullable<typeof s> => Boolean(s && s.store === "ios" && s.displayType)).map((s) => ({ displayType: s.displayType!, files: d.screenshotFiles(set, s.id) }));
  };
  const tests = new Map<string, StoreFile["tests"][number]>();
  for (const t of f.tests.filter((x) => x.kind === "apple_ppo")) {
    try {
      if (t.status === "draft") {
        tests.set(t.id, await startAppleTest(asc, appleId, t, screens));
        notes.push(`Started the App Store test ${t.id} (${t.name}); Apple reviews new screenshots before it runs.`);
      } else if ((t.status === "submitted" || t.status === "running") && t.ascId) {
        const s = await asc.experimentState(t.ascId);
        const status = mapExperimentState(s.state);
        if (status !== t.status) {
          tests.set(t.id, { ...t, status, startedAt: s.startDate ?? t.startedAt, endedAt: s.endDate ?? t.endedAt });
          if (status === "finished") notes.push(`The App Store test ${t.id} finished — enter the result shown in App Store Connect.`);
        }
      }
    } catch (err) {
      tests.set(t.id, { ...t, status: t.status === "draft" ? "failed" : t.status, error: errText(err) });
    }
  }
  const pages = new Map<string, StoreFile["customPages"][number]>();
  const live = await asc.versions(appleId).then((v) => v.live?.id ?? null).catch(() => null);
  for (const p of f.customPages) {
    try {
      if (p.status === "draft") {
        const c = await asc.createCustomPage({ appId: appleId, name: p.name, locale: p.locale, promotionalText: p.promotionalText, templateVersionId: live });
        if (p.screenshotSetId && c.localizationId) for (const s of screens(p.screenshotSetId)) await asc.replaceScreenshots({ kind: "appCustomProductPageLocalizations", id: c.localizationId }, s.displayType, s.files);
        if (c.versionId) await asc.submitItem(appleId, { type: "appCustomProductPageVersions", id: c.versionId });
        pages.set(p.id, { ...p, ascId: c.id, ascVersionId: c.versionId, url: c.url, ppid: ppidOf(c.url) ?? c.id, status: "submitted", error: null });
        notes.push(`Created the custom product page ${p.id} (${p.name}) and sent it to App Review.`);
      } else if (p.status === "submitted" && p.ascVersionId) {
        const status = mapPageState(await asc.customPageState(p.ascVersionId));
        if (status !== p.status) {
          pages.set(p.id, { ...p, status });
          if (status === "live") notes.push(`The custom product page ${p.id} is live — ads for ${p.campaigns.join(", ") || "its campaigns"} lead there now.`);
        }
      }
    } catch (err) {
      pages.set(p.id, { ...p, status: p.status === "draft" ? "failed" : p.status, error: errText(err) });
    }
  }
  if (tests.size || pages.size)
    await d.store.update(d.appId, (file) => {
      file.tests = file.tests.map((t) => tests.get(t.id) ?? t);
      file.customPages = file.customPages.map((p) => pages.get(p.id) ?? p);
      for (const n of notes) line(file, d.now, n);
      return { file, result: null };
    });
  for (const n of notes) d.log(n);
  return notes;
}

/** The App Store address an ad's tag should open: its custom product page when one is live (ads/destination). */
export async function customPageUrl(store: StoreListingStore, appId: string, tag: string): Promise<string | null> {
  const f = await store.load(appId);
  return customPageFor(f.customPages, tag)?.ppid ?? null;
}
