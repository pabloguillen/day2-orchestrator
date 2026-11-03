import type { AppEntry } from "../apps-registry";
import { CreditsError } from "../credits";
import { appKind } from "../field-work";
import { asksThroughDay2, reviewPromptReady, reviewPromptTicket } from "./live";
import { appLocales } from "./listing";
import { flowTicket, hasFlow } from "./screenshots";
import { advanceTests, applyApproved, readListings, reviewsDue, reviewsPass, runResearch, uploadApprovedScreens, type StoreDeps } from "./service";
import type { StoreFile } from "./types";

/**
 * The Store pass (growth autopilot, on the backlog timer). Cheap when
 * nothing changed; each step is skipped when it isn't due:
 *
 *  - listings read from the stores once a day;
 *  - reviews every 6 hours: drafts, sends what's allowed, problems → backlog;
 *  - research every 30 days, or when a new version reached the store;
 *  - approved changes go out (promotional text now, other App Store texts
 *    with the next version, Google Play in one edit);
 *  - Apple tests and custom product pages move along;
 *  - one-time tickets: the screenshot flow, the rating prompt.
 */

export type StorePassDeps = StoreDeps & {
  /** The store version users have now (mobile releases), to research again after a release. */
  shippedVersion(): Promise<string | null>;
  /** Starts making screenshots in the background (builds the app; slow). Absent = not on this server. */
  startScreenshots?: () => void;
};

export type StorePassReport = { listingsRead: boolean; researched: boolean; reviews: { added: number; drafted: number; sent: number; tickets: number } | null; applied: string[]; staged: string[]; tests: string[]; tickets: string[]; skipped: string[] };

const LISTINGS_EVERY_MS = 24 * 3_600_000;

/** Pure. Whether research is due: never ran, the schedule says so, or a new version is in the store. */
export function researchDue(f: StoreFile, now: Date, shipped: string | null): "schedule" | "release" | null {
  const last = f.research[0];
  if (!last) return "schedule";
  if (shipped && f.researchedVersion && shipped !== f.researchedVersion) return "release";
  return now.getTime() - Date.parse(last.at) >= f.settings.researchEveryDays * 86_400_000 ? "schedule" : null;
}

export async function storePass(app: AppEntry, d: StorePassDeps): Promise<StorePassReport> {
  const report: StorePassReport = { listingsRead: false, researched: false, reviews: null, applied: [], staged: [], tests: [], tickets: [], skipped: [] };
  if (appKind(app.repoPath) !== "react-native") return report;
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      const why = err instanceof CreditsError ? err.message : (err as Error).message;
      report.skipped.push(`${name}: ${why}`);
    }
  };

  let f = await d.store.load(d.appId);
  // First time: work in the app's own languages.
  if (!f.listings.readAt && f.settings.locales.join() === "en-US") {
    const locales = appLocales(app.repoPath);
    f = await d.store.update(d.appId, (x) => {
      x.settings.locales = locales;
      return { file: x, result: x };
    });
  }

  if (!f.listings.readAt || d.now.getTime() - Date.parse(f.listings.readAt) >= LISTINGS_EVERY_MS)
    await step("listing", async () => {
      f = await readListings(d);
      report.listingsRead = true;
    });

  if (reviewsDue(f, d.now))
    await step("reviews", async () => {
      const r = await reviewsPass(d);
      report.reviews = { added: r.added, drafted: r.drafted, sent: r.sent, tickets: r.tickets };
      report.skipped.push(...r.skipped);
    });

  const shipped = await d.shippedVersion().catch(() => null);
  const due = researchDue(await d.store.load(d.appId), d.now, shipped);
  if (due)
    await step("research", async () => {
      const r = await runResearch(d, due, shipped);
      if (r.skipped) report.skipped.push(`research: ${r.skipped}`);
      else report.researched = true;
    });

  await step("apply", async () => {
    const r = await applyApproved(d);
    report.applied.push(...r.applied);
    report.staged.push(...r.staged);
    report.applied.push(...(await uploadApprovedScreens(d)));
  });

  await step("tests", async () => {
    report.tests.push(...(await advanceTests(d)));
  });

  await step("tickets", async () => {
    if (d.profile && !hasFlow(app.repoPath)) {
      const t = await d.ticket(flowTicket(app, d.profile, (await d.store.load(d.appId)).settings.locales));
      if (t.created) report.tickets.push(t.id);
    } else if (hasFlow(app.repoPath) && !(await d.store.load(d.appId)).screenshots.length) d.startScreenshots?.();
    if (reviewPromptReady(app.repoPath) && !asksThroughDay2(app.repoPath)) {
      const t = await d.ticket(reviewPromptTicket(app));
      if (t.created) report.tickets.push(t.id);
    }
  });
  return report;
}
