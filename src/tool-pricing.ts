import type { CreditService } from "./credits";
import type { ConnectorId } from "./connectors";

/**
 * What a call to one of day2's tools costs day2, so it can be billed to the
 * customer's credits like everything else (the service's markup applies on
 * top — credits.ts). Defaults are day2's list costs; each can be set with
 * DAY2_TOOL_COST_<TOOL>_USD when a plan or price changes.
 *
 * Meta Ads tool calls themselves cost nothing; the ad spend they cause is
 * billed separately from Meta's own spend figures (ad-spend.ts).
 */

type Pricing = { service: CreditService; defaultUsdPerCall: number; billedTools?: RegExp };

const PRICING: Record<ConnectorId, Pricing> = {
  // Foreplay API usage is credit-based; a search/lookup costs a few cents.
  foreplay: { service: "scan_answer", defaultUsdPerCall: 0.02 },
  // Runway charges per generation (image ~$0.08, short video ~$0.50); only
  // generation calls are billed, not lookups.
  runway: { service: "content_generation", defaultUsdPerCall: 0.5, billedTools: /(generate|image_to_video|text_to_image|video|image)/i },
  meta_ads: { service: "paid_ads", defaultUsdPerCall: 0 },
};

export function toolCostUsd(tool: ConnectorId): number {
  const env = Number(process.env[`DAY2_TOOL_COST_${tool.toUpperCase()}_USD`]);
  return Number.isFinite(env) && env >= 0 ? env : PRICING[tool].defaultUsdPerCall;
}

export function toolService(tool: ConnectorId): CreditService {
  return PRICING[tool].service;
}

/** The tool a tool-use name belongs to, if it's a billed call:
 * `mcp__<tool>__<name>` (Agent SDK naming for MCP tools). */
export function billedToolCall(toolUseName: string): ConnectorId | null {
  const m = /^mcp__([a-z_]+)__(.+)$/.exec(toolUseName);
  if (!m) return null;
  const tool = m[1] as ConnectorId;
  const p = PRICING[tool];
  if (!p) return null;
  if (p.billedTools && !p.billedTools.test(m[2]!)) return null;
  return toolCostUsd(tool) > 0 ? tool : null;
}

/** Calls per tool in an agent run's messages. */
export function countToolCalls(messages: Array<{ type: string; message?: { content?: unknown } }>): Partial<Record<ConnectorId, number>> {
  const counts: Partial<Record<ConnectorId, number>> = {};
  for (const m of messages) {
    if (m.type !== "assistant" || !Array.isArray(m.message?.content)) continue;
    for (const block of m.message.content as Array<{ type?: string; name?: string }>) {
      if (block.type !== "tool_use" || !block.name) continue;
      const tool = billedToolCall(block.name);
      if (tool) counts[tool] = (counts[tool] ?? 0) + 1;
    }
  }
  return counts;
}
