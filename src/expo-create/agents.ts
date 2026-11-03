import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runBuildAgent } from "../agent";
import { sandboxConfig } from "../agent-sandbox";
import { dataDir } from "../day2-paths";
import { meteredQuery } from "../metered-query";
import { parseMockupReply, renderMockup } from "../mockups";
import { BUDGET_USD } from "./request";
import type { CreateAgents } from "./flow";

/**
 * The real agents behind Create (tests inject fakes). Plan and mockups are
 * pure writing — no tools, nothing to read yet; the build steps use the
 * build agent (agent.ts) in the new app's checkout. All metered as app_build.
 */

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";

async function write(prompt: string, maxBudgetUsd: number, label: string): Promise<{ text: string; isError: boolean }> {
  const query = meteredQuery("app_build", label);
  const cwd = `${dataDir()}/expo-create-work`;
  mkdirSync(cwd, { recursive: true });
  let text = "";
  let isError = false;
  for await (const m of query({
    prompt,
    options: {
      cwd,
      model: MODEL,
      permissionMode: "bypassPermissions",
      maxTurns: 4,
      maxBudgetUsd,
      persistSession: false,
      settingSources: [],
      settings: { disableClaudeAiConnectors: true },
      tools: [],
      sandbox: sandboxConfig(),
    },
  })) {
    if (m.type === "result") {
      text = "result" in m ? (m.result ?? "") : "";
      isError = Boolean(m.is_error);
    }
  }
  return { text, isError };
}

export const createAgents: CreateAgents = {
  plan: (prompt) => write(prompt, BUDGET_USD.plan, "Product plan"),
  async mockup(prompt, out) {
    const r = await write(prompt, BUDGET_USD.mockup, "Mockup");
    const parsed = r.isError ? null : parseMockupReply(r.text);
    if (!parsed || parsed === "none") return null;
    mkdirSync(dirname(out), { recursive: true });
    await renderMockup(parsed.html, out);
    return { note: parsed.note };
  },
  build: (cwd, report) => runBuildAgent(cwd, report),
};
