import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import type { NewTicketInput } from "../backlog";
import { indexRepo } from "../distribution-loops";
import { appKind } from "../field-work";
import type { LiveContributor } from "../live/contributors";
import { registerNativeNeed } from "../live/native-foundations";
import { storeListingFor } from "./store";

/**
 * Store's part of the app: when to ask for a rating. The rule lives in the
 * Live config (`review`, from the Store page's settings), the library
 * answers `day2.shouldAskForReview()`, and the app calls expo-store-review's
 * requestReview() at that moment — so the timing changes without a release.
 */

export const REVIEW_PROMPT_KEY = "store:review-prompt";
const STORE_REVIEW_PKG = "expo-store-review";

const hasPackage = (repoPath: string, pkg: string) => {
  try {
    return readFileSync(join(repoPath, "package.json"), "utf-8").includes(`"${pkg}"`);
  } catch {
    return false;
  }
};

registerNativeNeed({
  module: "store",
  packages: [STORE_REVIEW_PKG],
  instructions: "expo-store-review shows the system's rating prompt (Apple's SKStoreReviewController, Google's in-app review). Nothing else is needed natively.",
  async whenNeeded(app) {
    return appKind(app.repoPath) === "react-native" && !hasPackage(app.repoPath, STORE_REVIEW_PKG);
  },
});

/** The same for every user of the app (it depends only on the Store settings). */
export const storeContributor: LiveContributor = {
  module: "store",
  async contribute(app) {
    if (appKind(app.repoPath) !== "react-native") return {};
    const f = await storeListingFor(app).load(app.id);
    return { review: f.settings.reviewPrompt };
  },
};

/** Whether the app's code already asks for ratings through day2. */
export function asksThroughDay2(repoPath: string): boolean {
  if (!existsSync(repoPath)) return false;
  const repo = indexRepo(repoPath);
  return repo.files.some((f) => /\.(tsx?|jsx?)$/.test(f) && !/(\.test\.|\.spec\.)/.test(f) && /shouldAskForReview\s*\(/.test(repo.read(f)));
}

/** The ticket that wires the rating prompt into the app once expo-store-review is in. */
export function reviewPromptTicket(app: AppEntry): NewTicketInput {
  return {
    title: "Ask for a rating at the right moment (day2 decides when)",
    type: "task",
    description: [
      `${app.name} should ask happy users for a rating — at a good moment, rarely, and never right after something went wrong. day2 decides when (the rule is in the Live config, changed on the Store page without a release); the app only asks.`,
      "",
      "1. Where a user just got value (after the moments the Store page lists, e.g. after finishing something), call `day2.shouldAskForReview()` from `@day2/sensors/native`. When it returns true, call `StoreReview.requestReview()` from expo-store-review (check `StoreReview.hasAction()` first).",
      "2. Send the event `review_prompt` with `day2.track` right after asking (no other data).",
      "3. Never show your own \"Do you like the app?\" dialog before it, never offer anything for a rating (both are against Apple's and Google's rules).",
    ].join("\n"),
    doneWhen: ["The app asks through day2.shouldAskForReview() and expo-store-review", "A review_prompt event is sent when it asks", "The app builds and its tests pass"],
    priority: 3,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: REVIEW_PROMPT_KEY },
    actor: "day2",
    createdNote: "From the Store module (ratings and reviews).",
  };
}

export const reviewPromptReady = (repoPath: string) => hasPackage(repoPath, STORE_REVIEW_PKG);
