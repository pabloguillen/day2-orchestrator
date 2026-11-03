import type { AppEntry } from "../apps-registry";
import type { AscCredential } from "../mobile-release/credentials";
import { createAscListing } from "./asc";
import { screenshotFiles } from "./deps";
import { prepareVersion } from "./service";
import { storeListingFor } from "./store";

/**
 * Called by the release flow (mobile-release/run.ts → pass.ts →
 * app-store.ts submitForReview) right before an App Store version goes to
 * review: approved name, subtitle, keywords, description and screenshots
 * that were waiting for a version go into this one.
 */
export async function prepareForRelease(app: AppEntry, cred: AscCredential, o: { appId: string; versionId: string; version: string }, log: (t: string) => void): Promise<void> {
  const done = await prepareVersion({ store: storeListingFor(app), appId: app.id, now: new Date(), screenshotFiles: screenshotFiles(app.id) }, createAscListing(cred), o.appId, o.versionId, o.version);
  if (done.length) log(`${done.length} approved store listing change${done.length === 1 ? "" : "s"} go out with ${o.version}.`);
}
