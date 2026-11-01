/**
 * Device checks: before a pull request is opened, day2 runs the changed app
 * on virtual devices — the iPhone Simulator and the Android emulator on the
 * owner's Mac (local mode), or EAS's simulators/emulators in the cloud —
 * walks the Maestro flows (the app's own plus the one day2 wrote for the
 * change), and keeps a screenshot of every step, before and after. A crash,
 * a failed flow or an app that doesn't start blocks the pull request.
 */

export type DevicePlatform = "ios" | "android";

export type Shot = { name: string; before: string | null; after: string | null };

export type PlatformRun = {
  platform: DevicePlatform;
  device: string;
  /** "passed": everything ran; "failed": a crash, a failed flow or no start; "skipped": couldn't run here (why). */
  status: "passed" | "failed" | "skipped";
  why: string | null;
  failures: string[];
  /** Ran Maestro flows (true) or only launched the app and watched it (false). */
  flows: boolean;
  shots: Shot[];
  seconds: number;
};

export type DeviceReport = {
  key: string;
  at: string;
  mode: "local" | "eas";
  status: "passed" | "failed" | "skipped";
  summary: string;
  runs: PlatformRun[];
  /** EAS: where to see the run. */
  link?: string | null;
  notes: string[];
};

/** What the pipeline needs back. */
export type DeviceVerdict = { status: "passed" | "failed" | "skipped"; summary: string; key: string | null };
