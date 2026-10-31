import type { AppConfig, Eas } from "./adapters";
import type { ExpoCredential } from "./credentials";
import type { Platform } from "./types";

/**
 * Expo Application Services through the eas CLI (and the expo CLI), run as
 * subprocesses in an app checkout. Checked against eas-cli 27.2.0's source.
 *
 * - Auth: EXPO_TOKEN in the child's environment, never in argv. Errors are
 *   redacted, so the token can't leak into logs or the console.
 * - The child gets a small allowlisted environment (PATH, HOME, proxy and CA
 *   settings, …), not day2's own: `expo config` evaluates the customer's
 *   app.config.js. EXPO_TOKEN goes only to eas commands. EAS_NO_VCS stays
 *   unset: checkouts are git repos, and eas reads commit hashes from them.
 * - `--json` makes eas print JSON alone on stdout (logs go to stderr); the
 *   parser still skips anything before the first `[` / `{` that parses.
 * - build:view and submit:view need a project directory (they read the
 *   project id from the app config), but build_status/submit_status get only
 *   an id: they run in the checkout that started the build/submission (or the
 *   last one used); with none known (e.g. after a restart) they ask the EAS
 *   GraphQL API directly, the same query the CLI makes.
 */

export type Runner = (cmd: string[], o: { cwd: string; env: Record<string, string> }) => Promise<{ code: number; stdout: string; stderr: string }>;

export type EasDeps = {
  run?: Runner;
  /** The eas executable. Default: "eas" when it's on PATH, else `npx --yes eas-cli@27.2.0`. */
  bin?: string;
  /** EAS environment for server-side env vars (eas update / fingerprint:generate). Default "production". */
  environment?: string;
  /** For the status fallback through EAS's GraphQL API. */
  fetch?: typeof fetch;
};

export const EAS_CLI_VERSION = "27.2.0";
const EXPO_GRAPHQL = "https://api.expo.dev/graphql";
const TIMEOUT_MS = 30 * 60_000;
const ERROR_TAIL_LINES = 12;
const REVERT_MESSAGE = "Rolled back by day2";

export class EasError extends Error {
  constructor(
    message: string,
    public kind: "failed" | "credentials" | "rollout_active" | "not_latest" | "bad_output" = "failed",
  ) {
    super(`EAS: ${message}`);
  }
}

const ENV_ALLOW = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ", "TMPDIR",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "npm_config_cache", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
];

export function childEnv(token: string | null, base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOW) {
    const v = base[k];
    if (typeof v === "string") env[k] = v;
  }
  env.CI = "1";
  env.EXPO_NO_TELEMETRY = "1";
  if (token) env.EXPO_TOKEN = token;
  return env;
}

export const bunRunner: Runner = async (cmd, o) => {
  const proc = Bun.spawn(cmd, { cwd: o.cwd, env: o.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

export function redactToken(text: string, token: string): string {
  return token ? text.split(token).join("[redacted]") : text;
}

/** The JSON value in a command's stdout, skipping leading (and trailing) non-JSON noise. */
export function parseJsonOutput(stdout: string): unknown {
  const text = stripAnsi(stdout).trim();
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }
  const lastClose = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  let tries = 0;
  for (let i = 0; i < text.length && tries < 500; i++) {
    const c = text[i];
    if (c !== "{" && c !== "[") continue;
    tries++;
    const closer = c === "{" ? "}" : "]";
    for (const end of [text.length, text.lastIndexOf(closer) + 1, lastClose + 1]) {
      if (end <= i) continue;
      try {
        return JSON.parse(text.slice(i, end));
      } catch {
        // try the next candidate
      }
    }
  }
  throw new Error("no JSON in the output");
}

const tail = (s: string, n = ERROR_TAIL_LINES) =>
  stripAnsi(s)
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "")
    .slice(-n)
    .join("\n");

const CREDENTIALS_MISSING =
  /credentials are not set up|cannot be set up in --non-interactive mode|run this command again in interactive mode|ASC API key is required in non-interactive mode|couldn't find any credentials/i;
const ROLLOUT_ACTIVE = /another rollout is in progress|cannot supersede the rollout in progress|rollout is in progress for runtime version/i;
const NOT_A_ROLLOUT = /is not a rollout update group|not a rollout/i;
const NOT_LATEST = /is not the latest update on branch/i;
const SUBMISSION_ID = /\/submissions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export const BUILD_STATUS: Record<string, "queued" | "in_progress" | "finished" | "errored" | "canceled"> = {
  NEW: "queued",
  IN_QUEUE: "queued",
  IN_PROGRESS: "in_progress",
  PENDING_CANCEL: "in_progress",
  FINISHED: "finished",
  ERRORED: "errored",
  CANCELED: "canceled",
};

export const SUBMIT_STATUS: Record<string, "in_queue" | "in_progress" | "finished" | "errored" | "canceled"> = {
  AWAITING_BUILD: "in_queue",
  IN_QUEUE: "in_queue",
  IN_PROGRESS: "in_progress",
  FINISHED: "finished",
  ERRORED: "errored",
  CANCELED: "canceled",
};

/** runtimeVersion from the app config → its policy ("custom" for a fixed string). */
export function runtimePolicyOf(rv: unknown): string | null {
  if (typeof rv === "string" && rv !== "") return "custom";
  const p = obj(rv).policy;
  return typeof p === "string" && p !== "" ? p : null;
}

export function createEas(cred: ExpoCredential, deps: EasDeps = {}): Eas {
  const run = deps.run ?? bunRunner;
  const environment = deps.environment ?? "production";
  const doFetch = deps.fetch ?? fetch;
  const token = cred.token;
  const workdirOf = new Map<string, string>();
  let lastWorkdir: string | null = null;

  let easBin: string[] | null = deps.bin ? [deps.bin] : null;
  const eas = (): string[] => {
    if (!easBin) easBin = Bun.which("eas") ? ["eas"] : ["npx", "--yes", `eas-cli@${EAS_CLI_VERSION}`];
    return easBin;
  };

  const clean = (s: string) => redactToken(s, token);

  async function exec(cmd: string[], cwd: string, withToken: boolean, label: string) {
    if (token && cmd.some((a) => a.includes(token))) throw new EasError(`refusing to put the Expo token on a command line (${label})`);
    let r: Awaited<ReturnType<Runner>>;
    try {
      r = await run(cmd, { cwd, env: childEnv(withToken ? token : null) });
    } catch (e) {
      throw new EasError(`couldn't run \`${label}\`: ${clean(e instanceof Error ? e.message : String(e))}`);
    }
    return { code: r.code, stdout: clean(r.stdout ?? ""), stderr: clean(r.stderr ?? "") };
  }

  function failure(label: string, r: { code: number; stdout: string; stderr: string }): EasError {
    const out = tail(r.stderr) || tail(r.stdout);
    const all = `${r.stderr}\n${r.stdout}`;
    if (CREDENTIALS_MISSING.test(all)) {
      const how = label.startsWith("eas submit")
        ? "Run eas submit once on your computer so EAS stores the store upload credentials (App Store Connect API key / Google service account key)."
        : "Run eas build once on your computer so EAS stores the signing credentials.";
      return new EasError(`\`${label}\` needs credentials EAS doesn't have yet. ${how}\n${out}`, "credentials");
    }
    return new EasError(`\`${label}\` failed (exit ${r.code})${out ? `:\n${out}` : ""}`);
  }

  async function easRun(workdir: string, args: string[]) {
    lastWorkdir = workdir;
    const label = `eas ${args[0]}`;
    const r = await exec([...eas(), ...args], workdir, true, label);
    return { ...r, label };
  }

  async function easJson(workdir: string, args: string[]): Promise<unknown> {
    const r = await easRun(workdir, args);
    if (r.code !== 0) throw failure(r.label, r);
    return parseOut(r.label, r.stdout);
  }

  function parseOut(label: string, stdout: string): unknown {
    try {
      return parseJsonOutput(stdout);
    } catch {
      throw new EasError(`\`${label}\` printed no JSON: ${tail(stdout, 5) || "(empty output)"}`, "bad_output");
    }
  }

  async function npxJson(workdir: string, args: string[]): Promise<unknown> {
    // --no: never download a package that isn't in the checkout's node_modules.
    const label = `npx ${args.slice(0, 2).join(" ")}`;
    const r = await exec(["npx", "--no", ...args], workdir, false, label);
    if (r.code !== 0) throw failure(label, r);
    return parseOut(label, r.stdout);
  }

  async function graphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await doFetch(EXPO_GRAPHQL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, variables }),
      });
    } catch (e) {
      throw new EasError(`couldn't reach the EAS API: ${clean(e instanceof Error ? e.message : String(e))}`);
    }
    const text = clean(await res.text());
    let body: { data?: unknown; errors?: Array<{ message?: string }> };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new EasError(`the EAS API answered ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!res.ok || body.errors?.length) throw new EasError(`the EAS API answered ${res.status}: ${body.errors?.map((e) => e.message).join("; ") || text.slice(0, 300)}`);
    return obj(body.data);
  }

  const statusWorkdir = (id: string) => workdirOf.get(id) ?? lastWorkdir;

  return {
    async appConfig(workdir) {
      const c = obj(await npxJson(workdir, ["expo", "config", "--json", "--type", "public"]));
      const ios = obj(c.ios);
      const android = obj(c.android);
      const updates = obj(c.updates);
      const version = str(c.version);
      if (!version) throw new EasError("the app config has no version (expo.version in app.json / app.config).", "bad_output");
      return {
        version,
        bundleId: str(ios.bundleIdentifier),
        packageName: str(android.package),
        runtimePolicy: runtimePolicyOf(c.runtimeVersion) ?? runtimePolicyOf(ios.runtimeVersion) ?? runtimePolicyOf(android.runtimeVersion),
        hasUpdates: updates.enabled !== false && Boolean(str(updates.url)),
      } satisfies AppConfig;
    },

    async runtimeVersion(workdir, platform) {
      const r = obj(await npxJson(workdir, ["expo-updates", "runtimeversion:resolve", "--platform", platform]));
      return str(r.runtimeVersion);
    },

    async fingerprint(workdir, platform) {
      const r = obj(await easJson(workdir, ["fingerprint:generate", "--platform", platform, "--environment", environment, "--json", "--non-interactive"]));
      const hash = str(r.hash);
      if (!hash) throw new EasError("`eas fingerprint:generate` printed no hash.", "bad_output");
      return hash;
    },

    async latestStoreBuild(workdir, { platform, profile }) {
      const out = await easJson(workdir, [
        "build:list",
        "--platform", platform,
        "--status", "finished",
        "--distribution", "store",
        "--build-profile", profile,
        "--limit", "1",
        "--json",
        "--non-interactive",
      ]);
      const builds = (Array.isArray(out) ? out : []).map(obj);
      const b = builds.find((x) => (str(x.distribution) ?? "STORE").toUpperCase() === "STORE");
      if (!b || !str(b.id)) return null;
      return {
        id: str(b.id)!,
        runtimeVersion: str(obj(b.runtime).version),
        appVersion: str(b.appVersion),
        buildNumber: str(b.appBuildVersion),
        gitCommit: str(b.gitCommitHash),
      };
    },

    async publishUpdate(workdir, { branch, message, percent }) {
      if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new EasError(`a rollout share must be a whole percentage from 1 to 100 (got ${percent}).`);
      const args = ["update", "--branch", branch, "--message", message, "--platform", "all", "--environment", environment, "--json", "--non-interactive"];
      if (percent < 100) args.push("--rollout-percentage", String(percent));
      const r = await easRun(workdir, args);
      if (r.code !== 0) {
        if (ROLLOUT_ACTIVE.test(`${r.stderr}\n${r.stdout}`)) {
          throw new EasError(
            `an update is already rolling out on branch "${branch}" for this runtime version. Finish it (100%) or roll it back before publishing another.\n${tail(r.stderr) || tail(r.stdout)}`,
            "rollout_active",
          );
        }
        throw failure(r.label, r);
      }
      const out = parseOut(r.label, r.stdout);
      const updates = (Array.isArray(out) ? out : []).map(obj);
      const groupId = updates.map((u) => str(u.group)).find(Boolean);
      if (!groupId) throw new EasError("`eas update` printed no update group.", "bad_output");
      const updateIds: Partial<Record<Platform, string>> = {};
      for (const u of updates) {
        const p = str(u.platform);
        const id = str(u.id);
        if ((p === "ios" || p === "android") && id) updateIds[p] = id;
      }
      return { groupId, updateIds, runtimeVersion: updates.map((u) => str(u.runtimeVersion)).find(Boolean) ?? null };
    },

    async setRollout(workdir, { groupId, percent }) {
      if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new EasError(`a rollout share must be a whole percentage from 1 to 100 (got ${percent}).`);
      const r = await easRun(workdir, ["update:edit", groupId, "--rollout-percentage", String(percent), "--non-interactive", "--json"]);
      if (r.code === 0) return;
      // Finishing an update that's already served to everyone: nothing to do.
      if (percent === 100 && NOT_A_ROLLOUT.test(`${r.stderr}\n${r.stdout}`)) return;
      throw failure(r.label, r);
    },

    async revert(workdir, { branch, groupId }) {
      const r = await easRun(workdir, ["update:revert-update-rollout", "--group", groupId, "--non-interactive", "--message", REVERT_MESSAGE]);
      if (r.code === 0) return;
      if (!NOT_A_ROLLOUT.test(`${r.stderr}\n${r.stdout}`)) throw failure(r.label, r);
      // Not (or no longer) in a rollout: republish what ran before it.
      const rb = await easRun(workdir, ["update:rollback", groupId, "--non-interactive", "--message", REVERT_MESSAGE]);
      if (rb.code === 0) return;
      if (NOT_LATEST.test(`${rb.stderr}\n${rb.stdout}`)) {
        throw new EasError(
          `can't roll back update group ${groupId}: a newer update was published on branch "${branch}" after it, and only the latest update can be rolled back.\n${tail(rb.stderr) || tail(rb.stdout)}`,
          "not_latest",
        );
      }
      throw failure(rb.label, rb);
    },

    async build(workdir, { platform, profile, message }) {
      const out = await easJson(workdir, ["build", "--platform", platform, "--profile", profile, "--non-interactive", "--no-wait", "--json", "--message", message]);
      const id = str(obj(Array.isArray(out) ? out[0] : out).id);
      if (!id) throw new EasError("`eas build` printed no build id.", "bad_output");
      workdirOf.set(id, workdir);
      return { id };
    },

    async build_status(id) {
      let b: Record<string, unknown>;
      const wd = statusWorkdir(id);
      if (wd) {
        b = obj(await easJson(wd, ["build:view", id, "--json"]));
      } else {
        const data = await graphql("query BuildsByIdQuery($buildId: ID!) { builds { byId(buildId: $buildId) { id status appVersion appBuildVersion error { message } } } }", { buildId: id });
        b = obj(obj(data.builds).byId);
      }
      const raw = str(b.status)?.toUpperCase() ?? "";
      const status = BUILD_STATUS[raw];
      if (!status) throw new EasError(`build ${id} has an unknown status "${raw}".`, "bad_output");
      return { status, buildNumber: str(b.appBuildVersion), appVersion: str(b.appVersion), error: str(obj(b.error).message) };
    },

    async submit(workdir, { platform, buildId, profile }) {
      // eas submit has no --json: the id comes from the "Submission details" URL it prints.
      const r = await easRun(workdir, ["submit", "--platform", platform, "--id", buildId, "--profile", profile, "--non-interactive", "--no-wait"]);
      if (r.code !== 0) throw failure(r.label, r);
      let id = stripAnsi(`${r.stdout}\n${r.stderr}`).match(SUBMISSION_ID)?.[1] ?? null;
      if (!id) {
        const list = await easJson(workdir, ["submit:list", "--platform", platform, "--limit", "1", "--json", "--non-interactive"]);
        id = str(obj(Array.isArray(list) ? list[0] : null).id);
      }
      if (!id) throw new EasError("`eas submit` started, but its submission id couldn't be found.", "bad_output");
      workdirOf.set(id, workdir);
      return { id };
    },

    async submit_status(id) {
      let s: Record<string, unknown>;
      const wd = statusWorkdir(id);
      if (wd) {
        s = obj(await easJson(wd, ["submit:view", id, "--json"]));
      } else {
        const data = await graphql("query SubmissionsByIdQuery($submissionId: ID!) { submissions { byId(submissionId: $submissionId) { id status error { message } } } }", { submissionId: id });
        s = obj(obj(data.submissions).byId);
      }
      const raw = str(s.status)?.toUpperCase() ?? "";
      const status = SUBMIT_STATUS[raw];
      if (!status) throw new EasError(`submission ${id} has an unknown status "${raw}".`, "bad_output");
      return { status, error: str(obj(s.error).message) };
    },
  };
}
