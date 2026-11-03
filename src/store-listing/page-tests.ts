import type { WalkStep } from "../store-walkthrough";
import type { AscListingClient } from "./asc";
import type { CustomPage, StoreFile, StoreTest } from "./types";

/**
 * Store tests and custom pages:
 *
 *  - Apple product page optimization: an experiment on the App Store page
 *    (up to 3 variants of screenshots against the current page, a share of
 *    visitors), created and started through the App Store Connect API.
 *    Apple shows the results only in App Store Connect, so the owner enters
 *    the winner here.
 *  - Custom product pages: their own App Store page (promotional text,
 *    screenshots) with an address carrying ?ppid=…, so an ad campaign can
 *    lead to a page made for its angle.
 *  - Google Play store listing experiments have no API: a "Do it with me"
 *    walkthrough in the Play Console, and the owner enters the result.
 */

export const MAX_TREATMENTS = 3;

/** Pure. A new test, waiting for approval (or approved when day2 decides). */
export function addTest(file: StoreFile, t: Pick<StoreTest, "kind" | "name" | "hypothesis" | "locale" | "trafficPercent"> & { treatments: Array<{ name: string; screenshotSetId: string | null; note: string }> }, o: { now: Date; auto: boolean }): { file: StoreFile; test: StoreTest } {
  if (!t.treatments.length) throw new Error("A test needs at least one variant.");
  if (t.kind === "apple_ppo" && t.treatments.some((x) => !x.screenshotSetId)) throw new Error("Each App Store variant needs its screenshots (Apple tests screenshots and icons, not texts).");
  if (!(t.trafficPercent >= 10 && t.trafficPercent <= 100)) throw new Error("Send between 10% and 100% of visitors into the test.");
  const f = structuredClone(file);
  const n = f.tests.length + 1;
  const test: StoreTest = {
    id: `ST-${n}`,
    kind: t.kind,
    name: t.name.trim().slice(0, 60) || `Store test ${n}`,
    hypothesis: t.hypothesis.trim().slice(0, 300),
    locale: t.locale,
    treatments: t.treatments.slice(0, MAX_TREATMENTS).map((x) => ({ ...x, ascId: null })),
    trafficPercent: Math.round(t.trafficPercent),
    // "draft": ready — day2 creates and starts an Apple test in its next pass; a Play test is the owner's walkthrough.
    status: t.kind === "play_experiment" || o.auto ? "draft" : "waiting_approval",
    ascId: null,
    createdAt: o.now.toISOString(),
    startedAt: null,
    endedAt: null,
    result: null,
    error: null,
  };
  f.tests.push(test);
  return { file: f, test };
}

/**
 * Creates and starts an Apple experiment: the experiment, one treatment per
 * variant with its localization, the variant's screenshots on it, then
 * "started". Apple reviews treatments with new screenshots before they run.
 */
export async function startAppleTest(asc: AscListingClient, appId: string, t: StoreTest, screenshots: (setId: string) => Array<{ displayType: string; files: string[] }>): Promise<StoreTest> {
  const out = structuredClone(t);
  out.ascId ??= await asc.createExperiment({ appId, name: t.name, trafficProportion: t.trafficPercent });
  for (const tr of out.treatments) {
    if (tr.ascId) continue;
    const { treatmentId, localizationId } = await asc.createTreatment({ experimentId: out.ascId, name: tr.name, locale: t.locale });
    for (const s of tr.screenshotSetId ? screenshots(tr.screenshotSetId) : []) await asc.replaceScreenshots({ kind: "appStoreVersionExperimentTreatmentLocalizations", id: localizationId }, s.displayType, s.files);
    tr.ascId = treatmentId;
  }
  await asc.startExperiment(out.ascId);
  out.status = "submitted";
  out.startedAt = new Date().toISOString();
  return out;
}

/** Pure. Apple's experiment state in day2's words. */
export function mapExperimentState(state: string): StoreTest["status"] {
  if (["ACCEPTED", "IN_REVIEW", "WAITING_FOR_REVIEW", "READY_FOR_REVIEW"].includes(state)) return "submitted";
  if (state === "RUNNING") return "running";
  if (state === "COMPLETED") return "finished";
  if (state === "STOPPED") return "stopped";
  if (["REJECTED", "INVALID"].includes(state)) return "failed";
  return "submitted";
}

/** Pure. The owner enters the winner (Apple and Play show results only in their consoles). */
export function recordResult(file: StoreFile, id: string, r: { winner: string; note: string; by: string | null; now: Date }): StoreFile {
  const f = structuredClone(file);
  const t = f.tests.find((x) => x.id === id);
  if (!t) throw new Error(`There's no test ${id}.`);
  const names = ["current", ...t.treatments.map((x) => x.name)];
  if (!names.includes(r.winner)) throw new Error(`The winner is one of: ${names.join(", ")}.`);
  t.result = { winner: r.winner, note: r.note.trim().slice(0, 500), by: r.by, at: r.now.toISOString() };
  t.status = "finished";
  t.endedAt ??= r.now.toISOString();
  return f;
}

/** Google Play store listing experiment, step by step in the Play Console (no API exists). */
export function playExperimentWalkthrough(t: StoreTest, o: { appName: string }): WalkStep[] {
  return [
    {
      title: "Open store listing experiments",
      detail: `Sign in to the Play Console and open ${o.appName}. In the left menu: Grow users → Store presence → Store listing experiments. Click "Create experiment".`,
      link: { label: "Open the Play Console", url: "https://play.google.com/console" },
    },
    {
      title: "Name and audience",
      detail: `Name: ${t.name}. Store listing: your main listing. Experiment type: localized — language ${t.locale}. Click Next.`,
    },
    {
      title: "Goals",
      detail: `Target metric: retained first-time installers. Variants: ${t.treatments.length}. Experiment audience: ${t.trafficPercent}% of store visitors (split evenly between your current listing and the variants). Leave the rest as Google suggests and click Next.`,
    },
    ...t.treatments.map((tr, i) => ({
      title: `Variant ${i + 1}: ${tr.name}`,
      detail: `${tr.note || "Change what this variant tests."}${tr.screenshotSetId ? `\n\nUpload the phone screenshots of "${tr.name}" (download them from day2's Store page → Tests).` : ""}\n\nChange only this — everything else stays like the current listing.`,
    })),
    {
      title: "Start it",
      detail: "Click Save, then Start experiment. Google needs about a week of visitors before it shows a result. Come back here and enter which version won.",
    },
  ];
}

/** Pure. A custom product page for an ad campaign or experiment. */
export function addCustomPage(file: StoreFile, p: { name: string; purpose: string; locale: string; promotionalText: string; screenshotSetId: string | null; campaigns: string[] }, o: { now: Date; auto: boolean }): { file: StoreFile; page: CustomPage } {
  if (p.promotionalText.length > 170) throw new Error("Promotional text is at most 170 characters.");
  const f = structuredClone(file);
  const page: CustomPage = {
    id: `CP-${f.customPages.length + 1}`,
    name: p.name.trim().slice(0, 60) || `Page ${f.customPages.length + 1}`,
    purpose: p.purpose.trim().slice(0, 200),
    locale: p.locale,
    promotionalText: p.promotionalText.trim(),
    screenshotSetId: p.screenshotSetId,
    ascId: null,
    ascVersionId: null,
    url: null,
    ppid: null,
    status: o.auto ? "draft" : "waiting_approval",
    campaigns: [...new Set(p.campaigns.map((c) => c.trim()).filter((c) => /^[\w.-]{1,40}$/.test(c)))],
    createdAt: o.now.toISOString(),
    error: null,
  };
  f.customPages.push(page);
  return { file: f, page };
}

/** Pure. ?ppid= from a custom product page's address. */
export const ppidOf = (url: string | null) => (url ? (new URL(url).searchParams.get("ppid") ?? null) : null);

/**
 * Pure. The custom product page an ad's tag leads to: by the whole tag
 * ("B-4.tiktok.v1") or its campaign/experiment part ("B-4"), live pages only.
 */
export function customPageFor(pages: CustomPage[], tag: string): CustomPage | null {
  const base = tag.split(".")[0] ?? tag;
  return pages.find((p) => p.status === "live" && p.ppid && (p.campaigns.includes(tag) || p.campaigns.includes(base))) ?? null;
}

/** Pure. Apple's custom product page version state in day2's words. */
export function mapPageState(state: string): CustomPage["status"] {
  if (state === "ACCEPTED" || state === "APPROVED" || state === "READY_FOR_DISTRIBUTION") return "live";
  if (state === "REJECTED") return "failed";
  if (state === "PREPARE_FOR_SUBMISSION") return "waiting_approval";
  return "submitted";
}
