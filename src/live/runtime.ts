import { resolve } from "node:path";
import type { AppEntry } from "../apps-registry";
import { dbApps } from "../apps-store";
import { db } from "../db";
import { localTenant, serverMode } from "../tenant";
import { serveConfig } from "./config";
import { dbLiveStore, fileLiveStore, type LiveStore } from "./store";
import { LIVE_FILENAME } from "./types";
import type { LiveConfig } from "../../packages/sensors/src/types";

/** Live's stores for how day2 runs: the app's `day2-live.json` locally, Postgres with accounts. */
export function liveStore(): LiveStore {
  if (serverMode() === "accounts") return dbLiveStore(db());
  return fileLiveStore(async (appId) => {
    const app = await localTenant().apps.find(appId);
    return app ? liveFile(app) : null;
  });
}

export const liveFile = (app: AppEntry) => resolve(app.repoPath, LIVE_FILENAME);

async function appFor(owner: { appId: string; accountId: string }): Promise<AppEntry | null> {
  if (serverMode() === "accounts") return (await dbApps(db(), owner.accountId).find(owner.appId)) ?? null;
  return (await localTenant().apps.find(owner.appId)) ?? null;
}

/** For handleIngest: the config an app gets. */
export function liveConfigFor(owner: { appId: string; accountId: string }): Promise<LiveConfig> {
  return serveConfig(owner.appId, { store: liveStore(), app: () => appFor(owner) });
}
