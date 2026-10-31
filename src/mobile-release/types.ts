/**
 * Releasing a React Native / Expo app by itself:
 *
 *  - JavaScript-only changes (the native fingerprint didn't change) ship as
 *    an over-the-air update (EAS Update) to a small share of users first,
 *    then more, then everyone — rolled back when day2's field data shows
 *    more crashes or a check breaking.
 *  - Native changes get a store build (EAS Build), uploaded to TestFlight
 *    and Google Play's internal track (EAS Submit), then released: App Store
 *    review with Apple's 7-day phased release, Google Play's staged rollout —
 *    paused / halted on the same signals.
 *
 * day2 stops only where a person has to decide: store privacy answers that
 * are out of date, release notes when the owner wants to approve them, an
 * App Review rejection, or something only the owner can fix (credentials,
 * a missing app record).
 */

export type Platform = "ios" | "android";
export const PLATFORMS: Platform[] = ["ios", "android"];

export type Change = { sha: string; subject: string; ticketId: string | null };
export type LogLine = { at: string; text: string };

export type UpdateRelease = {
  id: string;
  kind: "update";
  sha: string;
  fromSha: string | null;
  changes: Change[];
  startedAt: string;
  status: "rolling_out" | "done" | "rolled_back" | "failed";
  /** EAS Update group (one update per platform). */
  groupId: string;
  updateIds: Partial<Record<Platform, string>>;
  runtimeVersion: string | null;
  branch: string;
  /** Index into the rollout stages, and its percentage. */
  stage: number;
  percent: number;
  stageAt: string;
  /** What the new update is compared with, per platform (release keys, see field-store releaseHealth). */
  baseline: Partial<Record<Platform, string>>;
  health: Partial<Record<Platform, { state: string; why: string; at: string }>>;
  log: LogLine[];
};

export type StoreStage =
  | "building"
  | "uploading"
  | "processing"
  | "waiting_notes"
  | "waiting_privacy"
  | "in_review"
  | "rejected"
  | "rolling_out"
  | "paused"
  | "released"
  | "failed";

export type StoreRelease = {
  id: string;
  kind: "store";
  sha: string;
  fromSha: string | null;
  changes: Change[];
  startedAt: string;
  status: "in_progress" | "waiting_owner" | "done" | "stopped" | "failed";
  /** The marketing version (app.json "version") of this release. */
  version: string;
  fingerprint: Partial<Record<Platform, string>>;
  builds: Partial<Record<Platform, { id: string; status: string; buildNumber: string | null; error: string | null }>>;
  submissions: Partial<Record<Platform, { id: string; status: string; error: string | null }>>;
  notes: { text: string; approved: boolean; by: string | null; at: string } | null;
  platforms: Partial<
    Record<
      Platform,
      {
        stage: StoreStage;
        stageAt: string;
        /** App Store: version id; Google Play: version code. */
        ref: string | null;
        /** Google Play rollout share, App Store phased day (1–7). */
        fraction: number | null;
        why: string | null;
      }
    >
  >;
  baseline: Partial<Record<Platform, string>>;
  health: Partial<Record<Platform, { state: string; why: string; at: string }>>;
  /** What the owner has to do, when something is waiting on them. */
  waitingFor: string | null;
  log: LogLine[];
};

export type Release = (UpdateRelease | StoreRelease) & { stopRequested?: { by: string | null; at: string } };

export type ReleaseSettings = {
  /** Over-the-air updates: day2 ships them by itself ("auto"), or not at all ("off"). */
  updates: "auto" | "off";
  /** Store builds: day2 builds and uploads them to TestFlight / internal testing ("auto"), or not ("off"). */
  builds: "auto" | "off";
  /** Store release: "auto" = submit and roll out by itself with the notes it wrote; "approve_notes" = the owner approves the release notes first. */
  storeRelease: "auto" | "approve_notes";
  /** EAS Update branch/channel that production builds read. */
  channel: string;
  /** EAS Build / Submit profile. */
  profile: string;
};

export const DEFAULT_SETTINGS: ReleaseSettings = { updates: "auto", builds: "auto", storeRelease: "auto", channel: "production", profile: "production" };

export type Shipped = {
  sha: string;
  at: string;
  /** Native fingerprint of what's in the stores, per platform. */
  fingerprint: Partial<Record<Platform, string>>;
  version: string | null;
  /** Release keys of the store builds users run, and of the latest update. */
  storeKey: Partial<Record<Platform, string>>;
  updateKey: Partial<Record<Platform, string>>;
};

export type ReleasesFile = {
  /** The owner turned on releases by day2 for this app. */
  enabled: boolean;
  enabledBy?: string | null;
  settings: ReleaseSettings;
  shipped: Shipped | null;
  current: Release | null;
  history: Release[];
};
