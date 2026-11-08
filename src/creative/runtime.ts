import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AssetStore } from "../ads/assets";
import { hasStores, storeScreenshots, type AppLinks } from "../ads/app-links";
import type { AppEntry } from "../apps-registry";
import type { AppProfile } from "../onboarding";
import { storeListingFor } from "../store-listing/store";
import { ensureBrandKit } from "./brand-kit";
import { appVersion, chooseScreens, imageSize, loadCaptureSet, localeFor, storeRawFor, type ScreenChoice } from "./capture";
import { runStudio, type StudioOut } from "./studio";
import { loadCreativeState, updateCreativeState } from "./taste";
import type { BrollAsset, TemplateId } from "./templates/types";
import { runVision } from "./vision";
import type { SocialIdea } from "../social/make";
import { loadUploadSet } from "./upload";
import { currentTenant } from "../tenant";

/**
 * Wiring the studio to day2's real stores: the brand kit from the app's
 * repo, the screens (fresh captures → store pipeline captures for the
 * locale → App Store screenshots with a warning), the owner's clips, the
 * owner's taste, the latest release notes. Used by the social pass and the
 * "Make a How it works post" button.
 */

export const BROLL_PURPOSE = "broll";

/** The screens a post uses, by the fallback order (capture.ts). */
export async function screensFor(app: Pick<AppEntry, "id" | "repoPath">, language: string, o: { links: AppLinks | null; webShots?: () => Promise<string[]> }): Promise<ScreenChoice> {
  const locale = localeFor(language);
  const capture = loadCaptureSet(app.id, locale);
  const upload = loadUploadSet(app.id, locale);
  const sets = await storeListingFor(app as AppEntry).load(app.id).then((f) => f.screenshots).catch(() => []);
  const storeLocale = storeRawFor(sets, language);
  const store = o.links && hasStores(o.links) && !capture && !upload && !storeLocale.length ? await storeScreenshots(o.links, join(tmpdir(), `day2-studio-shots-${app.id}`)).catch(() => [] as string[]) : [];
  // App Store screenshots come from Apple's US/DE/GB lookup: their language isn't known; most first apps ship English ones.
  const storeLang = store.length ? (o.links?.ios ? "en" : null) : null;
  const web = !capture && !upload && !storeLocale.length && !store.length && o.webShots ? await o.webShots().catch(() => []) : [];
  return chooseScreens({ language, capture, upload, version: appVersion(app.repoPath), storeLocale, store: store.map((f) => ({ file: f, language: storeLang })), web, dims: imageSize });
}

/** The owner's own clips and photos (Creative library), newest first. */
export async function brollFor(appId: string, assets: AssetStore): Promise<BrollAsset[]> {
  const list = await assets.list(appId, BROLL_PURPOSE).catch(() => []);
  return list.filter((a) => existsSync(a.path)).slice(0, 8).map((a) => ({ file: a.path, kind: a.kind, durationSec: a.durationSec, label: a.label }));
}

/** The latest release's notes in the audience's language (App Store "What's New"), for What's new posts. */
export async function releaseFor(app: AppEntry, language: string): Promise<{ version: string; notes: string[]; at: string; posted: boolean } | null> {
  const version = appVersion(app.repoPath);
  if (!version) return null;
  const f = await storeListingFor(app).load(app.id).catch(() => null);
  const ios = f?.listings.ios ?? {};
  const loc = Object.keys(ios).find((l) => l.split("-")[0] === language);
  const text = loc ? ios[loc]?.whatsNew : null;
  if (!text?.trim()) return null;
  const notes = text.split(/\n+|•|·|- /).map((x) => x.trim()).filter((x) => x.length > 3).slice(0, 4);
  return { version, notes, at: f?.listings.readAt ?? new Date(0).toISOString(), posted: loadCreativeState(app.repoPath).whatsNewVersion === version };
}

export type StudioCall = (o: { idea: SocialIdea; forced: TemplateId | null; variants: 1 | 2; want: { video: boolean; carousel: boolean }; tag: string }) => Promise<StudioOut>;

/** The studio for an app's social posts (DraftDeps.studio). */
export function socialStudio(app: AppEntry, profile: AppProfile, o: { language: string; assets: AssetStore; links: AppLinks | null; posts: number; music?: () => Promise<string | null>; log?: (t: string) => void }): StudioCall {
  return async ({ idea, forced, variants, want, tag }) => {
    const kit = ensureBrandKit(app.repoPath);
    // Real screens first: the real-screens pipeline (cast → seed plan → flow → capture with a temporary database) is kicked;
    // before the first How it works post it waits for it (bounded) — otherwise posts use the best screens there are.
    const tenant = currentTenant();
    if (tenant && process.env.DAY2_CAPTURE !== "off") {
      const { maybeAutoCapture } = await import("./real-screens");
      const firstHow = !loadCreativeState(app.repoPath).howItWorksAt && (forced === "how-it-works" || o.posts < 3);
      const r = await maybeAutoCapture(tenant, app, { making: firstHow ? "how-it-works" : null, wait: firstHow, log: o.log }).catch(() => null);
      if (r) o.log?.(r === "new_version" ? "New app version: capturing its screens again for the next posts." : "Captured real screens for the first How it works post.");
    }
    const state = loadCreativeState(app.repoPath);
    const out = await runStudio({
      appId: app.id,
      appName: app.name,
      repoPath: app.repoPath,
      purpose: profile.purpose,
      features: profile.featureMap,
      language: o.language,
      idea: { title: idea.title, lines: idea.lines, topic: idea.topic, hook: idea.hook, cta: idea.cta },
      kit,
      dna: profile.brand ?? null,
      screens: await screensFor(app, o.language, { links: o.links }),
      broll: await brollFor(app.id, o.assets),
      state,
      posts: o.posts,
      release: await releaseFor(app, o.language),
      forced,
      variants,
      want,
      vision: process.env.DAY2_CREATIVE_VISION === "off" ? null : runVision,
      music: want.video && o.music ? await o.music().catch(() => null) : null,
      store: o.assets,
      tag,
      log: o.log,
    });
    if (out.variants.some((v) => v.template === "how-it-works") || out.variants.some((v) => v.template === "whats-new"))
      updateCreativeState(app.repoPath, (s) => ({ ...s, howItWorksAt: out.variants.some((v) => v.template === "how-it-works") ? (s.howItWorksAt ?? new Date().toISOString()) : s.howItWorksAt, whatsNewVersion: out.variants.some((v) => v.template === "whats-new") ? appVersion(app.repoPath) : s.whatsNewVersion }));
    return out;
  };
}
