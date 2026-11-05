import { mkdirSync } from "node:fs";
import { runBuildAgent } from "../agent";
import { sandboxConfig } from "../agent-sandbox";
import { dataDir } from "../day2-paths";
import { meteredQuery } from "../metered-query";
import { BUDGET_USD } from "./request";
import { renderPage, renderScreen } from "../mockups";
import type { CreateAgents, CreateRender } from "./flow";

/**
 * The real agents behind Create (tests inject fakes). The screen list, the
 * design system and the drawings are pure writing — no tools, nothing to
 * read yet; the build steps use the
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
  plan: (prompt) => write(prompt, BUDGET_USD.plan, "Screen list"),
  style: (prompt) => write(prompt, BUDGET_USD.style, "Design system"),
  screen: (prompt) => write(prompt, BUDGET_USD.screen, "Screen drawing"),
  build: (cwd, report) => runBuildAgent(cwd, report),
};

/** Playwright, with every web request blocked (mockups.ts). */
export const createRender: CreateRender = {
  screen: (html, png, size) => renderScreen(html, png, size),
  page: (html, png, width) => renderPage(html, png, width),
};
