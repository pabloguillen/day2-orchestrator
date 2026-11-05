import type { AppEntry } from "../apps-registry";
import type { AscCredential } from "../mobile-release/credentials";
import { decryptSecret } from "../secrets";
import { createAscListing } from "./asc";
import { demoContext, screenshotFiles } from "./deps";
import { prepareVersion } from "./service";
import { applyVersionSetup, recordResults } from "./setup";
import { createAscSetup } from "./setup-asc";
import { setupFilePath } from "./setup-assets";
import { storeListingFor } from "./store";

/**
 * Called by the release flow (mobile-release/run.ts → pass.ts →
 * app-store.ts submitForReview) right before an App Store version goes to
 * review: approved name, subtitle, keywords, description and screenshots
 * that were waiting for a version go into this one — and so do the
 * approved store setup facts that live on a version (support and marketing
 * links, copyright, App Review information with the demo account) and
 * approved app previews. Submitting stays the release flow's decision.
 */
export async function prepareForRelease(app: AppEntry, cred: AscCredential, o: { appId: string; versionId: string; version: string }, log: (t: string) => void): Promise<void> {
  const store = storeListingFor(app);
  const listing = createAscListing(cred);
  const done = await prepareVersion({ store, appId: app.id, now: new Date(), screenshotFiles: screenshotFiles(app.id) }, listing, o.appId, o.versionId, o.version);
  if (done.length) log(`${done.length} approved store listing change${done.length === 1 ? "" : "s"} go out with ${o.version}.`);
  const f = await store.load(app.id);
  const r = await applyVersionSetup({ listing, setup: createAscSetup(cred) }, f.setup, {
    versionId: o.versionId,
    demo: (secret) => JSON.parse(decryptSecret(secret, demoContext(app.id))) as { username: string; password: string },
    previewFile: (g) => setupFilePath(app.id, g.file),
  });
  const wrote: string[] = [];
  await store.update(app.id, (file) => {
    const report = { proposed: [], wrote, graphics: [], problems: [] as string[] };
    recordResults(file, r.facts, r.previews, new Date(), report);
    if (wrote.length) file.log.push({ at: new Date().toISOString(), text: `Store setup: wrote ${wrote.join(", ")} into App Store version ${o.version}.` });
    return { file, result: null };
  });
  if (wrote.length) log(`Store setup: ${wrote.join(", ")} go out with ${o.version}.`);
}
