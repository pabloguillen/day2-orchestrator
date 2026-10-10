import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAppsRegistry } from "./apps-registry";
import { getSummary, setPlan } from "./credits";
import {
  agentState,
  answerBuild,
  buildPrompt,
  estimateBuildCredits,
  getBuild,
  lovableStatus,
  startBuild,
  validateBuildRequest,
  type BuildDeps,
  type LovableTools,
} from "./lovable";

const ROOT = mkdtempSync(join(tmpdir(), "day2-lovable-"));
const setup = { dir: ROOT, callbackUrl: "http://localhost:4700/api/lovable/oauth/callback" };
const registryPath = join(ROOT, "apps.json");

/** Fake Lovable: a project whose agent finishes after `pollsUntilDone` polls,
 * optionally pausing once for an approval. */
function fakeLovable(opts: { pause?: boolean; fail?: boolean } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let polls = 0;
  let paused = Boolean(opts.pause);
  const files: Record<string, string> = {
    "README.md": "# habit-loop",
    "src/App.tsx": "export default function App() { return null }",
    "public/favicon.ico": "binary",
    "../escape.txt": "nope",
  };
  const tools: LovableTools = {
    async call(name, args) {
      calls.push([name, args]);
      switch (name) {
        case "create_project":
          return { projectId: "p1", message_id: "m1", agent_response: { status: "in_progress", thread_id: "t1" } };
        case "get_message":
          polls++;
          if (opts.fail) return { status: "running", response: { status: "error", error: "Build failed" } };
          if (paused) return { status: "running", response: { status: "awaiting_input", awaiting_input: { event_id: "e1", tool_id: "enable_database", params: { reason: "store habits" } } } };
          return polls >= 2 ? { status: "accepted", response: { status: "completed" } } : { status: "running" };
        case "get_project":
          return { preview_url: "https://p1.lovable.app", latest_commit_sha: "abc" };
        case "list_files":
          return { files: Object.keys(files).map((path) => ({ path })), pagination: {} };
        case "read_file":
          return { content: files[String(args.path)] };
        case "respond_to_approval":
          paused = false;
          return { status: "accepted" };
      }
      throw new Error(`unexpected ${name}`);
    },
    async close() {},
  };
  return { tools, calls };
}

function deps(tools: LovableTools, pushed: string | null = "me/habit-loop"): BuildDeps {
  return {
    tools: async () => tools,
    repoDir: (id) => join(ROOT, "repos", id),
    pushToGitHub: async () => pushed,
    registryPath,
    credits: { dir: ROOT },
    pollMs: 5,
    maxWaitMs: 5_000,
  };
}

async function until(fn: () => boolean) {
  for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
}

const prev = process.env.DAY2_LOVABLE_API_KEY;
beforeAll(async () => {
  process.env.DAY2_LOVABLE_API_KEY = "lov_test";
  writeFileSync(registryPath, JSON.stringify({ apps: [] }));
  await setPlan({ dir: ROOT }, "growth", "monthly");
});
afterAll(() => {
  if (prev === undefined) delete process.env.DAY2_LOVABLE_API_KEY;
  else process.env.DAY2_LOVABLE_API_KEY = prev;
  rmSync(ROOT, { recursive: true, force: true });
});

describe("requests and prompts", () => {
  test("validates name and description; keeps only known looks", () => {
    expect(validateBuildRequest({ name: "Habit Loop", description: "x".repeat(30) })).toMatchObject({ ok: false });
    expect(validateBuildRequest({ name: "habit-loop", description: "too short" })).toMatchObject({ ok: false });
    expect(validateBuildRequest({ name: "habit-loop", description: "A habit tracker for streak breakers.", look: ["Calm", "Neon"], audience: " busy parents " })).toEqual({
      ok: true,
      request: { name: "habit-loop", description: "A habit tracker for streak breakers.", audience: "busy parents", look: ["Calm"] },
    });
  });

  test("the build prompt carries the owner's words, audience and look", () => {
    const p = buildPrompt({ name: "habit-loop", description: "A habit tracker.", audience: "busy parents", look: ["Calm", "Minimal"] });
    expect(p).toContain('Build "habit-loop": A habit tracker.');
    expect(p).toContain("It's for: busy parents.");
    expect(p).toContain("Look and feel: calm, minimal.");
  });

  test("agent states", () => {
    expect(agentState({ response: { status: "completed" } })).toEqual({ done: true });
    expect(agentState({ status: "running" })).toEqual({ done: false });
    expect(agentState({ response: { status: "stopped" } }).failed).toMatch(/stopped/);
    expect(agentState({ response: { status: "awaiting_input" } }).failed).toMatch(/editor/);
    expect(agentState({ response: { status: "awaiting_input", awaiting_input: { event_id: "e", tool_id: "x", requires_secure_form: true } } }).awaiting).toMatchObject({ secure: true });
  });

  test("status reports the API key connection and the credit estimate", () => {
    expect(lovableStatus(setup)).toMatchObject({ connected: true, method: "api_key" });
    expect(estimateBuildCredits()).toBeGreaterThan(0);
  });
});

describe("a build", () => {
  test("creates, waits, exports the code to its own repo, registers the app, charges credits", async () => {
    const { tools, calls } = fakeLovable();
    const before = (await getSummary({ dir: ROOT })).balance.usedThisMonth;
    const b = await startBuild(setup, { name: "habit-loop", description: "A habit tracker for streak breakers." }, deps(tools));
    expect(b.status).toBe("building");
    await until(() => getBuild(setup, b.id)?.status === "done");
    const done = getBuild(setup, b.id)!;
    expect(done).toMatchObject({ status: "done", githubRepo: "me/habit-loop", previewUrl: "https://p1.lovable.app", skippedFiles: 1 });
    const app = loadAppsRegistry(registryPath).apps.find((a) => a.id === done.appId)!;
    expect(app).toMatchObject({ name: "habit-loop", connectionMethod: "github", githubRepo: "me/habit-loop" });
    expect(readFileSync(join(app.repoPath, "src/App.tsx"), "utf-8")).toContain("App()");
    expect(existsSync(join(app.repoPath, ".git"))).toBe(true);
    expect(existsSync(join(ROOT, "repos", "escape.txt"))).toBe(false);
    const backlog = JSON.parse(readFileSync(join(app.repoPath, "day2-backlog.json"), "utf-8"));
    expect(backlog.tickets[0].title).toBe("Bring over images and fonts from the Lovable project");
    expect(calls.find(([n]) => n === "create_project")![1].initial_message).toContain("habit-loop");
    expect(calls.filter(([n]) => n === "read_file").every(([, a]) => a.ref === "abc")).toBe(true);
    const after = await getSummary({ dir: ROOT });
    expect(after.balance.usedThisMonth - before).toBe(done.credits);
    expect(after.recent[0]).toMatchObject({ description: "Build first version of habit-loop", service: "app_build" });
  });

  test("a paused Lovable step waits for the owner, then continues", async () => {
    const { tools, calls } = fakeLovable({ pause: true });
    const b = await startBuild(setup, { name: "recipe-box", description: "Keep family recipes in one place." }, deps(tools, null));
    await until(() => getBuild(setup, b.id)?.status === "needs_you");
    expect(getBuild(setup, b.id)!.awaiting).toMatchObject({ toolId: "enable_database", params: { reason: "store habits" } });
    await answerBuild(setup, b.id, "approved", deps(tools, null));
    expect(calls.find(([n]) => n === "respond_to_approval")![1]).toMatchObject({ event_id: "e1", message_id: "m1", decision: "approved" });
    await until(() => getBuild(setup, b.id)?.status === "done");
    const app = loadAppsRegistry(registryPath).apps.find((a) => a.name === "recipe-box")!;
    expect(app.connectionMethod).toBe("local_path"); // no GitHub on this machine
    await expect(answerBuild(setup, b.id, "approved", deps(tools))).rejects.toThrow(/isn't waiting/);
  });

  test("a failed build says why; names can't repeat", async () => {
    const { tools } = fakeLovable({ fail: true });
    const b = await startBuild(setup, { name: "fails-app", description: "This one will fail to build." }, deps(tools));
    await until(() => getBuild(setup, b.id)?.status === "failed");
    expect(getBuild(setup, b.id)!.error).toBe("Build failed");
    await expect(startBuild(setup, { name: "habit-loop", description: "Same name as before, again." }, deps(fakeLovable().tools))).rejects.toThrow(/already an app/);
  });
});
