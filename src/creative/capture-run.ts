import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir } from "../day2-paths";
import type { Target } from "../device-checks/targets";
import { EAS_CLI_VERSION, childEnv } from "../mobile-release/eas";
import { captureMoments, capturePlan, importScreens, isStale, loadCaptureSet, localeFor, type CaptureSet } from "./capture";
import { ARTIFACT, artifactLinks, CAPTURE_WORKFLOW, captureWorkflowYaml, LOGIN_ENV, withDemoProfile } from "./demo-flow";
import { safeDownload } from "./download";

/**
 * Running a capture (docs/creative-quality.md, "Real screens"): where it
 * can run, one at a time per app, with a status and a log the console
 * polls.
 *
 *  - local: this Mac's iPhone Simulator (or Android emulator) — a
 *    temporary database for this run (demo-session.ts: Docker, the app's
 *    migrations, the approved cast), the demo build pointed at it
 *    (http://127.0.0.1:<port>, or 10.0.2.2 from the Android emulator),
 *    then the app's Maestro flow with this run's demo login in Maestro's
 *    environment;
 *  - eas: an EAS workflow — a simulator build with the demo profile pointed
 *    at a short-lived tunnel to the temporary database, and EAS's Maestro
 *    job, its screenshots uploaded as an artifact that day2 downloads
 *    (SSRF-checked). The login goes in as secret EAS variables for this run
 *    and is deleted afterwards. The artifact download is built from the
 *    workflow docs and `eas workflow:view --json`, whose artifact shape is
 *    undocumented; when no link comes back day2 says so and the Mac path
 *    stays the way to capture.
 *
 * Triggers: the Capture screens button and the real-screens pipeline
 * (real-screens-auto.ts: a new app version, the first How it works post,
 * daily maintenance). A server without a simulator captures on EAS by
 * default; `code` on a failed status says what to try next.
 */

export type CaptureMode = "local" | "eas" | "off";
/** Why a capture failed, for the real-screens pipeline (what to try next). */
export type CaptureFailure = "off" | "no_flow" | "no_token" | "no_demo" | "artifact" | "device" | "no_docker" | "no_tunnel" | "migration" | "database" | "other";
/** The run's temporary database: starting → ready → removed (or failed); `hints` say what to install. */
export type DatabaseStatus = { state: "starting" | "ready" | "removed" | "failed"; note: string | null; at: string; hints?: string[] };
export type CaptureStatus = { state: "idle" | "running" | "done" | "failed"; mode: CaptureMode | null; reason: CaptureReason | null; startedAt: string | null; finishedAt: string | null; note: string | null; screens: number; log: Array<{ at: string; text: string }>; code?: CaptureFailure | null; database?: DatabaseStatus | null };
export type CaptureReason = "button" | "new_version" | "first_how_it_works" | "pipeline" | "fallback_android";

const statusFile = (appId: string) => join(dataDir(), "creative-screens", appId.replace(/[^\w-]/g, "_"), "status.json");
const idle = (): CaptureStatus => ({ state: "idle", mode: null, reason: null, startedAt: null, finishedAt: null, note: null, screens: 0, log: [] });

export function loadCaptureStatus(appId: string): CaptureStatus {
  try {
    const s = JSON.parse(readFileSync(statusFile(appId), "utf-8")) as CaptureStatus;
    // A run that was going when day2 restarted didn't finish.
    if (s.state === "running" && !running.has(appId)) return { ...s, state: "failed", note: s.note ?? "day2 restarted during the capture — press Capture screens again." };
    return s;
  } catch {
    return idle();
  }
}

function saveStatus(appId: string, s: CaptureStatus): void {
  mkdirSync(join(statusFile(appId), ".."), { recursive: true });
  writeFileSync(statusFile(appId), JSON.stringify({ ...s, log: s.log.slice(0, 60) }, null, 2));
}

/** Where captures run on this server, and why not when they can't. Pure apart from the env. */
export function captureMode(o: { env?: Record<string, string | undefined>; platform?: string; has: (bin: string) => boolean }): { mode: CaptureMode; why: string | null; maestro: boolean } {
  const env = o.env ?? process.env;
  const want = env.DAY2_CAPTURE ?? env.DAY2_DEVICE_CHECKS;
  const maestro = o.has("maestro");
  if (want === "off") return { mode: "off", why: "Captures are off on this server (DAY2_CAPTURE=off).", maestro };
  if (want === "eas") return { mode: "eas", why: null, maestro };
  const mac = (o.platform ?? process.platform) === "darwin" && o.has("xcrun");
  if (mac || want === "local") return { mode: "local", why: maestro ? null : `Maestro isn't installed on this Mac — run ${'curl -fsSL "https://get.maestro.mobile.dev" | bash'} in Terminal, then press Capture screens again.`, maestro };
  // A server without a simulator (production): EAS builds and runs the flow.
  return { mode: "eas", why: null, maestro };
}

/**
 * Can this server run the Android emulator for a capture (the fallback when
 * EAS's screenshots can't be downloaded)? adb, emulator and Maestro on PATH,
 * an Android SDK, an AVD named in DAY2_ANDROID_AVD or found, and on Linux
 * /dev/kvm. Pure apart from what's passed in.
 */
export function androidEmulatorAvailable(o: { env?: Record<string, string | undefined>; platform?: string; has: (bin: string) => boolean; exists: (path: string) => boolean }): { ok: boolean; why: string | null } {
  const env = o.env ?? process.env;
  if (env.DAY2_ANDROID_FALLBACK === "off") return { ok: false, why: "the Android fallback is off (DAY2_ANDROID_FALLBACK=off)" };
  if (!o.has("adb") || !o.has("emulator")) return { ok: false, why: "this server has no Android emulator (adb and emulator aren't installed)" };
  if (!o.has("maestro")) return { ok: false, why: "Maestro isn't installed on this server" };
  if (!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT) return { ok: false, why: "no Android SDK (ANDROID_HOME) on this server" };
  if ((o.platform ?? process.platform) === "linux" && !o.exists("/dev/kvm")) return { ok: false, why: "this server can't run emulators fast enough (no /dev/kvm)" };
  return { ok: true, why: null };
}

/** Pure. Why a capture should start on its own now, or null. */
export function autoCaptureReason(o: { set: CaptureSet | null; version: string | null; howItWorksAt: string | null; making: "how-it-works" | null; status: CaptureStatus; now: Date; ready: boolean }): CaptureReason | null {
  if (!o.ready || o.status.state === "running") return null;
  // Don't retry a failed automatic run more than once a day.
  if (o.status.state === "failed" && o.status.reason !== "button" && o.status.finishedAt && o.now.getTime() - Date.parse(o.status.finishedAt) < 86_400_000) return null;
  if (!o.howItWorksAt && o.making === "how-it-works" && (!o.set || isStale(o.set, o.version, o.now))) return "first_how_it_works";
  if (o.set && o.version && o.set.version && o.set.version !== o.version) return "new_version";
  return null;
}

export type DemoValues = { url: string; key: string; login: { email: string; password: string } | null; ai: CaptureSet["aiContent"]; close?: () => Promise<void> };

/** A failure to open the run's database, as a capture failure code (Docker missing, a migration, the tunnel, or something to retry). */
export function demoFailure(err: unknown): { code: CaptureFailure; hints: string[] } {
  const e = err as { code?: string; hints?: string[]; name?: string; problems?: string[] };
  const hints = Array.isArray(e?.hints) ? e.hints : [];
  if (e?.code === "no_docker" || e?.code === "no_cli") return { code: "no_docker", hints };
  if (e?.code === "no_tunnel") return { code: "no_tunnel", hints };
  if (e?.code === "migration" || Array.isArray(e?.problems)) return { code: "migration", hints };
  return { code: "database", hints };
}

export type CaptureRunDeps = {
  mode: CaptureMode;
  /** A clean checkout of the app's main branch (and how to drop it). */
  checkout: () => Promise<{ dir: string; done: () => Promise<void> }>;
  /**
   * This run's demo backend for the device that runs the flow (a temporary
   * database, demo-session.ts): its address and public key, this run's
   * login, and close() to remove it — or null (no approved cast: the flow
   * runs against whatever the build points at). Throws a DemoOpenError-like
   * error ({ code, hints }) when it can't start.
   */
  demo: (o: { where: "ios" | "android" | "eas"; dir: string; log: (text: string) => void }) => Promise<DemoValues | null>;
  local?: { target: (p: "ios" | "android") => Promise<Target | { skip: string }>; flow: Parameters<typeof captureMoments>[1]["flow"]; run: (cmd: string[]) => Promise<{ code: number }> };
  eas?: { expoToken: () => Promise<string | null>; run: (cmd: string[], o: { cwd: string; env: Record<string, string>; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>; download?: typeof safeDownload };
  /** After a capture (cleanup that isn't the database's). */
  after?: () => Promise<void>;
  now?: () => Date;
};

const running = new Set<string>();
export const captureRunning = (appId: string) => running.has(appId);

export type CaptureInput = { appId: string; repoPath: string; language: string; features: string[]; bundleId: string | null; packageName: string | null; reason: CaptureReason };

/** Runs one capture (or returns at once when one is already running for the app). */
export async function runCapture(i: CaptureInput, d: CaptureRunDeps): Promise<CaptureStatus> {
  if (running.has(i.appId)) return loadCaptureStatus(i.appId);
  running.add(i.appId);
  const now = () => (d.now ? d.now() : new Date());
  const status: CaptureStatus = { state: "running", mode: d.mode, reason: i.reason, startedAt: now().toISOString(), finishedAt: null, note: null, screens: 0, log: [] };
  const log = (text: string) => {
    status.log.unshift({ at: now().toISOString(), text });
    saveStatus(i.appId, status);
  };
  const finish = (ok: boolean, note: string, screens = 0, code: CaptureFailure | null = ok ? null : "other") => {
    status.state = ok ? "done" : "failed";
    status.note = note;
    status.screens = screens;
    status.code = code;
    status.finishedAt = now().toISOString();
    log(note);
    return status;
  };
  saveStatus(i.appId, status);
  let wd: { dir: string; done: () => Promise<void> } | null = null;
  let demo: DemoValues | null = null;
  const setDb = (state: DatabaseStatus["state"], note: string | null, hints?: string[]) => {
    status.database = { state, note, at: now().toISOString(), ...(hints?.length ? { hints } : {}) };
    saveStatus(i.appId, status);
  };
  /** Opens this run's temporary database for the device (or says why not). */
  const openDemo = async (where: "ios" | "android" | "eas", dir: string): Promise<DemoValues | null | { failed: CaptureStatus }> => {
    setDb("starting", "Starting a temporary database with the demo cast…");
    try {
      const v = await d.demo({ where, dir, log });
      if (!v) {
        status.database = null;
        log("No approved demo cast: the flow runs against whatever the build points at — use a demo account, never real friends.");
        return null;
      }
      setDb("ready", where === "eas" ? "Ready, reachable by EAS through a short-lived tunnel." : `Ready on this machine (${where === "android" ? "10.0.2.2 from the emulator" : "127.0.0.1"}).`);
      return v;
    } catch (err) {
      const f = demoFailure(err);
      const msg = (err as Error).message.slice(0, 400);
      setDb("failed", msg, f.hints);
      return { failed: finish(false, `${msg}${f.hints.length ? ` ${f.hints.join(" ")}` : ""}`, 0, f.code) };
    }
  };
  try {
    if (d.mode === "off") return finish(false, "Captures can't run on this server.", 0, "off");
    log(i.reason === "new_version" ? "The app has a new version — capturing its screens again." : i.reason === "first_how_it_works" ? "Capturing real screens before the first How it works post." : "Capturing screens.");
    wd = await d.checkout();
    const plan = capturePlan({ repoPath: wd.dir, language: i.language, features: i.features });
    if (!plan.flow) return finish(false, "The app has no Maestro flow yet — day2 asked its build agent for one (Real screens ticket). Capture runs once that pull request is merged.", 0, "no_flow");
    let result: { set: CaptureSet | null; note: string; code?: CaptureFailure };
    if (d.mode === "local") {
      if (!d.local) return finish(false, "No simulator runner here.", 0, "device");
      let target: Target | { skip: string } = i.bundleId ? await d.local.target("ios") : { skip: "the app has no iOS bundle id" };
      if ("skip" in target && i.packageName) {
        log(`iPhone Simulator: ${target.skip} — trying the Android emulator.`);
        target = await d.local.target("android");
      }
      if ("skip" in target) return finish(false, target.skip, 0, "device");
      const t = target;
      const opened = await openDemo(t.platform === "ios" ? "ios" : "android", wd.dir);
      if (opened && "failed" in opened) return opened.failed;
      demo = opened;
      const secretEnv: Record<string, string> = demo?.login ? { [LOGIN_ENV.email]: demo.login.email, [LOGIN_ENV.password]: demo.login.password } : {};
      log(`${t.device}: building the demo version of the app (this takes a while the first time)…`);
      const built = await t.build(wd.dir, buildEnvOf(demo));
      if ("error" in built) return finish(false, built.error, 0, "device");
      await t.uninstall();
      await t.install(built.app);
      log(`${t.device}: running the flow in ${plan.locale}…`);
      const id = t.platform === "ios" ? i.bundleId! : i.packageName!;
      result = await captureMoments({ appId: i.appId, repoPath: wd.dir, bundleId: id, plan, secretEnv, aiContent: demo?.ai ?? null, mode: "local" }, { device: async () => ({ id: t.id, name: t.device, platform: t.platform, run: d.local!.run }), flow: d.local.flow, now });
    } else {
      if (!d.eas) return finish(false, "EAS isn't set up here.", 0, "off");
      if (!(await d.eas.expoToken())) return finish(false, "Connect the app's Expo account (Connect your stores) to capture on EAS.", 0, "no_token");
      const opened = await openDemo("eas", wd.dir);
      if (opened && "failed" in opened) return opened.failed;
      demo = opened;
      const secretEnv: Record<string, string> = demo?.login ? { [LOGIN_ENV.email]: demo.login.email, [LOGIN_ENV.password]: demo.login.password } : {};
      result = await easCapture({ appId: i.appId, dir: wd.dir, plan, demo, secretEnv, log, now: now() }, d);
    }
    if (!result.set) return finish(false, result.note, 0, result.code ?? "other");
    return finish(true, `Captured ${result.set.screens.length} screens in ${plan.locale}. Posts use them from now on.`, result.set.screens.length);
  } catch (err) {
    return finish(false, `The capture stopped: ${(err as Error).message.slice(0, 200)}`);
  } finally {
    if (demo?.close) {
      await demo.close().catch((err: Error) => log(`Removing the temporary database failed (${err.message.slice(0, 120)}) — day2's janitor removes it within two hours.`));
      if (status.database?.state === "ready") setDb("removed", "Stopped and deleted after the run (nothing kept but the screenshots).");
    }
    await wd?.done().catch(() => {});
    await d.after?.().catch(() => {});
    running.delete(i.appId);
  }
}

/** Pure. The demo build's environment: the demo flag, and this run's database address and public key. */
export function buildEnvOf(demo: Pick<DemoValues, "url" | "key"> | null): Record<string, string> {
  return demo ? { EXPO_PUBLIC_DAY2_DEMO: "1", EXPO_PUBLIC_SUPABASE_URL: demo.url, EXPO_PUBLIC_SUPABASE_KEY: demo.key } : { EXPO_PUBLIC_DAY2_DEMO: "1" };
}

async function easCapture(o: { appId: string; dir: string; plan: ReturnType<typeof capturePlan>; demo: DemoValues | null; secretEnv: Record<string, string>; log: (t: string) => void; now: Date }, d: CaptureRunDeps): Promise<{ set: CaptureSet | null; note: string; code?: CaptureFailure }> {
  if (!d.eas) return { set: null, note: "EAS isn't set up here.", code: "off" };
  const token = await d.eas.expoToken();
  if (!token) return { set: null, note: "Connect the app's Expo account (Connect your stores) to capture on EAS.", code: "no_token" };
  if (!o.demo) return { set: null, note: "An EAS capture needs the approved demo cast in a temporary database — approve the cast first.", code: "no_demo" };
  const eas = d.eas;
  const created: string[] = [];
  try {
    return await easRun(o, d, token, created);
  } finally {
    // The run's login doesn't outlive the run on EAS either.
    for (const name of created) await eas.run(["npx", "--yes", `eas-cli@${EAS_CLI_VERSION}`, "env:delete", "--variable-name", name, "--variable-environment", "preview", "--scope", "project", "--non-interactive"], { cwd: o.dir, env: childEnv(token) }).catch(() => undefined);
  }
}

async function easRun(o: { appId: string; dir: string; plan: ReturnType<typeof capturePlan>; demo: DemoValues | null; secretEnv: Record<string, string>; log: (t: string) => void; now: Date }, d: CaptureRunDeps, token: string, created: string[]): Promise<{ set: CaptureSet | null; note: string; code?: CaptureFailure }> {
  if (!d.eas || !o.demo) return { set: null, note: "EAS isn't set up here.", code: "off" };
  const cli = `eas-cli@${EAS_CLI_VERSION}`;
  const env = childEnv(token);
  const redact = (s: string) => [token, ...Object.values(o.secretEnv)].reduce((t, v) => (v ? t.split(v).join("[hidden]") : t), s);
  const easPath = join(o.dir, "eas.json");
  writeFileSync(easPath, withDemoProfile(existsSync(easPath) ? readFileSync(easPath, "utf-8") : null, o.demo));
  mkdirSync(join(o.dir, ".eas", "workflows"), { recursive: true });
  writeFileSync(join(o.dir, CAPTURE_WORKFLOW), captureWorkflowYaml({ flow: o.plan.flow!, record: o.plan.record }));
  // The login as secret EAS variables of the job's environment — not in the uploaded files.
  for (const [name, value] of Object.entries(o.secretEnv)) {
    created.push(name);
    const r = await d.eas.run(["npx", "--yes", cli, "env:create", "--name", name, "--value", value, "--environment", "preview", "--visibility", "secret", "--scope", "project", "--force", "--non-interactive"], { cwd: o.dir, env });
    if (r.code !== 0) return { set: null, note: `EAS didn't take the demo login: ${redact(`${r.stderr}\n${r.stdout}`).trim().split("\n").slice(-3).join(" ").slice(0, 300)}` };
  }
  o.log("Running the capture on EAS (a simulator build, then Maestro)…");
  const r = await d.eas.run(["npx", "--yes", cli, "workflow:run", CAPTURE_WORKFLOW, "--wait", "--json", "--non-interactive"], { cwd: o.dir, env: { ...env, EAS_NO_VCS: "1" }, timeoutMs: 90 * 60_000 });
  let run: { id?: string; status?: string; url?: string } = {};
  try {
    run = JSON.parse(r.stdout) as typeof run;
  } catch {
    /* not JSON: didn't start */
  }
  if (!run.id) return { set: null, note: `The EAS run didn't start: ${redact(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300)}` };
  o.log(`EAS run ${run.id} ended as ${run.status ?? "unknown"}; fetching the screenshots…`);
  const view = await d.eas.run(["npx", "--yes", cli, "workflow:view", run.id, "--json", "--non-interactive"], { cwd: o.dir, env });
  let links: string[] = [];
  try {
    links = artifactLinks(JSON.parse(view.stdout));
  } catch {
    links = [];
  }
  if (!links.length) return { set: null, note: `EAS ran the flow${run.url ? ` (${run.url})` : ""}, but day2 couldn't fetch its screenshots (the "${ARTIFACT}" artifact). Capture on your Mac instead, or upload screenshots.`, code: "artifact" };
  const tmp = mkdtempSync(join(tmpdir(), "day2-eas-shots-"));
  try {
    const download = d.eas.download ?? safeDownload;
    try {
      for (const [k, url] of links.entries()) {
        const file = join(tmp, `a${k}${/\.png(\?|$)/i.test(url) ? ".png" : /\.zip(\?|$)/i.test(url) ? ".zip" : ".tgz"}`);
        await download(url, file, { tool: "eas", kind: "image", maxBytes: 100 * 1024 * 1024 });
        if (!file.endsWith(".png")) await unpack(file, join(tmp, `x${k}`), d.eas.run);
      }
    } catch (err) {
      return { set: null, note: `EAS ran the flow, but downloading its screenshots failed (${(err as Error).message.slice(0, 160)}).`, code: "artifact" };
    }
    const r = importScreens({ appId: o.appId, plan: o.plan, dir: tmp, device: "EAS iOS Simulator", at: o.now, aiContent: o.demo.ai ?? null, mode: "eas" });
    return r.set ? r : { ...r, code: "artifact" };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Unpacks a downloaded archive: only regular files, no absolute paths or "..", PNGs only kept. */
async function unpack(file: string, out: string, run: NonNullable<CaptureRunDeps["eas"]>["run"]): Promise<void> {
  mkdirSync(out, { recursive: true });
  const zip = file.endsWith(".zip");
  const list = await run(zip ? ["unzip", "-Z1", file] : ["tar", "-tzf", file], { cwd: out, env: {} });
  if (list.code !== 0) return;
  const names = list.stdout.split("\n").map((x) => x.trim()).filter(Boolean);
  if (names.some((n) => n.startsWith("/") || n.split("/").includes(".."))) throw new Error("the EAS artifact has unsafe paths");
  const pngs = names.filter((n) => /\.png$/i.test(n)).slice(0, 40);
  if (!pngs.length) return;
  await run(zip ? ["unzip", "-o", "-q", file, ...pngs, "-d", out] : ["tar", "-xzf", file, "--no-same-owner", "--no-same-permissions", "-C", out, ...pngs], { cwd: out, env: {} });
}

export { localeFor, loadCaptureSet };
