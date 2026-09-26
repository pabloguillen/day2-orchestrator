import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * One-click onboarding (COORDINATION.md W18, Step 1 roadmap) — "Confirm what
 * the runtime learned" per the source doc's "Onboarding apps from AI
 * builders": before asking the owner anything, the runtime scans the app and
 * produces a one-page plain-language app profile for the owner to confirm or
 * correct. This is the one Step 1 roadmap item every prior gap-analysis pass
 * flagged as completely unbuilt (docs/step1-self-healing-gap-analysis.md).
 *
 * Deliberately NOT built here: the "Connect" step (a real GitHub OAuth app
 * registration) and the "Go live" step (SDK injection, domain move) — both
 * need a real hosted-app/OAuth infrastructure decision that a CLI script
 * can't responsibly guess at. This covers the middle step only: turning a
 * repo (already checked out locally, as if "Connect" had already happened)
 * into the plain-language profile the owner reviews next.
 *
 * Read-only by design: the scanning agent gets Read/Grep/Glob and nothing
 * else — no Bash, no Write/Edit — since there is no legitimate reason for an
 * app-understanding scan to ever change a single byte of the target repo.
 */

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
const MAX_TURNS = 25;
const MAX_BUDGET_USD = 1;

export type StyleGuide = {
  colors: string[];
  framework: string;
};

/** Fields the scanning agent produces from reading the repo. Kept separate
 * from `AppProfile` so the pure parser has a narrow, testable contract that
 * doesn't depend on the (non-deterministic) Sentry lookup or a timestamp. */
export type RawAppProfileFields = {
  purpose: string;
  targetUsers: string;
  featureMap: string[];
  styleGuide: StyleGuide | null;
  toneOfVoice: string | null;
  businessModel: string | null;
  caveats: string[];
};

export type CurrentState = {
  unresolvedSentryIssues: number;
};

export type AppProfile = RawAppProfileFields & {
  /** Per the source doc's table, competitors come from "web and store search
   * based on the purpose" — a live external search, not a local code scan.
   * Explicitly not attempted here rather than fabricated; always null with a
   * caveat, same discipline as W11's per-user model leaving unobservable
   * fields honestly null instead of inventing values for them. */
  competitors: null;
  currentState: CurrentState | null;
  currentStateCaveat: string;
  scannedAt: string;
};

export type ScanResult = { ok: true; profile: AppProfile } | { ok: false; reason: string };

function buildScanPrompt(): string {
  return `You are the onboarding scanner for a small app runtime, doing the
"automatic app understanding" step described here: before asking the app's
owner anything, learn everything you can from the code itself so the owner
only has to confirm or correct a summary, not answer questions from scratch.

Explore the repo in your current working directory using Read/Grep/Glob
(read-only — you have no Bash, Write, or Edit tools, and should not attempt
to use any). Look at: routes/pages and their components, package.json,
README, any styling/theme config (e.g. Tailwind config, CSS custom
properties, a design-tokens file), UI copy and headings, and any code that
looks payment/billing/pricing-related.

Determine, as concretely as you can from what you actually find (don't
guess or invent anything you can't point to in the code):

1. purpose: one or two plain-language sentences on what this app does and
   what problem it solves for its users.
2. targetUsers: one sentence on who it's for, based on the app's own
   language/framing, not a generic guess.
3. featureMap: a short list of the main features/flows you found (e.g. one
   entry per route or major component), in plain language, not file paths.
4. styleGuide: if you can find real colors and a UI framework (e.g. from a
   Tailwind config, CSS variables, or component library usage), report
   {colors: [...], framework: "..."}. If you genuinely can't find a style
   system, use null — do not invent colors.
5. toneOfVoice: one sentence describing the app's actual UI wording style
   (e.g. "casual and encouraging", "terse and technical"), grounded in real
   strings you read, or null if there isn't enough UI copy to judge.
6. businessModel: one sentence if you find real payment/pricing/subscription
   code or copy, describing what you found — or null if there's no such code
   at all. Do not assume a business model that isn't evidenced in the repo.
7. caveats: a list of honest gaps or uncertainties in this profile — e.g.
   "no payment code found, so businessModel is null", "styleGuide inferred
   from Tailwind config only, no explicit brand colors found". Always
   include at least one entry if any field above is null, explaining why.

When finished, end your final message with a line reading exactly
APP_PROFILE_JSON: followed immediately by a single fenced \`\`\`json code
block containing exactly this shape and nothing else after the closing
fence:

{
  "purpose": "...",
  "targetUsers": "...",
  "featureMap": ["...", "..."],
  "styleGuide": {"colors": ["..."], "framework": "..."} | null,
  "toneOfVoice": "..." | null,
  "businessModel": "..." | null,
  "caveats": ["..."]
}`;
}

/** Pure and separately tested, same discipline as swarm.ts's `parseVerdict`:
 * an agent transcript that errored, ran out of turns, or produced malformed
 * JSON must fail closed (return null) rather than silently produce a
 * half-formed or fabricated profile. */
export function parseAppProfileFields(finalText: string, isError: boolean): RawAppProfileFields | null {
  if (isError) return null;

  const markerIndex = finalText.indexOf("APP_PROFILE_JSON:");
  if (markerIndex === -1) return null;

  const afterMarker = finalText.slice(markerIndex);
  const fenceMatch = afterMarker.match(/```json\s*([\s\S]*?)```/);
  if (!fenceMatch) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fenceMatch[1]);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;

  if (typeof p.purpose !== "string" || !p.purpose.trim()) return null;
  if (typeof p.targetUsers !== "string" || !p.targetUsers.trim()) return null;
  if (!Array.isArray(p.featureMap) || !p.featureMap.every((f) => typeof f === "string")) return null;
  if (!Array.isArray(p.caveats) || !p.caveats.every((c) => typeof c === "string")) return null;

  const styleGuide = p.styleGuide;
  let validStyleGuide: StyleGuide | null = null;
  if (styleGuide !== null) {
    if (typeof styleGuide !== "object" || styleGuide === null) return null;
    const sg = styleGuide as Record<string, unknown>;
    if (
      !Array.isArray(sg.colors) ||
      !sg.colors.every((c: unknown) => typeof c === "string") ||
      typeof sg.framework !== "string"
    ) {
      return null;
    }
    validStyleGuide = { colors: sg.colors as string[], framework: sg.framework };
  }

  const toneOfVoice = p.toneOfVoice;
  if (toneOfVoice !== null && typeof toneOfVoice !== "string") return null;

  const businessModel = p.businessModel;
  if (businessModel !== null && typeof businessModel !== "string") return null;

  return {
    purpose: p.purpose,
    targetUsers: p.targetUsers,
    featureMap: p.featureMap as string[],
    styleGuide: validStyleGuide,
    toneOfVoice: (toneOfVoice as string | null) ?? null,
    businessModel: (businessModel as string | null) ?? null,
    caveats: p.caveats as string[],
  };
}

async function runScanAgent(repoPath: string): Promise<{ finalText: string; isError: boolean }> {
  let finalText = "";
  let isError = false;

  try {
    for await (const message of query({
      prompt: buildScanPrompt(),
      options: {
        cwd: repoPath,
        model: MODEL,
        permissionMode: "bypassPermissions",
        maxTurns: MAX_TURNS,
        maxBudgetUsd: MAX_BUDGET_USD,
        persistSession: false,
        settingSources: [],
        settings: { disableClaudeAiConnectors: true },
        // Read-only exploration only — no Bash, no Write/Edit. There is no
        // legitimate reason for an app-understanding scan to execute a
        // command or change a file in the target repo.
        tools: ["Read", "Grep", "Glob"],
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

  return { finalText, isError };
}

/** Best-effort "current state" via Sentry's unresolved-issue count. Entirely
 * optional — an app with no Sentry configured yet (or no token available)
 * still gets a full profile, just with `currentState: null` and an honest
 * caveat, not a hard failure. Deliberately a local implementation rather
 * than reusing sources/sentry.ts's `fetchLatestUnresolvedIssue` — that
 * function returns one BugReport; this only needs a count. */
async function fetchCurrentState(
  sentryOrg: string,
  sentryProject: string,
): Promise<{ currentState: CurrentState | null; caveat: string }> {
  const token = process.env.SENTRY_AUTH_TOKEN;
  const regionUrl = process.env.SENTRY_REGION_URL ?? "https://sentry.io";
  if (!token) {
    return {
      currentState: null,
      caveat: "Sentry not queried: SENTRY_AUTH_TOKEN is not set.",
    };
  }

  try {
    const res = await fetch(
      `${regionUrl}/api/0/projects/${sentryOrg}/${sentryProject}/issues/?query=is:unresolved&limit=100`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      return {
        currentState: null,
        caveat: `Sentry query failed (HTTP ${res.status}) — current state unknown.`,
      };
    }
    const issues = (await res.json()) as unknown[];
    return { currentState: { unresolvedSentryIssues: issues.length }, caveat: "" };
  } catch (err) {
    return {
      currentState: null,
      caveat: `Sentry query threw (${(err as Error).message}) — current state unknown.`,
    };
  }
}

export async function scanAppProfile(
  repoPath: string,
  sentry?: { org: string; project: string },
): Promise<ScanResult> {
  const { finalText, isError } = await runScanAgent(repoPath);
  const fields = parseAppProfileFields(finalText, isError);
  if (!fields) {
    return {
      ok: false,
      reason: isError
        ? `Scan agent errored: ${finalText.slice(0, 500)}`
        : "Scan agent did not produce a valid APP_PROFILE_JSON block.",
    };
  }

  const { currentState, caveat } = sentry
    ? await fetchCurrentState(sentry.org, sentry.project)
    : { currentState: null, caveat: "No Sentry project configured for this app yet." };

  return {
    ok: true,
    profile: {
      ...fields,
      competitors: null,
      currentState,
      currentStateCaveat: caveat,
      scannedAt: new Date().toISOString(),
    },
  };
}

/** Renders the profile the way the source doc describes it reaching the
 * owner: "a one-page app profile in plain language" to confirm or correct —
 * not a JSON dump, not a developer-facing diff. */
export function renderAppProfilePlainLanguage(profile: AppProfile): string {
  const lines: string[] = [];
  lines.push("# App profile");
  lines.push("");
  lines.push(`**What it does:** ${profile.purpose}`);
  lines.push(`**Who it's for:** ${profile.targetUsers}`);
  lines.push("");
  lines.push("## Main features");
  if (profile.featureMap.length === 0) {
    lines.push("(none detected)");
  } else {
    for (const f of profile.featureMap) lines.push(`- ${f}`);
  }
  lines.push("");
  lines.push("## Style");
  lines.push(
    profile.styleGuide
      ? `${profile.styleGuide.framework}, colors: ${profile.styleGuide.colors.join(", ")}`
      : "Not detected.",
  );
  lines.push("");
  lines.push("## Tone of voice");
  lines.push(profile.toneOfVoice ?? "Not enough UI copy to judge.");
  lines.push("");
  lines.push("## Business model");
  lines.push(profile.businessModel ?? "No payment/pricing code found.");
  lines.push("");
  lines.push("## Competitors");
  lines.push("Not scanned — needs live web/store search, out of scope for this pass.");
  lines.push("");
  lines.push("## Current state");
  lines.push(
    profile.currentState
      ? `${profile.currentState.unresolvedSentryIssues} unresolved error(s) in Sentry.`
      : profile.currentStateCaveat,
  );
  if (profile.caveats.length > 0) {
    lines.push("");
    lines.push("## Notes");
    for (const c of profile.caveats) lines.push(`- ${c}`);
  }
  lines.push("");
  lines.push(`_Scanned ${profile.scannedAt}. Correct anything wrong before going live._`);
  return lines.join("\n");
}
