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
import { releaseCredentials, type Tenant } from "../tenant";
import { createAscListing } from "./asc";
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
  return deps;
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
