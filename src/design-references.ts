import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ToolBinding } from "./growth-tools-config";

/**
 * Step 4 (self-distributing) extension — owner-supplied design references
 * (COORDINATION.md W46), for creative generation (Component 5) and the
 * marketing website (Component 7) to ground in real brand material beyond
 * what `onboarding.ts`'s code-scan can see: a logo file, an illustration
 * library, marketing photography, or an in-progress rebrand that hasn't
 * shipped to the live app yet — none of that lives in the app's own CSS.
 *
 * Owner-facing config, same per-app idiom `.day2-budget.json`/
 * `.day2-autonomy.json` already established: a separate file
 * (`.day2-design-references.json`), read via `--repo <path>` targeting,
 * a load/save/edit split matching `growth-config.ts`'s own CRUD-vs-math
 * split. Deliberately its OWN file, not folded into `GrowthConfig` — a
 * genuinely different concern (creative grounding, not spend/KPI), same
 * reasoning `growth-tools-config.ts` used to justify its own separate file.
 *
 * **Scope note**: this file owns the grounding/consumption side and the
 * CLI (matching every other owner-config surface's established pattern)
 * — not a REST upload endpoint/UI. Another session's uncommitted
 * `api-server.ts` appears to already be building an owner-facing API/
 * console layer; a competing upload endpoint here would have risked a
 * real collision with in-progress work this session doesn't own.
 *
 * Uploaded files are real copies, not just metadata: `addUploadedAsset`
 * copies the given source file into `.day2-brand-assets/` (next to the
 * manifest, in the app's own repo) and records it — a real, inspectable
 * artifact an owner or operator can `git add`, not a stub reference to a
 * file that only exists somewhere else.
 *
 * The Figma piece follows Component 4's established identity split: day2
 * holds ONE platform-level Figma credential (a `ToolBinding` under the
 * new `design_reference` `GrowthCapability`), reusable across every app it
 * powers — NOT identity-bearing the way `social_account_operation`/
 * `ad_platform`/`website_generation` are, since a Figma API credential
 * isn't app-specific the way a connected social/ad account is. The
 * per-app-specific piece is just the file URL, owner-supplied and stored
 * here, not a `connectedAccountRef` on the binding. Same disclosed
 * limitation as every other MCP-upgrade path in this codebase:
 * `.day2-platform-tools.json` ships empty, so `fetchFigmaDesignContext`'s
 * "a real, connected tool responds" branch is structurally real but not
 * live-tested against a genuine Figma connection.
 */

export type UploadedAsset = {
  /** Relative path within `.day2-brand-assets/`, e.g. "logo.png". */
  filename: string;
  description: string;
  uploadedAt: string;
};

export type DesignReferences = {
  uploadedAssets: UploadedAsset[];
  figmaFileUrl?: string;
  figmaConnectedAt?: string;
};

export const DESIGN_REFERENCES_FILENAME = ".day2-design-references.json";
export const BRAND_ASSETS_DIRNAME = ".day2-brand-assets";

/** Safe-by-construction default: no uploaded assets, no Figma file — real
 * infra, zero real behavior change until the owner actually adds
 * something, same "`bindings: []`"/"`ACTIVE_EXPERIMENTS: []`" precedent
 * used everywhere else in this stage. */
function defaultDesignReferences(): DesignReferences {
  return { uploadedAssets: [] };
}

function isValidUploadedAsset(value: unknown): value is UploadedAsset {
  if (typeof value !== "object" || value === null) return false;
  const { filename, description, uploadedAt } = value as Record<string, unknown>;
  return (
    typeof filename === "string" &&
    filename.trim().length > 0 &&
    typeof description === "string" &&
    typeof uploadedAt === "string" &&
    uploadedAt.trim().length > 0
  );
}

function isValidDesignReferences(value: unknown): value is DesignReferences {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  if (!Array.isArray(o.uploadedAssets) || !o.uploadedAssets.every(isValidUploadedAsset)) return false;
  if (o.figmaFileUrl !== undefined && typeof o.figmaFileUrl !== "string") return false;
  if (o.figmaConnectedAt !== undefined && typeof o.figmaConnectedAt !== "string") return false;
  return true;
}

export function loadDesignReferences(path: string): DesignReferences {
  if (!existsSync(path)) return defaultDesignReferences();
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} exists but isn't valid JSON — fix or remove it by hand before using this tool.`);
  }
  if (!isValidDesignReferences(parsed)) {
    throw new Error(`${path} exists but doesn't look like a valid design-references file — refusing to guess or overwrite it.`);
  }
  return parsed;
}

export function saveDesignReferences(path: string, refs: DesignReferences): void {
  writeFileSync(path, `${JSON.stringify(refs, null, 2)}\n`);
}

/** Copies `sourceFilePath` into `.day2-brand-assets/` next to `manifestPath`
 * (creating the directory if needed) and records it in the manifest. A
 * real file copy, not a reference to wherever the source happened to be —
 * the app's own repo ends up with a real, versionable asset. Re-uploading
 * the same `filename` overwrites both the copy and its manifest entry
 * (last upload wins, same "re-running is safe" idiom `saveGrowthConfig`
 * already has via plain overwrite). */
export function addUploadedAsset(
  manifestPath: string,
  refs: DesignReferences,
  sourceFilePath: string,
  description: string,
  uploadedAt: string,
): DesignReferences {
  const filename = basename(sourceFilePath);
  const assetsDir = join(dirname(manifestPath), BRAND_ASSETS_DIRNAME);
  if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
  copyFileSync(sourceFilePath, join(assetsDir, filename));

  const withoutExisting = refs.uploadedAssets.filter((a) => a.filename !== filename);
  return { ...refs, uploadedAssets: [...withoutExisting, { filename, description, uploadedAt }] };
}

/** Removes the manifest entry only — deliberately does not delete the real
 * file from `.day2-brand-assets/`, so an owner who removes an asset by
 * mistake hasn't also lost the file; matches this codebase's general bias
 * toward reversible operations over destructive ones. */
export function removeUploadedAsset(refs: DesignReferences, filename: string): DesignReferences {
  return { ...refs, uploadedAssets: refs.uploadedAssets.filter((a) => a.filename !== filename) };
}

export function setFigmaFileUrl(refs: DesignReferences, figmaFileUrl: string | undefined, connectedAt: string): DesignReferences {
  if (figmaFileUrl === undefined) {
    const { figmaFileUrl: _drop, figmaConnectedAt: _drop2, ...rest } = refs;
    return rest;
  }
  return { ...refs, figmaFileUrl, figmaConnectedAt: connectedAt };
}

export function renderDesignReferencesSummary(refs: DesignReferences): string {
  const lines: string[] = [];
  lines.push(`Uploaded assets: ${refs.uploadedAssets.length}`);
  for (const a of refs.uploadedAssets) {
    lines.push(`  - ${a.filename} (${a.description || "no description"}), uploaded ${a.uploadedAt}`);
  }
  lines.push(refs.figmaFileUrl ? `Figma file: ${refs.figmaFileUrl} (connected ${refs.figmaConnectedAt})` : "Figma file: not connected");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Figma grounding
// ---------------------------------------------------------------------------

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
const MAX_TURNS = 20;
const MAX_BUDGET_USD = 1;

export type FigmaDesignContext = {
  /** Real, agent-summarized description of what the file actually
   * contains — colors, typography, key screens/components — grounded in
   * whatever the connected tool actually returned, never invented. */
  summary: string;
  figmaFileUrl: string;
};

export type FigmaFetchResult =
  | { status: "fetched"; context: FigmaDesignContext; costUsd: number }
  | { status: "not_configured" }
  | { status: "fetch_failed"; reason: string };

const FIGMA_RESULT_MARKER = "FIGMA_DESIGN_CONTEXT:";

function buildFigmaPrompt(figmaFileUrl: string): string {
  return `You have access to a Figma MCP tool. Use it to read the real design
content of this Figma file: ${figmaFileUrl}

Summarize what the file actually contains that would help ground marketing
creative and website copy: the real color palette, typography, and a
description of the key screens/components you can see. Only describe what
the tool actually returns — if it can't access the file, fails, or returns
nothing useful, say so plainly rather than guessing or inventing content.

When finished, end your final message with exactly this marker on its own
line, followed by JSON (and nothing else after it):
${FIGMA_RESULT_MARKER}
{"status": "fetched", "summary": "..."}
or
{"status": "fetch_failed", "reason": "..."}`;
}

/** Pure, unit-tested. Fails closed to `fetch_failed` on any parse issue —
 * an unreadable agent response must never be reported as a successful
 * fetch. */
export function parseFigmaFetchResult(finalText: string, figmaFileUrl: string, costUsd: number): FigmaFetchResult {
  const markerIndex = finalText.indexOf(FIGMA_RESULT_MARKER);
  if (markerIndex === -1) {
    return { status: "fetch_failed", reason: "no result marker found in agent output" };
  }
  const jsonText = finalText.slice(markerIndex + FIGMA_RESULT_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { status: "fetch_failed", reason: "malformed JSON after result marker" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { status: "fetch_failed", reason: "result was not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.status === "fetch_failed") {
    return {
      status: "fetch_failed",
      reason: typeof obj.reason === "string" && obj.reason.trim().length > 0 ? obj.reason : "no reason given",
    };
  }
  if (obj.status !== "fetched" || typeof obj.summary !== "string" || obj.summary.trim().length === 0) {
    return { status: "fetch_failed", reason: "result had neither a valid \"fetched\" nor \"fetch_failed\" shape" };
  }
  return { status: "fetched", context: { summary: obj.summary, figmaFileUrl }, costUsd };
}

/**
 * Thin, agent-invoking wrapper. Fails closed to `not_configured` BEFORE
 * ever calling an agent when no platform Figma binding is resolved —
 * matches every other identity/connection precondition check in this
 * stage (`generateMarketingWebsite`'s `blocked_by_unconnected_account`,
 * `generateCreatives`'s video-tool-binding check).
 */
export async function fetchFigmaDesignContext(figmaFileUrl: string, toolBinding: ToolBinding | undefined): Promise<FigmaFetchResult> {
  if (!toolBinding) return { status: "not_configured" };

  let finalText = "";
  let isError = false;
  let costUsd = 0;

  try {
    for await (const message of query({
      prompt: buildFigmaPrompt(figmaFileUrl),
      options: {
        model: MODEL,
        permissionMode: "bypassPermissions",
        maxTurns: MAX_TURNS,
        maxBudgetUsd: MAX_BUDGET_USD,
        persistSession: false,
        settingSources: [],
        settings: { disableClaudeAiConnectors: true },
        tools: [],
        mcpServers: { [toolBinding.mcpServerName]: toolBinding.serverConfig },
      },
    })) {
      if (message.type === "result") {
        finalText = message.result ?? "";
        isError = Boolean(message.is_error);
        costUsd = message.total_cost_usd ?? 0;
      }
    }
  } catch (err) {
    isError = true;
    finalText = `(agent run threw before producing a result: ${(err as Error).message})`;
  }

  if (isError) return { status: "fetch_failed", reason: `agent run failed: ${finalText}` };
  return parseFigmaFetchResult(finalText, figmaFileUrl, costUsd);
}
