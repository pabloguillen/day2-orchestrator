import type { AppEntry } from "../apps-registry";
import type { LiveConfig } from "../../packages/sensors/src/types";
import type { LiveState } from "./types";
import { messagesContributor } from "../messages/contributor";
import { moneyContributor } from "../money/config";
import { storeContributor } from "../store-listing/live";

/**
 * Config contributors: how other modules put their part into the Live
 * config an app receives, without depending on each other
 * (docs/self-improving-app.md, "Extension points"). Money adds paywall
 * values and `ads`, Messages adds `messages`, Store adds `review` — each
 * with one line in `LIVE_CONTRIBUTORS`.
 *
 * Merge rules (src/live/config.ts): values from every contributor, then
 * Live's own values on top (the owner's settings and promoted winners win);
 * ads by placement id (later wins); messages appended (first id wins);
 * review from the last contributor that gives one.
 *
 * Every app gets the same config (audiences decide on the device), so a
 * contribution must not depend on who asks — only on the app and the time.
 * A contributor that fails is left out of that config (and logged).
 */

export type ContributorContext = {
  now: Date;
  /** Live's own document for the app (read-only). */
  live: LiveState;
};

export type LiveContribution = Partial<Pick<LiveConfig, "values" | "ads" | "messages" | "review">>;

export type LiveContributor = {
  module: string;
  contribute(app: AppEntry, ctx: ContributorContext): Promise<LiveContribution>;
};

/** Live itself: the owner's settings and promoted winners. */
export const liveSelf: LiveContributor = {
  module: "live",
  async contribute(_app, ctx) {
    return { values: Object.fromEntries(Object.entries(ctx.live.values).map(([k, v]) => [k, v.value])) };
  },
};

export const LIVE_CONTRIBUTORS: LiveContributor[] = [
  liveSelf,
  messagesContributor(),
  moneyContributor,
  storeContributor,
  // Other modules add one line here, e.g. moneyContributor, messagesContributor, storeReviewContributor.
];
