import { join } from "node:path";
import { dataDir } from "../day2-paths";
import { db } from "../db";
import { serverMode } from "../tenant";
import { dbMessagesStore, fileMessagesStore, type MessagesStore } from "./store";
import type { PushTokenRecord } from "../field-ingest";
import { cleanPushInput, dbPushTokens, filePushTokens, type PushTokenStore } from "./tokens";

/**
 * The stores for the mode day2 runs in: Postgres in accounts mode, files
 * under the data directory locally (`<data>/messages/<app>/`, never in the
 * app's repo — tokens are personal data).
 */

export function pushTokens(): PushTokenStore {
  return serverMode() === "accounts" ? dbPushTokens(db()) : filePushTokens(join(dataDir(), "messages"));
}

export function messagesStore(): MessagesStore {
  return serverMode() === "accounts" ? dbMessagesStore(db()) : fileMessagesStore(join(dataDir(), "messages"));
}

/**
 * `IngestDeps.pushTokens` (field-ingest.ts, the `push` sub-route, POST
 * /api/ingest/:key/push — also replayed by the inbox Worker after day2 was
 * away, with the original `at`). Re-shaped strictly again here; anything
 * that isn't a valid Expo token for a hashed user is dropped.
 */
export function pushTokenSaver(store: () => PushTokenStore) {
  return {
    async save(appId: string, t: PushTokenRecord): Promise<void> {
      const input = cleanPushInput(t);
      if (!input) return;
      const at = new Date(t.at);
      await store().save(appId, input, Number.isNaN(at.getTime()) ? new Date() : at);
    },
  };
}

export const ingestPushTokens = pushTokenSaver(pushTokens);
