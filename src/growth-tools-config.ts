import { existsSync, readFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig, McpServerToolPolicy } from "@anthropic-ai/claude-agent-sdk";
import type { SpendCategory } from "./spend-governance";
import type { GrowthStrategy } from "./growth-strategy";

/**
 * Step 4 (self-distributing), Component 4 — config-driven MCP/tool-selection
 * layer (COORDINATION.md W40, docs/step4-self-distributing-plan.md).
 *
 * Platform-level, not per-app: this is the one Step 4 config surface that
 * does NOT live in the governed app's own repo and is not read via the
 * `--repo <path>` targeting every other per-app config (`.day2-autonomy.json`,
 * `.day2-budget.json`) uses. Lives at `orchestrator/.day2-platform-tools.json`
 * (gitignored — real vendor credentials never get committed) — the app
 * owner never sees, edits, or authors a `ToolBinding`, per W37's disclosed
 * platform-vs-owner correction.
 *
 * `Arm` is specified by the plan as belonging to Component 3
 * (`growth-allocator.ts`), which doesn't exist yet — defined locally here,
 * matching the plan's exact shape, same discipline as Component 2 locally
 * defining `CompetitorAngleInsight`/`SocialTrendInsight` ahead of
 * Component 5. Component 3 should import this file's `Arm` (or re-export
 * an identical one) when it lands, not redefine a diverging shape.
 */

export type Arm = {
  channel: SpendCategory;
  assetType: "text" | "image" | "video";
  videoFormat?: "motion_graphics" | "ugc";
  formatTag: string;
};

export type GrowthCapability =
  | "creative_generation"
  | "motion_video_generation"
  | "ugc_video_generation"
  | "social_trend_research"
  | "social_account_operation"
  | "ad_platform"
  | "app_store_release"
  | "seo_content"
  | "competitor_research"
  | "website_generation";

const GROWTH_CAPABILITIES: readonly GrowthCapability[] = [
  "creative_generation",
  "motion_video_generation",
  "ugc_video_generation",
  "social_trend_research",
  "social_account_operation",
  "ad_platform",
  "app_store_release",
  "seo_content",
  "competitor_research",
  "website_generation",
];

/** Safety rail 5: these three domains still need a real, app-specific
 * identity resource (a social account, an ad account, a website/domain)
 * that day2 itself provisions as a one-time, manual, day2-operator action —
 * never conjured by code, never owner-supplied. A binding for one of these
 * capabilities only ever resolves for a given app once `connectedAccountRef`
 * is set, independently of the platform-wide `enabled` flag. */
const IDENTITY_BEARING_CAPABILITIES: ReadonlySet<GrowthCapability> = new Set([
  "social_account_operation",
  "ad_platform",
  "website_generation",
]);

export type ToolBinding = {
  capability: GrowthCapability;
  /** e.g. "tryholo"/"higgsfield" (creative), "raylight" (motion video),
   * "arcads" (UGC), "foreplay" (competitor ad research), "semrush" (SEO),
   * "posteverywhere" (social ops), "fastlane" (app-store), "framer"
   * (website), "juno" (cross-cutting) — illustrative, swappable, never
   * hardcoded into agent logic. Held and paid for by day2 as the platform
   * operator, not the app owner. */
  mcpServerName: string;
  serverConfig: McpServerConfig;
  allowedTools: string[];
  toolPolicy?: McpServerToolPolicy[];
  enabled: boolean;
  /** social_account_operation/ad_platform/website_generation only — points
   * at the real, app-specific identity resource day2 has provisioned for
   * this app under its own agency/multi-tenant relationship with that
   * platform. Fails closed unset (safety rail 5). Never owner-supplied.
   * A flat, single-app field — day2 powers exactly one app today
   * (expense-buddy), so this isn't real per-app multi-tenancy yet; see
   * Open Question 12 and `resolveBindings`'s own note below. */
  connectedAccountRef?: string;
  /** Disclosed addition beyond the plan's literal type snippet. The plan's
   * own prose describes `selectBestFitBinding` v1 as a rule that "match[es]
   * on assetType/videoFormat/channel, then fall[s] back to the first
   * enabled binding" — but none of this type's other fields actually carry
   * that signal (an `Arm`'s shape has nothing on `ToolBinding` to compare
   * against). Optional and operator-authored in the same config file as
   * everything else here — config-driven, not hardcoded vendor-name
   * matching in agent logic, which is this component's whole design
   * principle. Absent bindings simply always lose ties and fall through to
   * the "first enabled" tiebreak the plan also names. */
  fitHints?: {
    assetTypes?: Array<Arm["assetType"]>;
    videoFormats?: Array<NonNullable<Arm["videoFormat"]>>;
    channels?: SpendCategory[];
  };
};

/** One registry, shared across every app day2 powers — today just
 * expense-buddy, designed to scale to more without a shape change. */
export type GrowthToolsConfig = { bindings: ToolBinding[] };

export const GROWTH_TOOLS_CONFIG_FILENAME = ".day2-platform-tools.json";

/** Ships with `bindings: []` — matches `ACTIVE_EXPERIMENTS: []`'s "real
 * infra, zero real behavior change" precedent. An unresolved capability
 * fails closed to "no tool available," never a fabricated fallback. */
function defaultGrowthToolsConfig(): GrowthToolsConfig {
  return { bindings: [] };
}

function isValidMcpServerConfig(value: unknown): value is McpServerConfig {
  if (!value || typeof value !== "object") return false;
  const type = (value as Record<string, unknown>).type;
  if (type === undefined) {
    // McpStdioServerConfig's `type` is optional (defaults to "stdio")
    return typeof (value as Record<string, unknown>).command === "string";
  }
  return type === "stdio" || type === "sse" || type === "http" || type === "sdk";
}

function isValidToolBinding(value: unknown): value is ToolBinding {
  if (!value || typeof value !== "object") return false;
  const b = value as Record<string, unknown>;
  if (typeof b.capability !== "string" || !GROWTH_CAPABILITIES.includes(b.capability as GrowthCapability)) {
    return false;
  }
  if (typeof b.mcpServerName !== "string" || b.mcpServerName.trim().length === 0) return false;
  if (!isValidMcpServerConfig(b.serverConfig)) return false;
  if (!Array.isArray(b.allowedTools) || !b.allowedTools.every((t) => typeof t === "string")) return false;
  if (typeof b.enabled !== "boolean") return false;
  if (b.connectedAccountRef !== undefined && typeof b.connectedAccountRef !== "string") return false;
  return true;
}

function isValidGrowthToolsConfig(value: unknown): value is GrowthToolsConfig {
  if (!value || typeof value !== "object") return false;
  const bindings = (value as Record<string, unknown>).bindings;
  return Array.isArray(bindings) && bindings.every(isValidToolBinding);
}

/** Deliberately no `saveGrowthToolsConfig`/CLI — per Open Question 8, "a
 * manually-edited platform config field is sufficient for this pass"; this
 * file is never owner-facing and has exactly one day2-operator maintainer
 * editing it directly, unlike `.day2-budget.json`'s owner-facing
 * `spend-config-cli.ts`. */
export function loadGrowthToolsConfig(path: string): GrowthToolsConfig {
  if (!existsSync(path)) return defaultGrowthToolsConfig();
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} exists but isn't valid JSON — fix or remove it by hand before using this tool.`);
  }
  if (!isValidGrowthToolsConfig(parsed)) {
    throw new Error(`${path} exists but doesn't look like a valid platform tools config — refusing to guess or overwrite it.`);
  }
  return parsed;
}

/**
 * Plural — every enabled binding usable for this specific app. `appId`
 * matters for identity-bearing capabilities: day2 having a platform-wide
 * Foreplay/tryholo.ai/Arcads.ai subscription doesn't mean every app
 * automatically has a live ad account or social account to operate through.
 *
 * v1 honesty note (Open Question 12): `connectedAccountRef` is a flat,
 * single-app field on `ToolBinding` today, not a per-`appId` map — day2
 * powers exactly one app (expense-buddy), so "unconnected for this app"
 * and "unconnected, period" are indistinguishable right now. `appId` is
 * accepted and threaded through for forward compatibility (real
 * multi-tenancy would key `connectedAccountRef` by it), not because it
 * changes today's behavior — same disclosed simplification as
 * `AppProfile.competitors: null` elsewhere in this project.
 */
export function resolveBindings(config: GrowthToolsConfig, capability: GrowthCapability, appId: string): ToolBinding[] {
  void appId;
  return config.bindings.filter((b) => {
    if (b.capability !== capability || !b.enabled) return false;
    if (IDENTITY_BEARING_CAPABILITIES.has(capability)) {
      return typeof b.connectedAccountRef === "string" && b.connectedAccountRef.trim().length > 0;
    }
    return true;
  });
}

/**
 * Picks the best-fit binding among an already-resolved set for a specific
 * arm/strategy context. v1 is a simple, disclosed rule (Open Question 10):
 * score each binding by how many of its optional `fitHints` match the
 * given arm, take the highest score, first-in-config-order wins ties —
 * which means a binding with no `fitHints` at all (score 0) still wins
 * whenever nothing else scores higher, exactly the "fall back to the first
 * enabled binding" behavior the plan names. Not a bandit over tools in
 * this pass — that's Component 3's own named future extension
 * (`Arm.toolHint`), deliberately not built here.
 */
export function selectBestFitBinding(
  bindings: ToolBinding[],
  context: { arm: Arm; strategy: GrowthStrategy },
): ToolBinding | undefined {
  if (bindings.length === 0) return undefined;
  let best: ToolBinding | undefined;
  let bestScore = -1;
  for (const binding of bindings) {
    let score = 0;
    const hints = binding.fitHints;
    if (hints) {
      if (hints.assetTypes?.includes(context.arm.assetType)) score++;
      if (context.arm.videoFormat && hints.videoFormats?.includes(context.arm.videoFormat)) score++;
      if (hints.channels?.includes(context.arm.channel)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = binding;
    }
  }
  return best;
}

/**
 * Builds the `Options.mcpServers` map for a query() call needing one or
 * more of the given capabilities — every enabled binding for those
 * capabilities, keyed by `mcpServerName`. Deliberately takes no `appId`:
 * establishing an MCP *connection* is always allowed (the simulate-mode
 * table's "composing + checks + connection check" row) — the identity/
 * live-action gate (safety rail 5) happens later, at execution time
 * (Component 6's `allowLiveAction`), not at connection-build time. Two
 * bindings sharing the same `mcpServerName` (e.g. one Juno connection
 * backing both `website_generation` and `seo_content`) naturally collapse
 * to one map entry.
 */
export function buildMcpServersOption(config: GrowthToolsConfig, capabilities: GrowthCapability[]): Record<string, McpServerConfig> {
  const wanted = new Set(capabilities);
  const servers: Record<string, McpServerConfig> = {};
  for (const binding of config.bindings) {
    if (!binding.enabled || !wanted.has(binding.capability)) continue;
    servers[binding.mcpServerName] = binding.serverConfig;
  }
  return servers;
}

const RESEARCH_MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
const RESEARCH_MAX_TURNS = 20;
const RESEARCH_MAX_BUDGET_USD = 1;
const RESULT_MARKER = "TOOL_CANDIDATES_JSON:";

const DOMAIN_DESCRIPTIONS: Record<GrowthCapability, string> = {
  creative_generation: "Text/image/social/ad assets, grounded in real brand voice",
  motion_video_generation: "Motion-graphics-style product/demo video",
  ugc_video_generation: "AI-presented, testimonial-style video",
  social_trend_research: "What's trending on TikTok/Instagram right now",
  social_account_operation: "Posting/scheduling to an already-connected social account",
  ad_platform: "Launching/managing paid campaigns on a real ad platform",
  app_store_release: "App store release automation (dormant today — expense-buddy has no native shell)",
  seo_content: "Keyword research, on-page SEO, site audits",
  competitor_research: "Real competitor ad creative/angle intelligence, not just feature lists",
  website_generation: "Owner-opt-in, template-based marketing website generation",
};

function buildToolResearchPrompt(domain: GrowthCapability): string {
  return `You are day2's own platform operator/maintainer, researching real,
currently-existing tools that could serve the "${domain}" capability in
day2's growth-automation platform. What day2 needs from this domain:
${DOMAIN_DESCRIPTIONS[domain]}.

This is platform-level tool research — never shown to an app owner, and not
about any specific app's content. Using web search, find 1-5 real, named,
currently-existing tools/products that genuinely fit this domain. For each:
- Note concretely what it does and why it fits this specific domain (not a
  generic "this is popular" claim).
- Classify its MCP availability as one of: "confirmed_mcp" (you found real,
  direct evidence of an MCP server for it), "api_only_needs_wrapper" (it has
  a real API but no evidence of an existing MCP server), or "unknown" (you
  couldn't verify either way).
- Cite a real, checkable URL — never invent one.

If you can't find enough real, verifiable candidates, report fewer than 5
rather than padding the list with anything unverified.

When finished, end your final message with exactly this marker on its own
line, followed by a JSON array (and nothing else after it):
${RESULT_MARKER}
[{"toolName": "...", "whatItDoes": "...", "fitReason": "...", "mcpAvailability": "confirmed_mcp"|"api_only_needs_wrapper"|"unknown", "source": "..."}, ...]

Each object needs all five fields. An empty array (${RESULT_MARKER}\n[]) is a
legitimate, honest answer if you genuinely couldn't verify anything worth
reporting — don't fabricate entries just to have output.`;
}

export type ToolCandidateInsight = {
  domain: GrowthCapability;
  toolName: string;
  whatItDoes: string;
  fitReason: string;
  mcpAvailability: "confirmed_mcp" | "api_only_needs_wrapper" | "unknown";
  source: string;
};

const MCP_AVAILABILITY_VALUES = new Set(["confirmed_mcp", "api_only_needs_wrapper", "unknown"]);

/** Pure, unit-tested. Same fail-closed-to-`[]` discipline as
 * `parseCompetitorInsights` — "couldn't extract anything trustworthy" and
 * "genuinely found nothing" look identical to a caller; individual
 * malformed entries are dropped rather than invalidating the whole batch. */
export function parseToolCandidateInsights(finalText: string, domain: GrowthCapability): ToolCandidateInsight[] {
  const markerIndex = finalText.indexOf(RESULT_MARKER);
  if (markerIndex === -1) return [];

  const jsonText = finalText.slice(markerIndex + RESULT_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((item): item is Omit<ToolCandidateInsight, "domain"> => {
      if (typeof item !== "object" || item === null) return false;
      const { toolName, whatItDoes, fitReason, mcpAvailability, source } = item as Record<string, unknown>;
      return (
        typeof toolName === "string" &&
        toolName.trim().length > 0 &&
        typeof whatItDoes === "string" &&
        whatItDoes.trim().length > 0 &&
        typeof fitReason === "string" &&
        fitReason.trim().length > 0 &&
        typeof mcpAvailability === "string" &&
        MCP_AVAILABILITY_VALUES.has(mcpAvailability) &&
        typeof source === "string" &&
        source.trim().length > 0
      );
    })
    .map((item) => ({ ...item, domain }) as ToolCandidateInsight);
}

/** Thin, agent-invoking wrapper — zero unit coverage, validated only live
 * (same idiom as `researchCompetitorFeatures`). No sandbox/cwd/tempdir
 * needed — only ever WebSearch/WebFetch, no Bash, no filesystem. Day2-
 * operator-run, never owner-facing — this is the mechanism that keeps the
 * plan's own tool table from going stale, rerun per domain whenever
 * "state of the art" is worth rechecking, not just once at ship time. */
export async function researchToolCandidates(domain: GrowthCapability): Promise<ToolCandidateInsight[]> {
  let finalText = "";
  let isError = false;

  try {
    for await (const message of query({
      prompt: buildToolResearchPrompt(domain),
      options: {
        model: RESEARCH_MODEL,
        permissionMode: "bypassPermissions",
        maxTurns: RESEARCH_MAX_TURNS,
        maxBudgetUsd: RESEARCH_MAX_BUDGET_USD,
        persistSession: false,
        settingSources: [],
        settings: { disableClaudeAiConnectors: true },
        tools: ["WebSearch", "WebFetch"],
      },
    })) {
      if (message.type === "result") {
        finalText = message.result ?? "";
        isError = Boolean(message.is_error);
      }
    }
  } catch (err) {
    isError = true;
    finalText = `(agent run threw before producing a result: ${(err as Error).message})`;
  }

  if (isError) return [];
  return parseToolCandidateInsights(finalText, domain);
}
