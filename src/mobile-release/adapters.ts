import type { Platform } from "./types";

/**
 * What the release pass needs from Expo (EAS), App Store Connect and Google
 * Play. Implemented in eas.ts, app-store.ts and play.ts; faked in tests.
 */

export type AppConfig = {
  version: string;
  bundleId: string | null;
  packageName: string | null;
  /** runtimeVersion policy from the app config ("fingerprint", "appVersion", …, or "custom" for a fixed string). */
  runtimePolicy: string | null;
  hasUpdates: boolean;
};

export type Eas = {
  /** The app's resolved config (expo config) in a checkout. */
  appConfig(workdir: string): Promise<AppConfig>;
  /** The newest finished store build per platform for a profile: what's (about to be) in the stores. */
  latestStoreBuild(workdir: string, o: { platform: Platform; profile: string }): Promise<{ id: string; runtimeVersion: string | null; appVersion: string | null; buildNumber: string | null; gitCommit: string | null } | null>;
  /** Native fingerprint of a checkout, per platform (what decides update vs. store build). */
  fingerprint(workdir: string, platform: Platform): Promise<string>;
  /** The runtime version a checkout's updates would carry, per platform. */
  runtimeVersion(workdir: string, platform: Platform): Promise<string | null>;
  /** Publishes an over-the-air update to a share of the channel's users. */
  publishUpdate(
    workdir: string,
    o: { branch: string; message: string; percent: number },
  ): Promise<{ groupId: string; updateIds: Partial<Record<Platform, string>>; runtimeVersion: string | null }>;
  /** Raises (or finishes, at 100) an update's rollout. */
  setRollout(workdir: string, o: { branch: string; groupId: string; percent: number }): Promise<void>;
  /** Takes an update back: everyone returns to what they ran before it. */
  revert(workdir: string, o: { branch: string; groupId: string }): Promise<void>;
  /** Starts store builds (EAS Build), not waiting for them. */
  build(workdir: string, o: { platform: Platform; profile: string; message: string }): Promise<{ id: string }>;
  build_status(id: string): Promise<{ status: "queued" | "in_progress" | "finished" | "errored" | "canceled"; buildNumber: string | null; appVersion: string | null; error: string | null }>;
  /** Uploads a finished build: TestFlight / App Store Connect, or Google Play's internal track. */
  submit(workdir: string, o: { platform: Platform; buildId: string; profile: string }): Promise<{ id: string }>;
  submit_status(id: string): Promise<{ status: "in_queue" | "in_progress" | "finished" | "errored" | "canceled"; error: string | null }>;
};

export type IosState =
  | "processing"
  | "ready_for_submit"
  | "waiting_for_review"
  | "in_review"
  | "pending_release"
  | "ready_for_sale"
  | "rejected"
  | "developer_rejected"
  | "other";

export type AppStore = {
  /** The app record and its newest build for a version/build number (null while App Store Connect still processes it). */
  findBuild(o: { bundleId: string; version: string; buildNumber: string }): Promise<{ appId: string; buildId: string; processing: "processing" | "valid" | "failed"; missingCompliance: boolean } | null>;
  /** Export compliance for a build: the app uses no encryption beyond what's exempt (HTTPS etc.). */
  setNoNonExemptEncryption(buildId: string): Promise<void>;
  /**
   * Prepares the App Store version (creates it or reuses an editable one),
   * attaches the build, sets "What's New" for every locale, turns on phased
   * release, and submits it for review. `prepare` runs right before the
   * submission (the Store module writes staged listing changes into the version).
   */
  submitForReview(o: { appId: string; version: string; buildId: string; notes: string; phased: boolean; prepare?: (versionId: string) => Promise<void> }): Promise<{ versionId: string }>;
  versionState(versionId: string): Promise<{ state: IosState; phased: { state: "inactive" | "active" | "paused" | "complete"; day: number | null } | null }>;
  /** An approved version waiting for a manual release goes live (phased release starts). */
  release(versionId: string): Promise<void>;
  pausePhased(versionId: string): Promise<void>;
  resumePhased(versionId: string): Promise<void>;
};

export type PlayLifecycle = "draft" | "not_sent" | "in_review" | "approved_not_published" | "rejected" | "published" | "unknown";

export type Play = {
  /** Moves a version code from the internal track to production at a share of users, with release notes. */
  promote(o: { packageName: string; versionCode: string; fraction: number; notes: string; name: string }): Promise<void>;
  setFraction(o: { packageName: string; versionCode: string; fraction: number }): Promise<void>;
  halt(o: { packageName: string; versionCode: string }): Promise<void>;
  complete(o: { packageName: string; versionCode: string }): Promise<void>;
  status(o: { packageName: string; versionCode: string }): Promise<{ lifecycle: PlayLifecycle; status: "inProgress" | "halted" | "completed" | "draft" | null; fraction: number | null }>;
};
