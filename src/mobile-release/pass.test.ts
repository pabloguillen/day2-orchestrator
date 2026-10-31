import { describe, expect, test } from "bun:test";
import type { NewTicketInput } from "../backlog";
import type { ReleaseHealth } from "../field-store";
import type { AppConfig, AppStore, Eas, Play } from "./adapters";
import { verdict } from "./health";
import { decide, draftNotes, loadReleases, nextVersion, releasePass, type ReleaseDeps } from "./pass";
import type { ReleasesFile, StoreRelease, UpdateRelease } from "./types";

/** Releasing a mobile app by itself: updates in stages, store releases end to end, rolled back on worse field data. */

const T0 = new Date("2026-10-31T10:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const CONFIG: AppConfig = { version: "1.4.0", bundleId: "com.buddy", packageName: "com.buddy", runtimePolicy: "fingerprint", hasUpdates: true };

function fakes(o: { runtimeNow?: string; runtimeStore?: string } = {}) {
  const calls: string[] = [];
  const tickets: NewTicketInput[] = [];
  let health: Record<string, ReleaseHealth> = {};
  const eas: Eas = {
    appConfig: async () => CONFIG,
    latestStoreBuild: async (_w, { platform }) => ({ id: `b-${platform}`, runtimeVersion: o.runtimeStore ?? "rt1", appVersion: "1.4.0", buildNumber: "23", gitCommit: "old" }),
    fingerprint: async () => "fp",
    runtimeVersion: async () => o.runtimeNow ?? "rt1",
    publishUpdate: async (_w, p) => {
      calls.push(`publish ${p.percent}`);
      return { groupId: "g1", updateIds: { ios: "aaaaaaaa-1111", android: "bbbbbbbb-2222" }, runtimeVersion: "rt1" };
    },
    setRollout: async (_w, p) => void calls.push(`rollout ${p.percent}`),
    revert: async () => void calls.push("revert"),
    build: async (_w, p) => {
      calls.push(`build ${p.platform}`);
      return { id: `build-${p.platform}` };
    },
    build_status: async () => ({ status: "finished", buildNumber: "24", appVersion: "1.4.1", error: null }),
    submit: async (_w, p) => {
      calls.push(`submit ${p.platform}`);
      return { id: `sub-${p.platform}` };
    },
    submit_status: async () => ({ status: "finished", error: null }),
  };
  let iosState: Awaited<ReturnType<AppStore["versionState"]>> = { state: "waiting_for_review", phased: null };
  const appStore: AppStore = {
    findBuild: async () => ({ appId: "app1", buildId: "asc-b", processing: "valid", missingCompliance: true }),
    setNoNonExemptEncryption: async () => void calls.push("compliance"),
    submitForReview: async (p) => {
      calls.push(`review ${p.version} phased=${p.phased} notes=${p.notes.split("\n")[0]}`);
      return { versionId: "v1" };
    },
    versionState: async () => iosState,
    pausePhased: async () => void calls.push("ios pause"),
    resumePhased: async () => void calls.push("ios resume"),
    release: async () => void calls.push("ios release"),
  };
  let playLifecycle: Awaited<ReturnType<Play["status"]>>["lifecycle"] = "in_review";
  const play: Play = {
    promote: async (p) => void calls.push(`play promote ${p.versionCode} ${p.fraction}`),
    setFraction: async (p) => void calls.push(`play ${p.fraction}`),
    halt: async () => void calls.push("play halt"),
    complete: async () => void calls.push("play complete"),
    status: async () => ({ lifecycle: playLifecycle, status: "inProgress", fraction: 0.05 }),
  };
  let privacy: string[] = [];
  let head = { sha: "new", at: at(-60).toISOString() };
  const deps = (now: Date): ReleaseDeps => ({
    now,
    health: async (keys) => keys.map((k) => health[k] ?? { release: k, devices: 0, crashed: 0, failing: {} }),
    eas,
    appStore,
    play,
    git: {
      head: async () => head,
      changes: async () => [{ sha: "c1", subject: "fix: Receipts upload again (#41)", ticketId: "D2-41" }, { sha: "c2", subject: "Faster bill split", ticketId: null }],
      checkout: async (sha) => ({ dir: `/tmp/${sha}`, done: async () => {} }),
      bumpVersion: async (to) => {
        calls.push(`bump ${to}`);
        return "bumped";
      },
    },
    privacyDue: async () => privacy,
    ticket: async (t) => {
      tickets.push(t);
      return { id: `D2-${90 + tickets.length}` };
    },
    log: () => {},
  });
  return {
    calls,
    tickets,
    deps,
    setHealth: (h: Record<string, ReleaseHealth>) => (health = h),
    setIos: (s: typeof iosState) => (iosState = s),
    setPlay: (l: typeof playLifecycle) => (playLifecycle = l),
    setPrivacy: (p: string[]) => (privacy = p),
    setHead: (h: typeof head) => (head = h),
  };
}

const base = (): ReleasesFile => ({ ...loadReleases("/nonexistent"), enabled: true, shipped: { sha: "old", at: T0.toISOString(), fingerprint: {}, version: "1.4.0", storeKey: { ios: "1.4.0(23)*", android: "1.4.0(23)*" }, updateKey: {} } });
const h = (release: string, devices: number, crashed: number, failing: Record<string, number> = {}): ReleaseHealth => ({ release, devices, crashed, failing });

describe("pure parts", () => {
  test("update when every platform keeps its runtime; a store build otherwise", () => {
    expect(decide({ ios: "a", android: "b" }, { ios: "a", android: "b" }, ["ios", "android"])).toBe("update");
    expect(decide({ ios: "a", android: "c" }, { ios: "a", android: "b" }, ["ios", "android"])).toBe("store");
    expect(decide({ ios: "a" }, { ios: null }, ["ios"])).toBe("store");
  });
  test("versions and notes", () => {
    expect(nextVersion("1.4.9")).toBe("1.4.10");
    expect(nextVersion("2.0")).toBe("2.0.1");
    expect(draftNotes([{ sha: "a", subject: "fix(cart): keep the total when going back (#12)", ticketId: null }, { sha: "b", subject: "Merge branch main", ticketId: null }])).toBe("Improvements and fixes:\n• Keep the total when going back");
  });
  test("health: waits for launches and time; crashes up or a check breaking is a regression", () => {
    expect(verdict(h("@n", 10, 0), h("@o", 500, 2), { minutesInStage: 300, minMinutes: 120 }).state).toBe("wait");
    expect(verdict(h("@n", 80, 0), h("@o", 500, 2), { minutesInStage: 30, minMinutes: 120 }).state).toBe("wait");
    expect(verdict(h("@n", 80, 0), h("@o", 500, 2), { minutesInStage: 130, minMinutes: 120 }).state).toBe("healthy");
    const crashy = verdict(h("@n", 100, 9), h("@o", 1000, 3), { minutesInStage: 10, minMinutes: 120 });
    expect(crashy).toEqual({ state: "regressed", why: "9% of launches crashed, against 0.3% before" });
    expect(verdict(h("@n", 100, 0, { "cart.continue": 8 }), h("@o", 1000, 0, { "cart.continue": 2 }), { minutesInStage: 10, minMinutes: 120 })).toEqual({ state: "regressed", why: '"cart.continue" fails on 8% of launches, against 0.2% before' });
  });
});

describe("JavaScript-only changes: an over-the-air update in stages", () => {
  test("10% → 50% → 100%, each after enough healthy launches; then it's what's shipped", async () => {
    const f = fakes();
    let file = base();
    file = (await releasePass(file, f.deps(T0))).file;
    const r = file.current as UpdateRelease;
    expect(r).toMatchObject({ kind: "update", percent: 10, groupId: "g1", baseline: { ios: "1.4.0(23)*", android: "1.4.0(23)*" } });
    expect(f.calls).toEqual(["publish 10"]);
    // Too few launches yet.
    f.setHealth({ "@aaaaaaaa": h("@aaaaaaaa", 20, 0), "@bbbbbbbb": h("@bbbbbbbb", 20, 0) });
    expect((await releasePass(file, f.deps(at(130)))).report.waiting).toBe("U-new at 10%");
    f.setHealth({ "@aaaaaaaa": h("@aaaaaaaa", 120, 0), "@bbbbbbbb": h("@bbbbbbbb", 90, 0), "1.4.0(23)*": h("1.4.0(23)*", 800, 2) });
    file = (await releasePass(file, f.deps(at(130)))).file;
    expect((file.current as UpdateRelease).percent).toBe(50);
    file = (await releasePass(file, f.deps(at(130 + 241)))).file;
    expect(file.current).toBeNull();
    expect(f.calls).toEqual(["publish 10", "rollout 50", "rollout 100"]);
    expect(file.history[0]).toMatchObject({ status: "done" });
    expect(file.shipped).toMatchObject({ sha: "new", updateKey: { ios: "@aaaaaaaa", android: "@bbbbbbbb" } });
    // Nothing new on main: nothing happens.
    expect((await releasePass(file, f.deps(at(400)))).report).toMatchObject({ started: null, waiting: null });
  });

  test("crashes up on one platform → rolled back for everyone, with a bug ticket", async () => {
    const f = fakes();
    let file = (await releasePass(base(), f.deps(T0))).file;
    f.setHealth({ "@aaaaaaaa": h("@aaaaaaaa", 100, 12), "1.4.0(23)*": h("1.4.0(23)*", 900, 3) });
    const { file: after, report } = await releasePass(file, f.deps(at(15)));
    file = after;
    expect(report.rolledBack).toBe("U-new");
    expect(f.calls).toEqual(["publish 10", "revert"]);
    expect(file.history[0]).toMatchObject({ status: "rolled_back" });
    expect(f.tickets[0]).toMatchObject({ type: "bug", priority: 1, title: expect.stringContaining("12% of launches crashed") });
    expect(f.tickets[0]!.description).toContain("fix: Receipts upload again (#41) (D2-41) — c1");
    expect(file.shipped!.sha).toBe("old");
  });

  test("the owner stops it: everyone goes back to what they had", async () => {
    const f = fakes();
    let file = (await releasePass(base(), f.deps(T0))).file;
    file.current!.stopRequested = { by: "Pablo", at: at(5).toISOString() };
    file = (await releasePass(file, f.deps(at(6)))).file;
    expect(f.calls).toEqual(["publish 10", "revert"]);
    expect(file.history[0]).toMatchObject({ status: "rolled_back", log: expect.arrayContaining([expect.objectContaining({ text: "Rolled back by Pablo." })]) });
  });

  test("merges still landing: wait for them to settle", async () => {
    const f = fakes();
    f.setHead({ sha: "new", at: at(-5).toISOString() });
    expect((await releasePass(base(), f.deps(T0))).report.waiting).toBe("waiting for merges to settle");
  });

  test("a quiet app goes on after three clean days", async () => {
    const f = fakes();
    let file = (await releasePass(base(), f.deps(T0))).file;
    f.setHealth({ "@aaaaaaaa": h("@aaaaaaaa", 4, 0), "@bbbbbbbb": h("@bbbbbbbb", 3, 0) });
    file = (await releasePass(file, f.deps(at(72 * 60 + 1)))).file;
    expect((file.current as UpdateRelease).percent).toBe(50);
  });
});

describe("native changes: a store release end to end", () => {
  test("version bump, builds, uploads, privacy gate, review, phased and staged rollouts", async () => {
    const f = fakes({ runtimeNow: "rt2" });
    let file = (await releasePass(base(), f.deps(T0))).file;
    let r = file.current as StoreRelease;
    expect(r).toMatchObject({ kind: "store", version: "1.4.1", sha: "bumped" });
    expect(f.calls).toEqual(["bump 1.4.1", "build ios", "build android"]);
    // Builds done → uploaded to TestFlight / internal.
    file = (await releasePass(file, f.deps(at(30)))).file;
    expect(f.calls.slice(-2)).toEqual(["submit ios", "submit android"]);
    // Uploads done; iOS processed (export compliance set); privacy answers out of date → waits for the owner.
    f.setPrivacy(["Add Usage Data → Product Interaction"]);
    file = (await releasePass(file, f.deps(at(60)))).file;
    file = (await releasePass(file, f.deps(at(70)))).file;
    r = file.current as StoreRelease;
    expect(r.status).toBe("waiting_owner");
    expect(r.waitingFor).toContain("privacy answers");
    expect(f.calls).toContain("compliance");
    // Owner updated them → submitted, with the notes day2 wrote.
    f.setPrivacy([]);
    file = (await releasePass(file, f.deps(at(80)))).file;
    expect(f.calls).toContain("review 1.4.1 phased=true notes=Improvements and fixes:");
    expect(f.calls).toContain("play promote 24 0.05");
    // Approved: iOS live with Apple's phased release, Android at 5%.
    f.setIos({ state: "ready_for_sale", phased: { state: "active", day: 1 } });
    f.setPlay("published");
    file = (await releasePass(file, f.deps(at(600)))).file;
    r = file.current as StoreRelease;
    expect([r.platforms.ios!.stage, r.platforms.android!.stage]).toEqual(["rolling_out", "rolling_out"]);
    // A day later, healthy → Android 20%.
    f.setHealth({ "1.4.1(24)*": h("1.4.1(24)*", 200, 0), "1.4.0(23)*": h("1.4.0(23)*", 3000, 6) });
    file = (await releasePass(file, f.deps(at(600 + 24 * 60 + 1)))).file;
    expect(f.calls).toContain("play 0.2");
    // Apple's phased release completes; Android goes 50% → 100%.
    f.setIos({ state: "ready_for_sale", phased: { state: "complete", day: 7 } });
    file = (await releasePass(file, f.deps(at(600 + 2 * 24 * 60 + 2)))).file;
    file = (await releasePass(file, f.deps(at(600 + 3 * 24 * 60 + 3)))).file;
    expect(f.calls).toContain("play complete");
    expect(file.current).toBeNull();
    expect(file.history[0]).toMatchObject({ status: "done", version: "1.4.1" });
    expect(file.shipped).toMatchObject({ sha: "bumped", version: "1.4.1", storeKey: { ios: "1.4.1(24)*", android: "1.4.1(24)*" } });
  });

  test("worse in the field → iOS phased release paused, Android halted, bug ticket", async () => {
    const f = fakes({ runtimeNow: "rt2" });
    let file = (await releasePass(base(), f.deps(T0))).file;
    for (const m of [30, 60, 70, 80]) file = (await releasePass(file, f.deps(at(m)))).file;
    f.setIos({ state: "ready_for_sale", phased: { state: "active", day: 2 } });
    f.setPlay("published");
    file = (await releasePass(file, f.deps(at(600)))).file;
    f.setHealth({ "1.4.1(24)*": h("1.4.1(24)*", 300, 30), "1.4.0(23)*": h("1.4.0(23)*", 3000, 6) });
    file = (await releasePass(file, f.deps(at(700)))).file;
    expect(f.calls).toContain("ios pause");
    expect(f.calls).toContain("play halt");
    expect(f.tickets.at(-1)).toMatchObject({ type: "bug" });
    expect(file.history[0]).toMatchObject({ status: "stopped" });
  });

  test("owner approves the notes first, when they asked for that", async () => {
    const f = fakes({ runtimeNow: "rt2" });
    let file: ReleasesFile = { ...base(), settings: { ...base().settings, storeRelease: "approve_notes" } };
    file = (await releasePass(file, f.deps(T0))).file;
    for (const m of [30, 60, 70]) file = (await releasePass(file, f.deps(at(m)))).file;
    const r = file.current as StoreRelease;
    expect(r.waitingFor).toBe("Approve the release notes.");
    expect(f.calls.some((c) => c.startsWith("review"))).toBe(false);
  });
});
