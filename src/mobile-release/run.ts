import { resolve } from "node:path";
import type { AppEntry } from "../apps-registry";
import { createTicket, rankBacklog, withBacklog, type NewTicketInput } from "../backlog";
import { backlogFile } from "../backlog-work";
import { appKind, existingIntegration } from "../field-work";
import { loadStorePrivacy, practicesFrom, STORE_PRIVACY_FILENAME, storeStatus } from "../store-privacy";
import { fieldStore, releaseCredentials } from "../tenant";
import { createAppStore } from "./app-store";
import { createEas } from "./eas";
import { gitWorkdirs, mainReader } from "./git-workdir";
import { loadReleases, releasePass, RELEASES_FILENAME, saveReleases, type ReleaseReport } from "./pass";
import { readiness, SETUP_KEY, setupTicket } from "./setup";
import { createPlay } from "./play";
import { prepareForRelease } from "../store-listing/release-hook";

/**
 * Releases for one app, on the backlog timer: makes sure the app is set up
 * (one ticket for the code; the owner connects accounts once), then moves
 * the current release on — or starts the next one.
 */

const releasing = new Set<string>();

export async function runReleases(app: AppEntry, log: (text: string) => void = (t) => console.log(`[day2-release] ${app.name}: ${t}`)): Promise<ReleaseReport | null> {
  if (appKind(app.repoPath) !== "react-native") return null;
  const path = resolve(app.repoPath, RELEASES_FILENAME);
  const file = loadReleases(path);
  if (!file.enabled) return null;
  if (releasing.has(app.id)) return null; // one pass at a time per app
  releasing.add(app.id);
  try {
    const creds = releaseCredentials();
    const ticket = async (input: NewTicketInput) =>
      withBacklog(backlogFile(app), (b) => {
        const have = b.tickets.find((t) => t.source.key === input.source.key && t.state !== "parked");
        if (have) return { backlog: b, result: have };
        const now = new Date();
        const r = createTicket(b, input, now);
        return { backlog: rankBacklog(r.backlog, now).backlog, result: r.ticket };
      });

    // Code-side setup first (one ticket); nothing ships until it's merged.
    const ready = readiness(await mainReader(app.repoPath), (await fieldStore().meta(app.id))?.lastRelease ?? null);
    if (ready.code.length) {
      const t = await ticket(setupTicket(ready));
      return { started: null, advanced: null, finished: null, rolledBack: null, waiting: `setup (${t.id})`, skipped: null };
    }
    const expo = await creds.get(app.id, "expo");
    if (!expo) return { started: null, advanced: null, finished: null, rolledBack: null, waiting: "an Expo access token", skipped: null };
    const asc = await creds.get(app.id, "asc");
    const play = await creds.get(app.id, "play");

    const privacyPath = resolve(app.repoPath, STORE_PRIVACY_FILENAME);
    const { file: next, report } = await releasePass(file, {
      now: new Date(),
      health: (keys, since) => fieldStore().releaseHealth(app.id, keys, since),
      eas: createEas(expo.value),
      appStore: asc ? createAppStore(asc.value) : null,
      play: play ? createPlay(play.value) : null,
      git: gitWorkdirs(app.id, app.repoPath),
      privacyDue: async (platform) => {
        const sp = loadStorePrivacy(privacyPath);
        const tickets = (await withBacklog(backlogFile(app), (b) => ({ backlog: b, result: b }))).tickets;
        return storeStatus(sp, practicesFrom(tickets, sp.settings, existingIntegration(app.repoPath))).find((s) => s.store === platform)?.steps ?? [];
      },
      ticket,
      log,
      ...(asc ? { beforeIosSubmit: (o: { appId: string; versionId: string; version: string }) => prepareForRelease(app, asc.value, o, log) } : {}),
    });
    saveReleases(path, next);
    return report;
  } catch (err) {
    log(`release pass failed: ${(err as Error).message}`);
    return null;
  } finally {
    releasing.delete(app.id);
  }
}

export { SETUP_KEY };
