import { workedLines } from "../learning/runtime";
import { filterProposals, proposalContext } from "../memory/runtime";
import { textTargets } from "./research";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP_LINKS_FILENAME, loadAppLinks, storeIdsFromRepo } from "../ads/app-links";
import type { AppEntry } from "../apps-registry";
import { createTicket, ingest, rankBacklog, withBacklog, type NewTicketInput } from "../backlog";
import { backlogFile } from "../backlog-work";
import { authorize, CreditsError } from "../credits";
import { deviceMode } from "../device-checks";
import { androidTarget, iosTarget } from "../device-checks/targets";
import { withCreditContext, type CreditContext } from "../metered-query";
import { gitWorkdirs } from "../mobile-release/git-workdir";
import { loadReleases, RELEASES_FILENAME } from "../mobile-release/pass";
import { APP_PROFILE_FILENAME, loadAppProfile } from "../onboarding";
import { existingIntegration } from "../field-work";
import { decryptSecret } from "../secrets";
import { loadStorePrivacy, practicesFrom, STORE_PRIVACY_FILENAME, storeStatus } from "../store-privacy";
import { releaseCredentials, type Tenant } from "../tenant";
import { createAscListing } from "./asc";
import type { SetupDeps } from "./setup";
import { deriveAnswers } from "./setup-answers";
import { createAscSetup } from "./setup-asc";
import { appIconPath, makePlayGraphics, recordPreview, setupDir, setupFilePath } from "./setup-assets";
import { createPlaySetup } from "./setup-play";
import type { Graphic } from "./setup-types";
import { createItunes } from "./itunes";
import type { StorePassDeps } from "./pass";
import { createPlayListing } from "./play-listing";
import { suggestTerms, writeListing } from "./research";
import { draftReplies, triage } from "./reviews";
import { captureRaw, frameAll, frameStyle, screenNotes, shotsDir, sizesFor, writeCaptions } from "./screenshots";
import type { Paid } from "./service";
import { storeListingFor } from "./store";
import type { ScreenshotSet, ScreenshotShot } from "./types";

/**
 * The real dependencies of the Store steps for one app: the owner's App
 * Store Connect key and Google Play service account (the ones day2 releases
 * with), the public App Store search, the agents (paid from the account's
 * credits), the backlog, and this computer's simulators.
 */

/** Runs agent work charged to the app's account; the worst case must fit first. */
export function paidFor(tenant: Tenant, app: AppEntry): Paid {
  return async (service, label, maxUsd, fn) => {
    const check = await authorize(tenant.credits, { appId: app.id, appName: app.name, service, maxCostUsd: maxUsd });
    if (!check.ok) throw new CreditsError(check);
    const ctx: CreditContext = { appId: app.id, appName: app.name, service, description: label };
    const result = await withCreditContext(ctx, fn);
    return { result, credits: ctx.charged ?? 0 };
  };
}

export async function ticketOnce(app: AppEntry, input: NewTicketInput): Promise<{ id: string; state: string; created: boolean }> {
  return withBacklog<{ id: string; state: string; created: boolean }>(backlogFile(app), (b) => {
    const have = b.tickets.find((t) => t.source.key === input.source.key && t.state !== "parked");
    if (have) return { backlog: b, result: { id: have.id, state: have.state, created: false } };
    const now = new Date();
    const r = createTicket(b, input, now);
    return { backlog: rankBacklog(r.backlog, now).backlog, result: { id: r.ticket.id, state: r.ticket.state, created: true } };
  });
}

/** iOS versions and when each went live, from day2's own release history. */
export function iosTimeline(app: AppEntry): Array<{ version: string; from: string }> {
  const f = loadReleases(resolve(app.repoPath, RELEASES_FILENAME));
  const out: Array<{ version: string; from: string }> = [];
  for (const r of [...f.history].reverse()) {
    if (r.kind !== "store" || !r.platforms.ios) continue;
    const live = r.log.find((l) => /^iOS: approved and live/.test(l.text));
    if (live || r.platforms.ios.stage === "released" || r.platforms.ios.stage === "rolling_out") out.push({ version: r.version, from: live?.at ?? r.startedAt });
  }
  return out;
}

export const screenshotFiles = (appId: string) => (set: ScreenshotSet, sizeId: string) =>
  set.shots.map((s) => s.framed[sizeId]).filter((n): n is string => Boolean(n)).map((n) => join(shotsDir(appId, set.id), n)).filter((p) => existsSync(p));

export async function storeDeps(tenant: Tenant, app: AppEntry, log: (text: string, credits?: number) => void = () => {}): Promise<StorePassDeps> {
  const creds = releaseCredentials();
  const [asc, play] = await Promise.all([creds.get(app.id, "asc"), creds.get(app.id, "play")]);
  const ids = storeIdsFromRepo(app.repoPath);
  const links = loadAppLinks(join(app.repoPath, APP_LINKS_FILENAME));
  const store = storeListingFor(app);
  const deps: StorePassDeps = {
    now: new Date(),
    appId: app.id,
    appName: links.ios?.name || app.name,
    store,
    asc: asc ? createAscListing(asc.value) : null,
    play: play ? createPlayListing(play.value) : null,
    itunes: createItunes(),
    ids: { ...ids, appStoreId: links.ios?.appStoreId ?? null },
    profile: loadAppProfile(resolve(app.repoPath, APP_PROFILE_FILENAME)),
    agents: { terms: suggestTerms, write: writeListing, replies: draftReplies, triage },
    knowledge: async () => ({ ...(await proposalContext(app, "store", ["store.text"])), worked: await workedLines(app, "store") }),
    dropDeclined: async (s) => (await filterProposals(app, "store.text", s, textTargets)).kept,
    paid: paidFor(tenant, app),
    ticket: (t) => ticketOnce(app, t),
    async ingest(items) {
      await withBacklog(backlogFile(app), (b) => {
        const now = new Date();
        return { backlog: rankBacklog(ingest(b, items, now).backlog, now).backlog, result: null };
      });
    },
    tickets: async () => (await withBacklog(backlogFile(app), (b) => ({ backlog: b, result: b }))).tickets,
    timeline: async () => iosTimeline(app),
    screenshotFiles: screenshotFiles(app.id),
    log,
    shippedVersion: async () => loadReleases(resolve(app.repoPath, RELEASES_FILENAME)).shipped?.version ?? null,
  };
  if (deviceMode() === "local") deps.startScreenshots = () => void makeScreenshots(app, deps).catch((err: Error) => log(`Screenshots: ${err.message}`));
  const tickets = async () => (await withBacklog(backlogFile(app), (b) => ({ backlog: b, result: b }))).tickets;
  const practices = async () => {
    const sp = loadStorePrivacy(resolve(app.repoPath, STORE_PRIVACY_FILENAME));
    return { file: sp, practices: practicesFrom(await tickets(), sp.settings, existingIntegration(app.repoPath)) };
  };
  const setup: SetupDeps = {
    now: deps.now,
    appId: app.id,
    appName: deps.appName,
    repoPath: app.repoPath,
    store,
    ids: deps.ids,
    asc: asc && deps.asc ? { listing: deps.asc, setup: createAscSetup(asc.value) } : null,
    play: play ? createPlaySetup(play.value) : null,
    profile: deps.profile,
    paid: deps.paid,
    answers: (i) => deriveAnswers(app.repoPath, i),
    practices: async () => {
      const p = (await practices()).practices;
      return { ads: Boolean(p.ads), purchases: Boolean(p.purchases) };
    },
    privacy: async () => {
      const p = await practices();
      return storeStatus(p.file, p.practices);
    },
    ticket: (t) => ticketOnce(app, t),
    makeGraphics: async (kinds) => {
      const f = await store.load(app.id);
      const locale = f.settings.locales[0] ?? "en-US";
      const tagline = f.listings.android?.[locale]?.shortDescription || f.listings.ios?.[locale]?.subtitle || (deps.profile?.purpose ?? "").split(/(?<=\.)\s/)[0]!.slice(0, 80);
      return makePlayGraphics({ appId: app.id, name: deps.appName, tagline, style: frameStyle(deps.profile?.brand), iconPath: appIconPath(app.repoPath) }, kinds);
    },
    graphicPath: (g: Graphic) => setupFilePath(app.id, g.file),
    demo: (secret) => JSON.parse(decryptSecret(secret, demoContext(app.id))) as { username: string; password: string },
    log,
  };
  if (deviceMode() === "local" && ids.bundleId) setup.startPreviews = () => void makePreviews(app, setup).catch((err: Error) => log(`App preview: ${err.message}`));
  deps.setup = setup;
  return deps;
}

/** What the demo account's ciphertext is bound to (secrets.ts associated data). */
export const demoContext = (appId: string) => `store-demo-account:${appId}`;

const previewing = new Set<string>();
export const makingPreviews = (appId: string) => previewing.has(appId);

/**
 * App previews: a checkout of main, the app built for the iPhone Simulator,
 * the screen recorded while the flow runs (once per language), trimmed and
 * encoded with ffmpeg. Saved as drafts (or approved, when day2 decides);
 * approved ones go into the next App Store version.
 */
export async function makePreviews(app: AppEntry, d: SetupDeps): Promise<Graphic[]> {
  if (previewing.has(app.id) || !d.ids.bundleId) return [];
  previewing.add(app.id);
  const git = gitWorkdirs(app.id, app.repoPath);
  let done: (() => Promise<void>) | null = null;
  try {
    const f = await d.store.load(app.id);
    const wd = await git.checkout((await git.head()).sha);
    done = wd.done;
    const out: Graphic[] = [];
    const notes: string[] = [];
    const style = frameStyle(d.profile?.brand);
    for (const locale of f.settings.locales) {
      const r = await recordPreview({ cwd: wd.dir, bundleId: d.ids.bundleId, locale, outDir: setupDir(app.id), pad: style.background }, { target: () => iosTarget(d.ids.bundleId!, d.appName), log: d.log });
      if ("error" in r) {
        notes.push(`${locale}: ${r.error}`);
        continue;
      }
      out.push({ id: `SG-${Date.now().toString(36)}-preview-${locale.replace(/[^\w]/g, "")}`, kind: "preview", file: r.file.split("/").pop()!, locale, previewType: "IPHONE_67", status: f.settings.autonomy.listing === "auto" ? "approved" : "draft", at: new Date().toISOString(), uploadedAt: null, error: null });
    }
    await d.store.update(app.id, (file) => {
      file.setup.graphics.push(...out);
      file.log.push({ at: new Date().toISOString(), text: out.length ? `Recorded ${out.length} App Store preview${out.length === 1 ? "" : "s"} (${out.map((g) => g.locale).join(", ")})${notes.length ? ` — ${notes.join("; ")}` : ""}.` : `App previews didn't work: ${notes.join("; ")}` });
      if (!out.length) file.setup.graphics.push({ id: `SG-${Date.now().toString(36)}-preview`, kind: "preview", file: "", locale: null, previewType: null, status: "failed", at: new Date().toISOString(), uploadedAt: null, error: notes.join("; ") || "no preview came out" });
      return { file, result: null };
    });
    return out;
  } finally {
    previewing.delete(app.id);
    await done?.().catch(() => {});
  }
}

const making = new Set<string>();
export const makingScreenshots = (appId: string) => making.has(appId);

/**
 * New store screenshots: a checkout of main, the app built and the store
 * flow run on this computer's simulator/emulator once per language,
 * captions written in the brand's voice, each screen framed at every size.
 * One run per app at a time; saved as sets waiting for approval (or
 * approved, when day2 decides).
 */
export async function makeScreenshots(app: AppEntry, d: StorePassDeps): Promise<ScreenshotSet[]> {
  if (making.has(app.id)) return [];
  making.add(app.id);
  const git = gitWorkdirs(app.id, app.repoPath);
  let done: (() => Promise<void>) | null = null;
  try {
    const f = await d.store.load(app.id);
    const head = await git.head();
    const wd = await git.checkout(head.sha);
    done = wd.done;
    const out = join(tmpdir(), `day2-store-shots-${app.id.replace(/[^\w-]/g, "_")}-${Date.now()}`);
    const cap = await captureRaw(
      { cwd: wd.dir, appId: app.id, bundleId: d.ids.bundleId, packageName: d.ids.packageName, locales: f.settings.locales, outDir: out },
      { target: (p) => (p === "ios" ? iosTarget(d.ids.bundleId!, d.appName) : androidTarget(d.ids.packageName!)), log: (t) => d.log(t) },
    );
    const names = [...new Set(Object.values(cap.shots).flatMap((byLoc) => Object.values(byLoc ?? {}).flat().map((p) => p.split("/").pop()!.replace(/\.png$/i, ""))))].sort();
    if (!names.length) throw new Error(`no screenshots came out${cap.notes.length ? ` (${cap.notes.join("; ")})` : ""}`);
    const notes = screenNotes(wd.dir);
    const screens = names.map((n) => ({ name: n, shows: notes.find((x) => x.name === n)?.shows ?? "" }));
    const captions = d.profile ? (await d.paid("content_generation", "Store screenshot captions", 0.3, () => writeCaptions(d.appName, d.profile!, screens, f.settings.locales))).result : {};
    const style = frameStyle(d.profile?.brand);
    const sizes = sizesFor(f.settings.tablet);
    const sets: ScreenshotSet[] = [];
    for (const locale of f.settings.locales) {
      const id = `SS-${Date.now().toString(36)}-${locale.replace(/[^\w]/g, "")}`;
      const pick = (p: "ios" | "android") => cap.shots[p]?.[locale] ?? cap.shots[p === "ios" ? "android" : "ios"]?.[locale] ?? [];
      const shotsFor = (p: "ios" | "android") => pick(p).map((raw) => {
        const name = raw.split("/").pop()!.replace(/\.png$/i, "");
        return { name, caption: captions[locale]?.[name] ?? "", raw };
      });
      const dir = shotsDir(app.id, id);
      const merged = new Map<string, ScreenshotShot>();
      for (const p of ["ios", "android"] as const) {
        const ss = sizes.filter((s) => s.store === p && (p === "ios" ? d.ids.bundleId : d.ids.packageName));
        if (!ss.length) continue;
        for (const s of await frameAll({ shots: shotsFor(p), sizes: ss, style, outDir: dir })) merged.set(s.name, { ...s, framed: { ...(merged.get(s.name)?.framed ?? {}), ...s.framed } });
      }
      if (!merged.size) continue;
      const used = sizes.filter((s) => [...merged.values()].some((m) => m.framed[s.id])).map((s) => s.id);
      sets.push({ id, at: new Date().toISOString(), locale, status: f.settings.autonomy.listing === "auto" ? "approved" : "draft", shots: [...merged.values()], sizes: used, uploaded: {}, error: null });
    }
    await d.store.update(app.id, (file) => {
      file.screenshots.push(...sets);
      file.log.push({ at: new Date().toISOString(), text: `Made ${sets.length} screenshot set${sets.length === 1 ? "" : "s"} (${sets.map((s) => s.locale).join(", ")})${cap.notes.length ? ` — ${cap.notes.join("; ")}` : ""}.` });
      return { file, result: null };
    });
    return sets;
  } finally {
    making.delete(app.id);
    await done?.().catch(() => {});
  }
}
