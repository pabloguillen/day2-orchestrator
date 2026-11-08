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
 *  - local: this Mac's iPhone Simulator (or Android emulator) — the demo
 *    build (the demo backend's public address in its environment), then
 *    the app's Maestro flow with the demo login in Maestro's environment;
 *  - eas: an EAS workflow — a simulator build with the demo profile and
 *    EAS's Maestro job, its screenshots uploaded as an artifact that day2
 *    downloads (SSRF-checked). The artifact download is built from the
 *    workflow docs and `eas workflow:view --json`, whose artifact shape is
 *    undocumented; when no link comes back day2 says so and the Mac path
 *    stays the way to capture.
 *
 * Triggers: the Capture screens button, a new app version (the capture
 * goes stale), and before the first How it works post.
 */

export type CaptureMode = "local" | "eas" | "off";
export type CaptureStatus = { state: "idle" | "running" | "done" | "failed"; mode: CaptureMode | null; reason: CaptureReason | null; startedAt: string | null; finishedAt: string | null; note: string | null; screens: number; log: Array<{ at: string; text: string }> };
export type CaptureReason = "button" | "new_version" | "first_how_it_works";

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
  return { mode: "off", why: "This server has no iPhone Simulator. Run day2 on your Mac (with Xcode and Maestro), or set DAY2_CAPTURE=eas to capture on EAS.", maestro };
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

export type CaptureRunDeps = {
  mode: CaptureMode;
  /** A clean checkout of the app's main branch (and how to drop it). */
  checkout: () => Promise<{ dir: string; done: () => Promise<void> }>;
  /** The demo backend's public values and the login, or null (no demo backend: the flow must work without). */
  demo: () => Promise<{ url: string; key: string; login: { email: string; password: string } | null; ai: CaptureSet["aiContent"] } | null>;
  local?: { target: (p: "ios" | "android") => Promise<Target | { skip: string }>; flow: Parameters<typeof captureMoments>[1]["flow"]; run: (cmd: string[]) => Promise<{ code: number }> };
  eas?: { expoToken: () => Promise<string | null>; run: (cmd: string[], o: { cwd: string; env: Record<string, string>; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>; download?: typeof safeDownload };
  /** After a capture: e.g. pause the demo project. */
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
  const finish = (ok: boolean, note: string, screens = 0) => {
    status.state = ok ? "done" : "failed";
    status.note = note;
    status.screens = screens;
    status.finishedAt = now().toISOString();
    log(note);
    return status;
  };
  saveStatus(i.appId, status);
  let wd: { dir: string; done: () => Promise<void> } | null = null;
  try {
    if (d.mode === "off") return finish(false, "Captures can't run on this server.");
    log(i.reason === "new_version" ? "The app has a new version — capturing its screens again." : i.reason === "first_how_it_works" ? "Capturing real screens before the first How it works post." : "Capturing screens.");
    wd = await d.checkout();
    const plan = capturePlan({ repoPath: wd.dir, language: i.language, features: i.features });
    if (!plan.flow) return finish(false, "The app has no Maestro flow yet — day2 asked its build agent for one (Real screens ticket). Capture runs once that pull request is merged.");
    const demo = await d.demo();
    if (!demo) log("No demo backend: the flow runs against whatever the build points at — use a demo account, never real friends.");
    const secretEnv: Record<string, string> = demo?.login ? { [LOGIN_ENV.email]: demo.login.email, [LOGIN_ENV.password]: demo.login.password } : {};
    const buildEnv: Record<string, string> = demo ? { EXPO_PUBLIC_DAY2_DEMO: "1", EXPO_PUBLIC_SUPABASE_URL: demo.url, EXPO_PUBLIC_SUPABASE_KEY: demo.key } : { EXPO_PUBLIC_DAY2_DEMO: "1" };
    let result: { set: CaptureSet | null; note: string };
    if (d.mode === "local") {
      if (!d.local) return finish(false, "No simulator runner here.");
      let target: Target | { skip: string } = i.bundleId ? await d.local.target("ios") : { skip: "the app has no iOS bundle id" };
      if ("skip" in target && i.packageName) {
        log(`iPhone Simulator: ${target.skip} — trying the Android emulator.`);
        target = await d.local.target("android");
      }
      if ("skip" in target) return finish(false, target.skip);
      const t = target;
      log(`${t.device}: building the demo version of the app (this takes a while the first time)…`);
      const built = await t.build(wd.dir, buildEnv);
      if ("error" in built) return finish(false, built.error);
      await t.uninstall();
      await t.install(built.app);
      log(`${t.device}: running the flow in ${plan.locale}…`);
      const id = t.platform === "ios" ? i.bundleId! : i.packageName!;
      result = await captureMoments({ appId: i.appId, repoPath: wd.dir, bundleId: id, plan, secretEnv, aiContent: demo?.ai ?? null, mode: "local" }, { device: async () => ({ id: t.id, name: t.device, platform: t.platform, run: d.local!.run }), flow: d.local.flow, now });
    } else {
      result = await easCapture({ appId: i.appId, dir: wd.dir, plan, demo, secretEnv, log, now: now() }, d);
    }
    if (!result.set) return finish(false, result.note);
    return finish(true, `Captured ${result.set.screens.length} screens in ${plan.locale}. Posts use them from now on.`, result.set.screens.length);
  } catch (err) {
    return finish(false, `The capture stopped: ${(err as Error).message.slice(0, 200)}`);
  } finally {
    await wd?.done().catch(() => {});
    await d.after?.().catch(() => {});
    running.delete(i.appId);
  }
}

async function easCapture(o: { appId: string; dir: string; plan: ReturnType<typeof capturePlan>; demo: Awaited<ReturnType<CaptureRunDeps["demo"]>>; secretEnv: Record<string, string>; log: (t: string) => void; now: Date }, d: CaptureRunDeps): Promise<{ set: CaptureSet | null; note: string }> {
  if (!d.eas) return { set: null, note: "EAS isn't set up here." };
  const token = await d.eas.expoToken();
  if (!token) return { set: null, note: "Connect the app's Expo account (Connect your stores) to capture on EAS." };
  if (!o.demo) return { set: null, note: "Set up the demo backend first — an EAS capture always uses it." };
  const cli = `eas-cli@${EAS_CLI_VERSION}`;
  const env = childEnv(token);
  const redact = (s: string) => [token, ...Object.values(o.secretEnv)].reduce((t, v) => (v ? t.split(v).join("[hidden]") : t), s);
  const easPath = join(o.dir, "eas.json");
  writeFileSync(easPath, withDemoProfile(existsSync(easPath) ? readFileSync(easPath, "utf-8") : null, o.demo));
  mkdirSync(join(o.dir, ".eas", "workflows"), { recursive: true });
  writeFileSync(join(o.dir, CAPTURE_WORKFLOW), captureWorkflowYaml({ flow: o.plan.flow!, record: o.plan.record }));
  // The login as secret EAS variables of the job's environment — not in the uploaded files.
  for (const [name, value] of Object.entries(o.secretEnv)) {
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
  if (!links.length) return { set: null, note: `EAS ran the flow${run.url ? ` (${run.url})` : ""}, but day2 couldn't fetch its screenshots (the "${ARTIFACT}" artifact). Capture on your Mac instead, or upload screenshots.` };
  const tmp = mkdtempSync(join(tmpdir(), "day2-eas-shots-"));
  try {
    const download = d.eas.download ?? safeDownload;
    for (const [k, url] of links.entries()) {
      const file = join(tmp, `a${k}${/\.png(\?|$)/i.test(url) ? ".png" : /\.zip(\?|$)/i.test(url) ? ".zip" : ".tgz"}`);
      await download(url, file, { tool: "eas", kind: "image", maxBytes: 100 * 1024 * 1024 });
      if (!file.endsWith(".png")) await unpack(file, join(tmp, `x${k}`), d.eas.run);
    }
    return importScreens({ appId: o.appId, plan: o.plan, dir: tmp, device: "EAS iOS Simulator", at: o.now, aiContent: o.demo.ai ?? null, mode: "eas" });
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
