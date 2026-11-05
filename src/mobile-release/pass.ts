import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { NewTicketInput } from "../backlog";
import type { ReleaseHealth } from "../field-store";
import type { AppStore, AppConfig, Eas, Play } from "./adapters";
import { verdict } from "./health";
import { DEFAULT_SETTINGS, PLATFORMS, type Change, type Platform, type Release, type ReleasesFile, type Shipped, type StoreRelease, type UpdateRelease } from "./types";

/**
 * One release pass for a React Native / Expo app (called on the backlog
 * timer). At most one release is in flight; each pass moves it one step:
 *
 *   new commits on main, quiet for a while
 *     → JS-only (same runtime as the store build)?  update: 10% → 50% → 100%
 *     → native changes?                              store build → TestFlight /
 *                                                    internal → review →
 *                                                    phased / staged rollout
 *   each step judged with day2's own field data; worse → rolled back /
 *   paused / halted, and a bug ticket with what broke.
 */

export const RELEASES_FILENAME = "day2-mobile-releases.json";
export const QUIET_MINUTES = 20;
export const UPDATE_STAGES = [10, 50, 100];
/** Minutes a stage must run before going on (enough launches are needed too). */
export const UPDATE_STAGE_MINUTES = [120, 240, 0];
export const ANDROID_STAGES = [0.05, 0.2, 0.5, 1];
export const ANDROID_STAGE_MINUTES = 24 * 60;
/** A quiet app (few launches): after this long without a regression, go on anyway. */
const QUIET_APP_MINUTES = 72 * 60;

export function loadReleases(path: string): ReleasesFile {
  const empty: ReleasesFile = { enabled: false, settings: { ...DEFAULT_SETTINGS }, shipped: null, current: null, history: [] };
  if (!existsSync(path)) return empty;
  try {
    const p = JSON.parse(readFileSync(path, "utf-8")) as Partial<ReleasesFile>;
    return { enabled: p.enabled === true, enabledBy: p.enabledBy ?? null, settings: { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) }, shipped: p.shipped ?? null, current: p.current ?? null, history: Array.isArray(p.history) ? p.history : [] };
  } catch {
    return empty;
  }
}

export function saveReleases(path: string, f: ReleasesFile): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...f, history: f.history.slice(0, 30) }, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Release keys (field-store releaseHealth): an update on any build, or a store build with or without updates. */
export const updateKey = (updateId: string) => `@${updateId.replace(/-/g, "").slice(0, 8)}`;
export const storeKey = (version: string, build: string | null) => `${version}${build ? `(${build})` : ""}*`;

export type Workdir = { dir: string; done: () => Promise<void> };

export type ReleaseDeps = {
  now: Date;
  /** day2's field data per release key (field-store releaseHealth, for this app). */
  health: (keys: string[], since: Date) => Promise<ReleaseHealth[]>;
  eas: Eas;
  appStore: AppStore | null;
  play: Play | null;
  git: {
    /** origin/main's head and when the last commit landed there. */
    head(): Promise<{ sha: string; at: string }>;
    /** Commits from..to (oldest first), with the day2 ticket each closes when known. */
    changes(from: string | null, to: string): Promise<Change[]>;
    /** A checkout of `sha` with dependencies installed (reused across passes for the same sha). */
    checkout(sha: string): Promise<Workdir>;
    /** Raises the app's marketing version (e.g. 1.4.0 → 1.4.1) on main; returns the new head, or null if day2 couldn't. */
    bumpVersion(to: string): Promise<string | null>;
  };
  /** What still has to change in the store privacy answers (store-privacy.ts), empty when up to date. */
  privacyDue: (platform: Platform) => Promise<string[]>;
  writeNotes?: (changes: Change[]) => Promise<string>;
  /**
   * Runs before an update is published or store builds start, in the
   * release's checkout: Hosting applies the production database migrations
   * the release needs (hosting/environments.ts). Not ok → the release waits.
   */
  beforeShip?: (o: { dir: string; kind: "update" | "store"; sha: string }) => Promise<{ ok: true } | { ok: false; why: string }>;
  /** Runs before an App Store version is submitted: the Store module's staged listing changes go into it. */
  beforeIosSubmit?: (o: { appId: string; versionId: string; version: string }) => Promise<void>;
  ticket: (t: NewTicketInput) => Promise<{ id: string }>;
  log: (text: string) => void;
};

export type ReleaseReport = { started: string | null; advanced: string | null; finished: string | null; rolledBack: string | null; waiting: string | null; skipped: string | null };

const minutesSince = (iso: string, now: Date) => (now.getTime() - Date.parse(iso)) / 60_000;
const line = (r: Release, now: Date, text: string) => r.log.push({ at: now.toISOString(), text });
const pctText = (p: number) => `${p}%`;

/** Pure. "1.4.9" → "1.4.10"; anything else gets ".1". */
export function nextVersion(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : `${v.trim()}.1`;
}

/** Pure. Release notes from what changed, in plain words, for people using the app. */
export function draftNotes(changes: Change[]): string {
  const items = [...new Set(changes.map((c) => c.subject.replace(/^(fix|feat|chore|refactor|perf)(\(.+?\))?!?:\s*/i, "").replace(/\s*\(#\d+\)$/, "").trim()))]
    .filter((s) => s && !/^(merge|bump|release|wip|day2 |chore)/i.test(s))
    .slice(0, 8);
  return items.length ? `Improvements and fixes:\n${items.map((i) => `• ${i.charAt(0).toUpperCase()}${i.slice(1)}`).join("\n")}` : "Improvements and fixes.";
}

/** Should the new head ship as an update (same runtime as the store builds) or need store builds? */
export function decide(runtimeNow: Partial<Record<Platform, string | null>>, runtimeStore: Partial<Record<Platform, string | null>>, platforms: Platform[]): "update" | "store" {
  return platforms.every((p) => runtimeNow[p] && runtimeStore[p] && runtimeNow[p] === runtimeStore[p]) ? "update" : "store";
}

export async function releasePass(file: ReleasesFile, deps: ReleaseDeps): Promise<{ file: ReleasesFile; report: ReleaseReport }> {
  const report: ReleaseReport = { started: null, advanced: null, finished: null, rolledBack: null, waiting: null, skipped: null };
  const f: ReleasesFile = structuredClone(file);
  if (f.current) {
    await advance(f, deps, report);
    return { file: f, report };
  }
  if (f.settings.updates === "off" && f.settings.builds === "off") {
    report.skipped = "releases are off for this app";
    return { file: f, report };
  }
  const head = await deps.git.head();
  if (f.shipped?.sha === head.sha) return { file: f, report };
  if (minutesSince(head.at, deps.now) < QUIET_MINUTES) {
    report.waiting = "waiting for merges to settle";
    return { file: f, report };
  }
  await start(f, head.sha, deps, report);
  return { file: f, report };
}

async function start(f: ReleasesFile, sha: string, deps: ReleaseDeps, report: ReleaseReport): Promise<void> {
  const { now } = deps;
  const wd = await deps.git.checkout(sha);
  const config = await deps.eas.appConfig(wd.dir);
  const platforms = PLATFORMS.filter((p) => (p === "ios" ? config.bundleId : config.packageName));
  if (!platforms.length) {
    report.skipped = "the app config has no iOS bundle id or Android package";
    return;
  }
  // What the stores have: from day2's own record, else EAS's newest store build.
  const shipped: Shipped = f.shipped ?? { sha: "", at: now.toISOString(), fingerprint: {}, version: null, storeKey: {}, updateKey: {} };
  const runtimeNow: Partial<Record<Platform, string | null>> = {};
  const runtimeStore: Partial<Record<Platform, string | null>> = {};
  for (const p of platforms) {
    runtimeNow[p] = await deps.eas.runtimeVersion(wd.dir, p);
    const b = await deps.eas.latestStoreBuild(wd.dir, { platform: p, profile: f.settings.profile });
    runtimeStore[p] = b?.runtimeVersion ?? null;
    if (b?.appVersion && !shipped.storeKey[p]) shipped.storeKey[p] = storeKey(b.appVersion, b.buildNumber);
    if (b?.appVersion && !shipped.version) shipped.version = b.appVersion;
  }
  f.shipped = shipped;
  const changes = await deps.git.changes(shipped.sha || null, sha);
  const kind = config.hasUpdates && config.runtimePolicy ? decide(runtimeNow, runtimeStore, platforms) : "store";
  const id = `${kind === "update" ? "U" : "S"}-${sha.slice(0, 7)}`;
  if (deps.beforeShip && !(kind === "update" ? f.settings.updates === "off" : f.settings.builds === "off")) {
    const gate = await deps.beforeShip({ dir: wd.dir, kind, sha });
    if (!gate.ok) {
      report.waiting = gate.why;
      return;
    }
  }

  if (kind === "update") {
    if (f.settings.updates === "off") {
      report.skipped = "over-the-air updates are off";
      return;
    }
    const message = changes.length ? changes.map((c) => c.subject).slice(0, 3).join("; ").slice(0, 200) : `day2 release ${sha.slice(0, 7)}`;
    const u = await deps.eas.publishUpdate(wd.dir, { branch: f.settings.channel, message, percent: UPDATE_STAGES[0]! });
    const r: UpdateRelease = {
      id,
      kind: "update",
      sha,
      fromSha: shipped.sha || null,
      changes,
      startedAt: now.toISOString(),
      status: "rolling_out",
      groupId: u.groupId,
      updateIds: u.updateIds,
      runtimeVersion: u.runtimeVersion,
      branch: f.settings.channel,
      stage: 0,
      percent: UPDATE_STAGES[0]!,
      stageAt: now.toISOString(),
      baseline: Object.fromEntries(platforms.map((p) => [p, shipped.updateKey[p] ?? shipped.storeKey[p] ?? ""]).filter(([, k]) => k)),
      health: {},
      log: [],
    };
    line(r, now, `Published an update with ${changes.length} change${changes.length === 1 ? "" : "s"} to ${pctText(r.percent)} of users.`);
    deps.log(`Released ${changes.length} change${changes.length === 1 ? "" : "s"} as an over-the-air update to ${pctText(r.percent)} of users; day2 watches crashes before going further.`);
    f.current = r;
    report.started = id;
    return;
  }

  if (f.settings.builds === "off") {
    report.skipped = "store builds are off";
    return;
  }
  // A store release needs a version the stores haven't seen.
  let buildSha = sha;
  let version = config.version;
  if (shipped.version && version === shipped.version) {
    version = nextVersion(version);
    const bumped = await deps.git.bumpVersion(version);
    if (!bumped) {
      const t = await deps.ticket({
        title: `Raise the app version to ${version} for the next store release`,
        type: "task",
        description: `The next release has native changes, so it needs a store build with a new version. day2 couldn't change the version in the app config itself (it isn't a plain value in app.json or app.config). Set "version" to ${version}.`,
        doneWhen: [`The app config's version is ${version}`],
        priority: 2,
        prioritySource: "day2",
        source: { kind: "day2_proposal", key: `release:version:${version}` },
        actor: "day2",
        createdNote: "Needed for the next store release.",
      });
      report.waiting = `the version bump (${t.id})`;
      return;
    }
    buildSha = bumped;
    await wd.done();
  }
  const bwd = buildSha === sha ? wd : await deps.git.checkout(buildSha);
  const r: StoreRelease = {
    id,
    kind: "store",
    sha: buildSha,
    fromSha: shipped.sha || null,
    changes,
    startedAt: now.toISOString(),
    status: "in_progress",
    version,
    fingerprint: {},
    builds: {},
    submissions: {},
    notes: null,
    platforms: {},
    baseline: Object.fromEntries(platforms.map((p) => [p, shipped.storeKey[p] ?? ""]).filter(([, k]) => k)),
    health: {},
    waitingFor: null,
    log: [],
  };
  for (const p of platforms) {
    const b = await deps.eas.build(bwd.dir, { platform: p, profile: f.settings.profile, message: `day2 release ${version}` });
    r.builds[p] = { id: b.id, status: "queued", buildNumber: null, error: null };
    r.platforms[p] = { stage: "building", stageAt: now.toISOString(), ref: null, fraction: null, why: null };
    r.fingerprint[p] = runtimeNow[p] ?? "";
  }
  line(r, now, `Native changes: building ${version} for ${platforms.map((p) => (p === "ios" ? "iOS" : "Android")).join(" and ")}.`);
  deps.log(`Started store builds of ${version} (native changes) — they go to TestFlight / internal testing first.`);
  f.current = r;
  report.started = id;
}

// ---------------------------------------------------------------------------
// Moving a release on
// ---------------------------------------------------------------------------

async function advance(f: ReleasesFile, deps: ReleaseDeps, report: ReleaseReport): Promise<void> {
  const r = f.current!;
  if (r.stopRequested) await stop(r, deps, report);
  else if (r.kind === "update") await advanceUpdate(f, r, deps, report);
  else await advanceStore(f, r, deps, report);
  if (f.current && (f.current.status === "done" || f.current.status === "rolled_back" || f.current.status === "failed" || f.current.status === "stopped")) {
    f.history.unshift(f.current);
    f.current = null;
  }
}

async function healthOf(deps: ReleaseDeps, next: string, before: string | undefined, since: string): Promise<{ next: ReleaseHealth; before: ReleaseHealth | null }> {
  const keys = before ? [next, before] : [next];
  const h = await deps.health(keys, new Date(since)).catch(() => [] as ReleaseHealth[]);
  return { next: h.find((x) => x.release === next) ?? { release: next, devices: 0, crashed: 0, failing: {} }, before: before ? (h.find((x) => x.release === before) ?? null) : null };
}

/** Judges each platform; quiet apps go on after a long, clean wait. */
function judge(h: { next: ReleaseHealth; before: ReleaseHealth | null }, minutes: number, minMinutes: number) {
  const v = verdict(h.next, h.before, { minutesInStage: minutes, minMinutes, ...(minutes >= 24 * 60 ? { minDevices: 10 } : {}) });
  if (v.state === "wait" && minutes >= QUIET_APP_MINUTES) return { state: "healthy" as const, why: `no problems in ${Math.round(minutes / 60)} hours (${h.next.devices} launches — a quiet app)` };
  return v;
}

async function advanceUpdate(f: ReleasesFile, r: UpdateRelease, deps: ReleaseDeps, report: ReleaseReport): Promise<void> {
  const { now } = deps;
  const minutes = minutesSince(r.stageAt, now);
  const platforms = Object.keys(r.updateIds) as Platform[];
  let worst: { p: Platform; why: string } | null = null;
  let allHealthy = true;
  for (const p of platforms) {
    const h = await healthOf(deps, updateKey(r.updateIds[p]!), r.baseline[p], r.startedAt);
    const v = judge(h, minutes, UPDATE_STAGE_MINUTES[r.stage] ?? 0);
    r.health[p] = { state: v.state, why: v.why, at: now.toISOString() };
    if (v.state === "regressed") worst ??= { p, why: v.why };
    if (v.state !== "healthy") allHealthy = false;
  }
  if (worst) {
    const wd = await deps.git.checkout(r.sha);
    await deps.eas.revert(wd.dir, { branch: r.branch, groupId: r.groupId }).catch((err: Error) => line(r, now, `Couldn't roll back automatically: ${err.message}`));
    r.status = "rolled_back";
    line(r, now, `Rolled back on ${worst.p === "ios" ? "iOS" : "Android"}: ${worst.why}.`);
    const t = await deps.ticket(rollbackTicket(r, worst.why));
    deps.log(`Rolled back update ${r.id} at ${pctText(r.percent)}: ${worst.why}. Everyone is back on the previous version; ${t.id} has what broke.`);
    report.rolledBack = r.id;
    await wd.done();
    return;
  }
  if (!allHealthy) {
    report.waiting = `${r.id} at ${pctText(r.percent)}`;
    return;
  }
  if (r.stage + 1 >= UPDATE_STAGES.length) {
    r.status = "done";
    f.shipped = { ...(f.shipped ?? { fingerprint: {}, version: null, storeKey: {}, updateKey: {} }), sha: r.sha, at: now.toISOString(), updateKey: Object.fromEntries(platforms.map((p) => [p, updateKey(r.updateIds[p]!)])) } as Shipped;
    line(r, now, "Everyone has it.");
    deps.log(`Update ${r.id} reached everyone without problems.`);
    report.finished = r.id;
    return;
  }
  r.stage++;
  r.percent = UPDATE_STAGES[r.stage]!;
  r.stageAt = now.toISOString();
  const wd = await deps.git.checkout(r.sha);
  await deps.eas.setRollout(wd.dir, { branch: r.branch, groupId: r.groupId, percent: r.percent });
  if (r.percent === 100) await wd.done();
  line(r, now, `Healthy (${Object.values(r.health).map((x) => x?.why).join("; ")}) — now ${pctText(r.percent)} of users.`);
  if (r.percent === 100) {
    r.status = "done";
    f.shipped = { ...(f.shipped ?? { fingerprint: {}, version: null, storeKey: {}, updateKey: {} }), sha: r.sha, at: now.toISOString(), updateKey: Object.fromEntries(platforms.map((p) => [p, updateKey(r.updateIds[p]!)])) } as Shipped;
    deps.log(`Update ${r.id} is out to everyone.`);
    report.finished = r.id;
  } else report.advanced = r.id;
}

/** The owner stopped it: an update goes back to what users had; a store rollout is paused / halted. */
async function stop(r: Release, deps: ReleaseDeps, report: ReleaseReport): Promise<void> {
  const { now } = deps;
  const who = r.stopRequested?.by ?? "the owner";
  const wd = await deps.git.checkout(r.sha);
  if (r.kind === "update") {
    await deps.eas.revert(wd.dir, { branch: r.branch, groupId: r.groupId });
    r.status = "rolled_back";
    line(r, now, `Rolled back by ${who}.`);
  } else {
    const cfg = await deps.eas.appConfig(wd.dir);
    for (const p of Object.keys(r.platforms) as Platform[]) {
      const st = r.platforms[p]!;
      if (st.stage !== "rolling_out") continue;
      if (p === "ios" && deps.appStore) await deps.appStore.pausePhased(st.ref!);
      if (p === "android" && deps.play) await deps.play.halt({ packageName: cfg.packageName!, versionCode: st.ref! });
      st.stage = "paused";
      st.why = `stopped by ${who}`;
    }
    r.status = "stopped";
    line(r, now, `Stopped by ${who}.`);
  }
  deps.log(`${r.id} stopped by ${who}.`);
  report.rolledBack = r.id;
  await wd.done();
}

function rollbackTicket(r: Release, why: string): NewTicketInput {
  return {
    title: `Release ${r.id} rolled back: ${why}`.slice(0, 160),
    type: "bug",
    description: [
      `day2 ${r.kind === "update" ? "rolled back the over-the-air update" : "stopped the store rollout"} ${r.id} because ${why}, compared with the version before it (day2's field data).`,
      "",
      "What was in it:",
      ...r.changes.map((c) => `- ${c.subject}${c.ticketId ? ` (${c.ticketId})` : ""} — ${c.sha.slice(0, 7)}`),
      "",
      "Find which change caused it (the field checks' failures for this release show the evidence), fix it with a test, and the next release goes out on its own.",
    ].join("\n"),
    doneWhen: ["The cause is found and fixed, with a test", "The app builds and its tests pass"],
    priority: 1,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: `release:rollback:${r.id}` },
    actor: "day2",
    createdNote: "From day2's release checks.",
  };
}

async function advanceStore(f: ReleasesFile, r: StoreRelease, deps: ReleaseDeps, report: ReleaseReport): Promise<void> {
  const { now } = deps;
  const wd = await deps.git.checkout(r.sha);
  let config: AppConfig | null = null;
  const cfg = async () => (config ??= await deps.eas.appConfig(wd.dir));
  r.waitingFor = null;
  for (const p of Object.keys(r.platforms) as Platform[]) {
    const st = r.platforms[p]!;
    const set = (stage: typeof st.stage, why: string | null = null) => {
      st.stage = stage;
      st.stageAt = now.toISOString();
      st.why = why;
    };
    const name = p === "ios" ? "iOS" : "Android";
    try {
      if (st.stage === "building") {
        const b = await deps.eas.build_status(r.builds[p]!.id);
        r.builds[p] = { ...r.builds[p]!, status: b.status, buildNumber: b.buildNumber, error: b.error };
        if (b.status === "finished") {
          const s = await deps.eas.submit(wd.dir, { platform: p, buildId: r.builds[p]!.id, profile: f.settings.profile });
          r.submissions[p] = { id: s.id, status: "in_queue", error: null };
          set("uploading");
          line(r, now, `${name} build ${b.buildNumber ?? ""} is ready — uploading to ${p === "ios" ? "TestFlight" : "Google Play internal testing"}.`);
        } else if (b.status === "errored" || b.status === "canceled") {
          set("failed", b.error ?? `the build was ${b.status}`);
          const t = await deps.ticket(buildFailedTicket(r, p, b.error ?? b.status));
          line(r, now, `${name} build failed: ${b.error ?? b.status} (${t.id}).`);
        }
      } else if (st.stage === "uploading") {
        const s = await deps.eas.submit_status(r.submissions[p]!.id);
        r.submissions[p] = { ...r.submissions[p]!, status: s.status, error: s.error };
        if (s.status === "finished") {
          set(p === "ios" ? "processing" : "waiting_notes");
          line(r, now, `${name}: uploaded — testers get it now.`);
        } else if (s.status === "errored" || s.status === "canceled") {
          set("failed", s.error ?? "the upload failed");
          r.waitingFor = `${name} upload failed: ${s.error ?? "see EAS"}. Check the store credentials, then day2 retries with the next release.`;
        }
      } else if (st.stage === "processing" && p === "ios" && deps.appStore) {
        const c = await cfg();
        const b = await deps.appStore.findBuild({ bundleId: c.bundleId!, version: r.version, buildNumber: r.builds.ios!.buildNumber ?? "" });
        if (b?.processing === "valid") {
          if (b.missingCompliance) await deps.appStore.setNoNonExemptEncryption(b.buildId);
          st.ref = b.buildId;
          set("waiting_notes");
        } else if (b?.processing === "failed") set("failed", "App Store Connect couldn't process the build");
      }

      if (st.stage === "waiting_notes" || st.stage === "waiting_privacy") {
        r.notes ??= { text: deps.writeNotes ? await deps.writeNotes(r.changes) : draftNotes(r.changes), approved: f.settings.storeRelease === "auto", by: f.settings.storeRelease === "auto" ? "day2" : null, at: now.toISOString() };
        const due = await deps.privacyDue(p);
        if (due.length) {
          set("waiting_privacy");
          r.waitingFor = `Update the ${name === "iOS" ? "App Store" : "Google Play"} privacy answers first (Privacy page) — ${due.length} change${due.length === 1 ? "" : "s"}.`;
          continue;
        }
        if (!r.notes.approved) {
          r.waitingFor = "Approve the release notes.";
          continue;
        }
        if (p === "ios" && deps.appStore) {
          const c = await cfg();
          const b = await deps.appStore.findBuild({ bundleId: c.bundleId!, version: r.version, buildNumber: r.builds.ios!.buildNumber ?? "" });
          const prepare = deps.beforeIosSubmit ? (versionId: string) => deps.beforeIosSubmit!({ appId: b!.appId, versionId, version: r.version }).catch((err: Error) => void line(r, now, `Listing changes didn't go in: ${err.message}`)) : undefined;
          const v = await deps.appStore.submitForReview({ appId: b!.appId, version: r.version, buildId: b!.buildId, notes: r.notes.text, phased: true, ...(prepare ? { prepare } : {}) });
          st.ref = v.versionId;
          set("in_review");
          line(r, now, "iOS: submitted for App Review, with a phased release.");
        } else if (p === "android" && deps.play) {
          const c = await cfg();
          const code = r.builds.android!.buildNumber ?? "";
          await deps.play.promote({ packageName: c.packageName!, versionCode: code, fraction: ANDROID_STAGES[0]!, notes: r.notes.text, name: `${r.version} (${code})` });
          st.ref = code;
          st.fraction = ANDROID_STAGES[0]!;
          set("in_review");
          line(r, now, `Android: sent to production for ${Math.round(ANDROID_STAGES[0]! * 100)}% of users (after Google's review).`);
        } else {
          r.waitingFor = `Connect ${name === "iOS" ? "App Store Connect" : "Google Play"} so day2 can release it (Releases).`;
        }
      } else if (st.stage === "in_review") {
        if (p === "ios" && deps.appStore) {
          const s = await deps.appStore.versionState(st.ref!);
          if (s.state === "pending_release") await deps.appStore.release(st.ref!);
          if (s.state === "ready_for_sale") {
            set("rolling_out");
            st.fraction = s.phased?.day ?? null;
            line(r, now, "iOS: approved and live — Apple releases it to automatic updates over 7 days.");
          } else if (s.state === "rejected") {
            set("rejected", "App Review rejected it");
            r.waitingFor = "App Review rejected the iOS version — see the Resolution Center in App Store Connect. day2 can't read the reason.";
          } else if (s.state === "developer_rejected") set("failed", "withdrawn from review");
        } else if (p === "android" && deps.play) {
          const c = await cfg();
          const s = await deps.play.status({ packageName: c.packageName!, versionCode: st.ref! });
          if (s.lifecycle === "published") {
            set("rolling_out");
            line(r, now, `Android: approved — live for ${Math.round((st.fraction ?? 0) * 100)}% of users.`);
          } else if (s.lifecycle === "rejected") {
            set("rejected", "Google Play rejected it");
            r.waitingFor = "Google Play rejected the Android release — see the Play Console inbox.";
          } else if (s.lifecycle === "approved_not_published") r.waitingFor = "Google approved the Android release; managed publishing is on — click Publish in Play Console.";
        }
      } else if (st.stage === "rolling_out" || st.stage === "paused") {
        const buildKey = storeKey(r.version, r.builds[p]!.buildNumber);
        const h = await healthOf(deps, buildKey, r.baseline[p], st.stageAt);
        const minutes = minutesSince(st.stageAt, now);
        const v = judge(h, minutes, p === "android" ? ANDROID_STAGE_MINUTES : 24 * 60);
        r.health[p] = { state: v.state, why: v.why, at: now.toISOString() };
        if (v.state === "regressed" && st.stage === "rolling_out") {
          const c = await cfg();
          if (p === "ios" && deps.appStore) await deps.appStore.pausePhased(st.ref!);
          if (p === "android" && deps.play) await deps.play.halt({ packageName: c.packageName!, versionCode: st.ref! });
          set("paused", v.why);
          const t = await deps.ticket(rollbackTicket(r, `${name}: ${v.why}`));
          line(r, now, `${name}: ${p === "ios" ? "paused the phased release" : "halted the rollout"} — ${v.why} (${t.id}).`);
          deps.log(`${p === "ios" ? "Paused" : "Halted"} ${r.version} on ${name}: ${v.why}. ${t.id} has what broke; the fix ships as the next release.`);
          report.rolledBack = r.id;
        } else if (st.stage === "rolling_out" && p === "ios" && deps.appStore) {
          const s = await deps.appStore.versionState(st.ref!);
          st.fraction = s.phased?.day ?? st.fraction;
          if (!s.phased || s.phased.state === "complete") {
            set("released");
            line(r, now, "iOS: everyone gets it.");
          }
        } else if (st.stage === "rolling_out" && p === "android" && deps.play && v.state === "healthy") {
          const c = await cfg();
          const i = ANDROID_STAGES.indexOf(st.fraction ?? 0);
          const next = ANDROID_STAGES[i + 1] ?? 1;
          if (next >= 1) await deps.play.complete({ packageName: c.packageName!, versionCode: st.ref! });
          else await deps.play.setFraction({ packageName: c.packageName!, versionCode: st.ref!, fraction: next });
          st.fraction = next;
          if (next >= 1) set("released");
          else st.stageAt = now.toISOString();
          line(r, now, `Android: healthy (${v.why}) — now ${Math.round(next * 100)}%.`);
        }
      }
    } catch (err) {
      line(r, now, `${name}: ${(err as Error).message}`);
      r.waitingFor = `${name}: ${(err as Error).message}`;
    }
  }
  const stages = Object.values(r.platforms).map((x) => x!.stage);
  if (stages.every((s) => s === "released")) {
    r.status = "done";
    const shipped = f.shipped ?? { sha: "", at: "", fingerprint: {}, version: null, storeKey: {}, updateKey: {} };
    f.shipped = {
      sha: r.sha,
      at: now.toISOString(),
      fingerprint: { ...shipped.fingerprint, ...r.fingerprint },
      version: r.version,
      storeKey: { ...shipped.storeKey, ...Object.fromEntries((Object.keys(r.platforms) as Platform[]).map((p) => [p, storeKey(r.version, r.builds[p]!.buildNumber)])) },
      updateKey: {},
    };
    deps.log(`${r.version} is out to everyone on ${Object.keys(r.platforms).map((p) => (p === "ios" ? "iOS" : "Android")).join(" and ")}.`);
    report.finished = r.id;
    await wd.done();
  } else if (stages.every((s) => s === "failed" || s === "released" || s === "paused" || s === "rejected")) {
    r.status = stages.some((s) => s === "failed") ? "failed" : "stopped";
    await wd.done();
  } else if (r.waitingFor) {
    r.status = "waiting_owner";
    report.waiting = r.waitingFor;
  } else {
    r.status = "in_progress";
    report.advanced = r.id;
  }
}

function buildFailedTicket(r: StoreRelease, p: Platform, error: string): NewTicketInput {
  return {
    title: `Store build of ${r.version} failed on ${p === "ios" ? "iOS" : "Android"}`,
    type: "bug",
    description: `EAS Build failed for ${r.version} (${r.sha.slice(0, 7)}): ${error}\n\nFix the build (the EAS build logs have the details), and the next release builds again.`,
    doneWhen: ["The build succeeds", "The app builds and its tests pass"],
    priority: 1,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: `release:build:${r.id}:${p}` },
    actor: "day2",
    createdNote: "From day2's release pipeline.",
  };
}
