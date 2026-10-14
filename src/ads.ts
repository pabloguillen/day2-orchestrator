import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { meteredQuery } from "./metered-query";
import { recordCharge, type CreditStore } from "./credits";

/**
 * Paid traffic for experiments, run from day2's own Meta ad account through
 * the Meta Ads MCP server (connectors.ts). Every ad runs under the app's own
 * Facebook Page (ad-identities.ts). Ad spend is read back from Meta and
 * billed to the customer's credits at the paid-ads markup (credits.ts).
 *
 * Meta's MCP tools are used by an agent with a narrow, exact brief per
 * operation and a structured result — the same pattern as day2's other
 * agent calls — so this file doesn't depend on Meta's tool names.
 */

export type LaunchInput = {
  appName: string;
  appPurpose: string;
  pageId: string;
  adAccountId: string;
  link: string;
  idea: string;
  audience: string;
  dailyBudgetUsd: number;
  campaignName: string;
};

export type AdStats = { spendUsd: number; impressions: number; clicks: number; status: string };

export interface AdPlatform {
  launch(input: LaunchInput): Promise<{ campaignId: string }>;
  stats(campaignId: string): Promise<AdStats>;
  pause(campaignId: string): Promise<void>;
  setDailyBudget(campaignId: string, usd: number): Promise<void>;
}

const MARKER = "AD_RESULT_JSON:";
const AD_AGENT_BUDGET_USD = 0.4;
const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";

export function parseAdResult(text: string): Record<string, unknown> | null {
  const i = text.lastIndexOf(MARKER);
  if (i === -1) return null;
  try {
    const v = JSON.parse(text.slice(i + MARKER.length).trim()) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function runAdAgent(servers: Record<string, McpServerConfig>, prompt: string, label: string): Promise<Record<string, unknown>> {
  const query = meteredQuery("agent_work", label);
  let text = "";
  let isError = false;
  for await (const m of query({
    prompt,
    options: {
      model: MODEL,
      permissionMode: "bypassPermissions",
      maxTurns: 25,
      maxBudgetUsd: AD_AGENT_BUDGET_USD,
      persistSession: false,
      settingSources: [],
      settings: { disableClaudeAiConnectors: true },
      tools: [],
      mcpServers: servers,
    },
  })) {
    if (m.type === "result") {
      text = (m as { result?: string }).result ?? "";
      isError = Boolean((m as { is_error?: boolean }).is_error);
    }
  }
  const r = parseAdResult(text);
  if (isError || !r) throw new Error(`Meta Ads: ${label} didn't complete${text ? ` (${text.slice(-200)})` : ""}.`);
  if (typeof r.error === "string") throw new Error(`Meta Ads: ${r.error}`);
  return r;
}

const RULES = `Rules: use only the Meta Ads tools you have. Never create anything
except what's asked, never change other campaigns, never raise any budget
beyond what's stated. If something fails or isn't possible, stop and report
it. End your final message with exactly this marker on its own line,
followed by one JSON object and nothing else:
${MARKER}`;

/** day2's Meta ad account, operated through the Meta Ads MCP server. */
export function metaAdsViaAgent(servers: Record<string, McpServerConfig>): AdPlatform {
  return {
    async launch(i) {
      const r = await runAdAgent(
        servers,
        `Create one new Meta ads campaign in ad account ${i.adAccountId}, advertising "${i.appName}" (${i.appPurpose}).

- Campaign name: "${i.campaignName}". Objective: traffic (link clicks) to ${i.link} — use this exact URL, it's tracked.
- Identity: Facebook Page ${i.pageId}. Placements: Facebook and Instagram, automatic.
- Daily budget: ${i.dailyBudgetUsd.toFixed(2)} USD, no end date (day2 stops it).
- Audience: ${i.audience || "broad, adults 18+, in the app's language"}.
- One ad. Write the copy from this idea: "${i.idea}". Primary text up to 125 characters, headline up to 40, call to action "Learn more". Be specific and truthful: say only what the app really does (above), no invented numbers, testimonials or claims. Use the link's preview image.
- Create it ACTIVE.

${RULES}
{"campaignId": "...", "status": "ACTIVE"}  (or {"error": "why"})`,
        "Launch ad",
      );
      if (typeof r.campaignId !== "string" || !r.campaignId) throw new Error("Meta Ads: no campaign id came back.");
      return { campaignId: r.campaignId };
    },
    async stats(campaignId) {
      const r = await runAdAgent(
        servers,
        `Report lifetime results for Meta ads campaign ${campaignId}: amount spent (USD), impressions, link clicks, and its current status. Read only — change nothing.

${RULES}
{"spendUsd": 0, "impressions": 0, "clicks": 0, "status": "ACTIVE"}  (or {"error": "why"})`,
        "Read ad results",
      );
      return {
        spendUsd: Number(r.spendUsd) || 0,
        impressions: Number(r.impressions) || 0,
        clicks: Number(r.clicks) || 0,
        status: typeof r.status === "string" ? r.status : "UNKNOWN",
      };
    },
    async pause(campaignId) {
      await runAdAgent(servers, `Pause Meta ads campaign ${campaignId} (status PAUSED). Change nothing else.\n\n${RULES}\n{"status": "PAUSED"}  (or {"error": "why"})`, "Pause ad");
    },
    async setDailyBudget(campaignId, usd) {
      await runAdAgent(
        servers,
        `Set the daily budget of Meta ads campaign ${campaignId} (or its ad set) to ${usd.toFixed(2)} USD. Change nothing else.\n\n${RULES}\n{"dailyBudgetUsd": ${usd.toFixed(2)}}  (or {"error": "why"})`,
        "Change ad budget",
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Billing ad spend in credits
// ---------------------------------------------------------------------------

/**
 * Bills the spend Meta reports beyond what's already been billed. The charge
 * id carries the cumulative amount, so a repeated pass never bills twice.
 * Returns the new billed total.
 */
export async function billAdSpend(
  store: CreditStore,
  opts: { appId: string; campaignId: string; label: string; reportedSpendUsd: number; billedSpendUsd: number },
): Promise<number> {
  const delta = Math.round((opts.reportedSpendUsd - opts.billedSpendUsd) * 100) / 100;
  if (delta <= 0) return opts.billedSpendUsd;
  await recordCharge(store, {
    id: `ads:${opts.campaignId}:${Math.round(opts.reportedSpendUsd * 100)}`,
    appId: opts.appId,
    service: "paid_ads",
    costUsd: delta,
    description: `Ad spend — ${opts.label}`,
  });
  return opts.billedSpendUsd + delta;
}
