import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { addApp, generateAppId, loadAppsRegistry, saveAppsRegistry, type AppEntry } from "./apps-registry";
import { authorize, CreditsError, creditsForCost, recordCharge, type CreditStore } from "./credits";
import { BACKLOG_FILENAME, createTicket, emptyBacklog, saveBacklog } from "./backlog";

/**
 * "Create a new app" — built with Lovable, run by day2.
 *
 * day2 has its own Lovable account; customers never need one. A build:
 *   1. creates a Lovable project from a build prompt day2 writes from the
 *      owner's description, audience and look & feel;
 *   2. waits for Lovable's agent — when it pauses for an approval (e.g.
 *      turning on a database), the owner decides in the console; day2 never
 *      approves on their behalf;
 *   3. exports the code at the finished commit, file by file, into a new
 *      git repo and pushes it to a private GitHub repo — the code is the
 *      owner's, with no lock-in to Lovable;
 *   4. registers the app, and charges the build to the account's credits.
 *
 * Talks to Lovable's MCP server (the only Lovable interface that can create
 * projects from a prompt). Lovable's own docs describe OAuth as the way to
 * connect; an operator connects day2's account once from the console and
 * the tokens are refreshed from then on. A `DAY2_LOVABLE_API_KEY`, if set,
 * is sent as a `Lovable-API-Key` header instead (a third-party guide
 * documents this for headless use; Lovable's docs don't confirm it yet).
 *
 * Cost: Lovable's MCP tools don't report credits used per build, so a build
 * is charged at an operator-set estimate (`DAY2_LOVABLE_CREDITS_PER_BUILD`
 * Lovable credits × `DAY2_LOVABLE_USD_PER_CREDIT`), then through the
 * `app_build` markup like everything else.
 */

export const LOVABLE_MCP_URL = process.env.DAY2_LOVABLE_MCP_URL ?? "https://mcp.lovable.dev";
export const LOVABLE_FILE = ".day2-lovable.json";
export const LOVABLE_BUILDS_FILE = ".day2-lovable-builds.json";

export function lovableCostUsd(): number {
  const perBuild = Number(process.env.DAY2_LOVABLE_CREDITS_PER_BUILD ?? 5);
  const usdPerCredit = Number(process.env.DAY2_LOVABLE_USD_PER_CREDIT ?? 0.6);
  return (Number.isFinite(perBuild) && perBuild > 0 ? perBuild : 5) * (Number.isFinite(usdPerCredit) && usdPerCredit > 0 ? usdPerCredit : 0.6);
}

/** What the console shows before a build ("≈ N credits"). */
export function estimateBuildCredits(): number {
  return creditsForCost(lovableCostUsd(), "app_build");
}

// ---------------------------------------------------------------------------
// Operator-level state: OAuth tokens, workspace
// ---------------------------------------------------------------------------

type LovableState = {
  workspaceId?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
  connectedAt?: string;
};

function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as T) : fallback;
}

function writeJson(file: string, data: unknown, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, mode ? { mode } : undefined);
  renameSync(tmp, file);
}

export class FileOAuthProvider implements OAuthClientProvider {
  pendingAuthorizationUrl: URL | null = null;
  constructor(
    private file: string,
    private callbackUrl: string,
  ) {}
  private load(): LovableState {
    return readJson<LovableState>(this.file, {});
  }
  private save(patch: Partial<LovableState>): void {
    writeJson(this.file, { ...this.load(), ...patch }, 0o600);
  }
  get redirectUrl() {
    return this.callbackUrl;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "day2",
      redirect_uris: [this.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state(): string {
    const s = randomUUID();
    this.save({ state: s });
    return s;
  }
  expectedState(): string | undefined {
    return this.load().state;
  }
  clientInformation() {
    return this.load().clientInformation;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.save({ clientInformation: info });
  }
  tokens() {
    return this.load().tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.save({ tokens, connectedAt: new Date().toISOString() });
  }
  redirectToAuthorization(url: URL) {
    this.pendingAuthorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.save({ codeVerifier: v });
  }
  codeVerifier() {
    const v = this.load().codeVerifier;
    if (!v) throw new Error("No OAuth code verifier saved — start connecting again.");
    return v;
  }
}

export type LovableSetup = { dir: string; callbackUrl: string };

function stateFile(setup: LovableSetup) {
  return join(setup.dir, LOVABLE_FILE);
}

export function lovableStatus(setup: LovableSetup) {
  const s = readJson<LovableState>(stateFile(setup), {});
  const apiKey = Boolean(process.env.DAY2_LOVABLE_API_KEY);
  return {
    connected: apiKey || Boolean(s.tokens?.access_token),
    method: apiKey ? ("api_key" as const) : s.tokens ? ("oauth" as const) : null,
    connectedAt: s.connectedAt ?? null,
    estimateCredits: estimateBuildCredits(),
  };
}

/** Starts the one-time OAuth connect for day2's own Lovable account and
 * returns the URL the operator opens. */
export async function beginConnect(setup: LovableSetup): Promise<{ authorizeUrl: string } | { connected: true }> {
  const provider = new FileOAuthProvider(stateFile(setup), setup.callbackUrl);
  const result = await auth(provider, { serverUrl: LOVABLE_MCP_URL });
  if (result === "AUTHORIZED") return { connected: true };
  if (!provider.pendingAuthorizationUrl) throw new Error("Lovable didn't return a sign-in address.");
  return { authorizeUrl: provider.pendingAuthorizationUrl.toString() };
}

export async function finishConnect(setup: LovableSetup, code: string, state: string | null): Promise<void> {
  const provider = new FileOAuthProvider(stateFile(setup), setup.callbackUrl);
  if (provider.expectedState() && state !== provider.expectedState()) throw new Error("The sign-in didn't match — start connecting again.");
  const result = await auth(provider, { serverUrl: LOVABLE_MCP_URL, authorizationCode: code });
  if (result !== "AUTHORIZED") throw new Error("Lovable didn't finish the sign-in.");
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

/** The few Lovable tools day2 uses — an interface so tests can fake it. */
export interface LovableTools {
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

function parseToolResult(result: { content?: unknown; structuredContent?: unknown; isError?: unknown }, name: string): Record<string, unknown> {
  const text = Array.isArray(result.content)
    ? (result.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n")
    : "";
  if (result.isError) throw new Error(`Lovable ${name}: ${text.slice(0, 400) || "failed"}`);
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent as Record<string, unknown>;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { text };
  }
}

export async function connectTools(setup: LovableSetup): Promise<LovableTools> {
  const apiKey = process.env.DAY2_LOVABLE_API_KEY;
  const transport = new StreamableHTTPClientTransport(
    new URL(LOVABLE_MCP_URL),
    apiKey ? { requestInit: { headers: { "Lovable-API-Key": apiKey } } } : { authProvider: new FileOAuthProvider(stateFile(setup), setup.callbackUrl) },
  );
  const client = new Client({ name: "day2", version: "1.0.0" });
  await client.connect(transport);
  return {
    async call(name, args) {
      return parseToolResult((await client.callTool({ name, arguments: args })) as never, name);
    },
    close: () => client.close(),
  };
}

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

export type BuildStatus = "building" | "needs_you" | "exporting" | "done" | "failed";

export type BuildRequest = { name: string; description: string; audience?: string; look?: string[] };

export type Build = {
  id: string;
  at: string;
  request: BuildRequest;
  status: BuildStatus;
  step: string;
  projectId?: string;
  messageId?: string;
  threadId?: string;
  previewUrl?: string;
  /** A Lovable approval waiting on the owner. */
  awaiting?: { eventId: string; toolId: string; params: unknown; secure: boolean };
  appId?: string;
  githubRepo?: string;
  skippedFiles?: number;
  credits?: number;
  error?: string;
  updatedAt: string;
};

const LOOKS = ["Calm", "Playful", "Bold", "Minimal", "Professional"];

export function validateBuildRequest(raw: unknown): { ok: true; request: BuildRequest } | { ok: false; reason: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const description = typeof r.description === "string" ? r.description.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(name)) return { ok: false, reason: "Name it with lowercase letters, numbers and dashes (3–50 characters), like habit-loop." };
  if (description.length < 20) return { ok: false, reason: "Describe what the app should do in a sentence or two." };
  if (description.length > 4000) return { ok: false, reason: "Keep the description under 4,000 characters." };
  const look = Array.isArray(r.look) ? r.look.filter((l): l is string => typeof l === "string" && LOOKS.includes(l)) : [];
  const audience = typeof r.audience === "string" && r.audience.trim() ? r.audience.trim().slice(0, 300) : undefined;
  return { ok: true, request: { name, description, ...(audience ? { audience } : {}), ...(look.length ? { look } : {}) } };
}

/** The prompt Lovable builds from — the owner's words, plus what day2
 * needs to look after the app afterwards. */
export function buildPrompt(r: BuildRequest): string {
  return [
    `Build "${r.name}": ${r.description}`,
    r.audience ? `It's for: ${r.audience}.` : "",
    r.look?.length ? `Look and feel: ${r.look.join(", ").toLowerCase()}.` : "",
    "Keep the first version small and working end to end: the core flow, sign-in if it needs accounts, and clear empty states.",
    "Use clear component and file names and include a short README describing the app's main features — another engineer will maintain this code.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function loadBuilds(setup: LovableSetup): Build[] {
  return readJson<Build[]>(join(setup.dir, LOVABLE_BUILDS_FILE), []);
}

function saveBuild(setup: LovableSetup, build: Build): Build {
  const all = loadBuilds(setup).filter((b) => b.id !== build.id);
  const next = { ...build, updatedAt: new Date().toISOString() };
  writeJson(join(setup.dir, LOVABLE_BUILDS_FILE), [next, ...all].slice(0, 50));
  return next;
}

const str = (o: Record<string, unknown> | undefined, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
};

type AgentState = { done: boolean; failed?: string; awaiting?: Build["awaiting"] };

/** Reads the agent's state from a create_project / get_message result. */
export function agentState(result: Record<string, unknown>): AgentState {
  const response = (result.response ?? result.agent_response) as Record<string, unknown> | undefined;
  const status = str(response, "status");
  if (status === "completed") return { done: true };
  if (status === "error" || status === "stopped") return { done: false, failed: str(response, "error", "message") ?? `Lovable's agent ${status === "error" ? "hit an error" : "stopped"}.` };
  if (status === "awaiting_input") {
    const a = response?.awaiting_input as Record<string, unknown> | undefined;
    if (!a) return { done: false, failed: "Lovable is waiting on a check-in that can only be answered in Lovable's editor." };
    return { done: false, awaiting: { eventId: String(a.event_id ?? ""), toolId: String(a.tool_id ?? "tool"), params: a.params ?? null, secure: a.requires_secure_form === true } };
  }
  return { done: false };
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|avif|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|lockb)$/i;

export type BuildDeps = {
  tools: () => Promise<LovableTools>;
  /** Where the exported repo goes (managed-repos/<id>). */
  repoDir: (appId: string) => string;
  /** Creates a private GitHub repo from the folder and pushes; returns
   * "owner/name" or null when GitHub isn't available on this machine. */
  pushToGitHub: (dir: string, name: string) => Promise<string | null>;
  registryPath: string;
  credits: CreditStore;
  pollMs?: number;
  maxWaitMs?: number;
};

export async function defaultPushToGitHub(dir: string, name: string): Promise<string | null> {
  const authed = await $`gh auth status`.quiet().nothrow();
  if (authed.exitCode !== 0) return null;
  // DAY2_GITHUB_OWNER puts new app repos under an organization (or another
  // account the signed-in gh user can create repos in); default: the
  // signed-in user's own account.
  const owner = process.env.DAY2_GITHUB_OWNER?.trim();
  const full = owner ? `${owner}/${name}` : name;
  const res = await $`gh repo create ${full} --private --source ${dir} --push`.cwd(dir).quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`Couldn't create the GitHub repo: ${res.stderr.toString().slice(0, 300)}`);
  const view = await $`gh repo view --json nameWithOwner`.cwd(dir).quiet().nothrow();
  return view.exitCode === 0 ? (JSON.parse(view.stdout.toString()) as { nameWithOwner: string }).nameWithOwner : full;
}

/**
 * Starts a build: checks plan, slot and credits up front, records it, and
 * runs the rest in the background. Throws `CreditsError` when credits or
 * the plan don't allow it.
 */
export async function startBuild(setup: LovableSetup, request: BuildRequest, deps: BuildDeps): Promise<Build> {
  const check = await authorize(deps.credits, { appId: null, service: "app_build", maxCostUsd: lovableCostUsd() });
  if (!check.ok) throw new CreditsError(check);
  if (!lovableStatus(setup).connected) throw new Error("day2's Lovable account isn't connected yet — the operator connects it once on this page.");
  if (loadAppsRegistry(deps.registryPath).apps.some((a) => a.name === request.name)) throw new Error(`There's already an app called "${request.name}".`);
  const now = new Date().toISOString();
  const build = saveBuild(setup, { id: `build-${randomUUID().slice(0, 8)}`, at: now, request, status: "building", step: "Lovable is building the first version", updatedAt: now });
  void continueBuild(setup, build.id, deps, check.maxCredits).catch((err) => {
    saveBuild(setup, { ...getBuild(setup, build.id)!, status: "failed", error: (err as Error).message });
  });
  return build;
}

export function getBuild(setup: LovableSetup, id: string): Build | undefined {
  return loadBuilds(setup).find((b) => b.id === id);
}

/** The owner's decision on a paused Lovable step. */
export async function answerBuild(setup: LovableSetup, id: string, decision: "approved" | "rejected", deps: BuildDeps): Promise<Build> {
  const b = getBuild(setup, id);
  if (!b) throw new Error("No such build.");
  if (b.status !== "needs_you" || !b.awaiting || !b.projectId || !b.messageId) throw new Error("This build isn't waiting on you.");
  if (b.awaiting.secure) throw new Error("This step needs a secret entered in Lovable's editor — the day2 operator has to finish it there.");
  const tools = await deps.tools();
  try {
    await tools.call("respond_to_approval", { project_id: b.projectId, message_id: b.messageId, event_id: b.awaiting.eventId, decision, wait: false });
  } finally {
    await tools.close();
  }
  const next = saveBuild(setup, { ...b, status: "building", awaiting: undefined, step: "Lovable is building the first version" });
  void continueBuild(setup, id, deps, null).catch((err) => saveBuild(setup, { ...getBuild(setup, id)!, status: "failed", error: (err as Error).message }));
  return next;
}

async function continueBuild(setup: LovableSetup, id: string, deps: BuildDeps, maxCredits: number | null): Promise<void> {
  const pollMs = deps.pollMs ?? 10_000;
  const deadline = Date.now() + (deps.maxWaitMs ?? 25 * 60_000);
  let b = getBuild(setup, id)!;
  const tools = await deps.tools();
  try {
    // 1. Create the project (first time only).
    if (!b.projectId) {
      const workspaceId = readJson<LovableState>(stateFile(setup), {}).workspaceId;
      const created = await tools.call("create_project", { initial_message: buildPrompt(b.request), wait: false, ...(workspaceId ? { workspace_id: workspaceId } : {}) });
      const projectId = str(created, "projectId", "project_id", "id");
      if (!projectId) {
        const ws = created.available_workspaces;
        throw new Error(Array.isArray(ws) ? "day2's Lovable account has several workspaces — set workspaceId in .day2-lovable.json." : "Lovable didn't return a project.");
      }
      const agent = (created.agent_response ?? {}) as Record<string, unknown>;
      b = saveBuild(setup, {
        ...b,
        projectId,
        messageId: str(created, "message_id", "messageId") ?? str(agent, "message_id"),
        threadId: str(created, "thread_id", "threadId") ?? str(agent, "thread_id"),
      });
      // Charged once, when the build has really started on Lovable.
      const charge = await recordCharge(deps.credits, {
        id: `app_build:${b.id}`,
        appId: null,
        service: "app_build",
        costUsd: lovableCostUsd(),
        description: `Build first version of ${b.request.name}`,
        ...(maxCredits !== null ? { maxCredits } : {}),
      });
      if (charge) b = saveBuild(setup, { ...b, credits: charge.credits });
    }

    // 2. Wait for Lovable's agent.
    for (;;) {
      const msg = b.messageId ? await tools.call("get_message", { project_id: b.projectId, message_id: b.messageId, ...(b.threadId ? { thread_id: b.threadId } : {}) }) : null;
      const project = await tools.call("get_project", { project_id: b.projectId });
      const preview = str(project, "preview_url", "previewUrl") ?? str(project.project as Record<string, unknown>, "preview_url");
      if (preview && preview !== b.previewUrl) b = saveBuild(setup, { ...b, previewUrl: preview });
      const state = msg ? agentState(msg) : { done: (project.project as Record<string, unknown> | undefined)?.agentFinished === true };
      if (state.failed) throw new Error(state.failed);
      if (state.awaiting) {
        saveBuild(setup, { ...b, status: "needs_you", awaiting: state.awaiting, step: "Lovable needs your OK to continue" });
        return;
      }
      if (state.done) {
        // 3. Export the code at the finished commit.
        const sha = str(project, "latest_commit_sha") ?? str(project.project as Record<string, unknown>, "latest_commit_sha");
        b = saveBuild(setup, { ...b, status: "exporting", step: "Moving the code into your own repository" });
        const appId = generateAppId();
        const dir = deps.repoDir(appId);
        mkdirSync(dir, { recursive: true });
        let skipped = 0;
        let cursor: string | undefined;
        for (let page = 0; page < 100; page++) {
          const list = await tools.call("list_files", { project_id: b.projectId, limit: 100, ...(sha ? { ref: sha } : {}), ...(cursor ? { cursor } : {}) });
          const files = (Array.isArray(list.files) ? list.files : []) as Array<string | { path?: string; type?: string }>;
          for (const f of files) {
            const path = typeof f === "string" ? f : f.path;
            if (!path || (typeof f === "object" && f.type === "directory")) continue;
            const target = resolve(dir, path);
            if (!target.startsWith(dir + sep)) continue; // never write outside the repo
            if (BINARY.test(path)) {
              skipped++;
              continue;
            }
            const file = await tools.call("read_file", { project_id: b.projectId, path, ...(sha ? { ref: sha } : {}) });
            const content = typeof file.content === "string" ? file.content : typeof file.text === "string" ? file.text : null;
            if (content === null) {
              skipped++;
              continue;
            }
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, content);
          }
          cursor = str(list.pagination as Record<string, unknown>, "next_cursor");
          if (!cursor) break;
        }
        await $`git init -q -b main && git add -A && git -c user.name=day2 -c user.email=day2@localhost commit -q -m ${`First version of ${b.request.name}, built with Lovable`}`
          .cwd(dir)
          .quiet();
        const githubRepo = await deps.pushToGitHub(dir, b.request.name);

        // 4. Register the app.
        const reg = loadAppsRegistry(deps.registryPath);
        const added = addApp(reg, {
          id: appId,
          name: b.request.name,
          repoPath: dir,
          connectionMethod: githubRepo ? "github" : "local_path",
          ...(githubRepo ? { githubRepo } : {}),
        });
        if (!added.ok) throw new Error(added.reason);
        saveAppsRegistry(deps.registryPath, added.registry);
        // Images and fonts can't be read as text through Lovable's tools —
        // say so on the new app's backlog rather than leave a silent gap.
        if (skipped > 0) {
          const r = createTicket(
            emptyBacklog(),
            {
              title: "Bring over images and fonts from the Lovable project",
              type: "task",
              description: `${skipped} image/font ${skipped === 1 ? "file" : "files"} stayed in the Lovable project when the code was moved here (Lovable's tools only hand over text files). Copy them from ${b.previewUrl ?? "the Lovable project"} or replace them.`,
              doneWhen: ["Every image and font the app references is in the repo"],
              priority: 2,
              prioritySource: "day2",
              source: { kind: "day2_proposal", key: `lovable-assets:${b.projectId}` },
              actor: "day2",
              createdNote: "Created by day2 when the first version moved over from Lovable.",
            },
            new Date(),
          );
          saveBacklog(join(dir, BACKLOG_FILENAME), r.backlog);
        }
        saveBuild(setup, { ...b, status: "done", step: "Ready", appId, ...(githubRepo ? { githubRepo } : {}), skippedFiles: skipped });
        return;
      }
      if (Date.now() > deadline) throw new Error("Lovable is taking unusually long — check the build again later.");
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    await tools.close();
  }
}

export type { AppEntry };
