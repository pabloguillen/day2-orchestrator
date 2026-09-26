import { $ } from "bun";
import { DEFAULT_AUTONOMY_CONFIG, evaluateAutonomy } from "./autonomy";
import type { ChangeForAutonomy } from "./types";

/**
 * Plain-language approval cards (COORDINATION.md W20) — the source doc's
 * "Approvals without pull requests": "Every change is shown as a plain-
 * language card: what happened, who was affected, what the runtime did, and
 * the evidence... The buttons are Apply, Undo and Ask a question."
 *
 * This is a real, currently-total gap: every fix this project has produced
 * so far (Stage 0 through W19/W21-23) still requires a human to go to
 * GitHub and click merge — there is no plain-language review surface for
 * either a technical or non-technical owner. `owner-feed.ts` (W6/W8) covers
 * the *retrospective* half (what already shipped); this covers the
 * *pending-decision* half.
 *
 * Deliberately scoped to only the healing pipeline's own output — PRs on a
 * `day2-fix-*` branch (see git.ts::createFixBranch) — not every open PR in
 * the repo. The doc's Apply/Undo/Ask/default-action table is specifically
 * about "changes" the runtime made; a human-authored feature branch isn't
 * that, and guessing at one would be overreach.
 *
 * "Apply" and "Undo" are real, hard-to-reverse GitHub actions (merge/close
 * a PR). This module only ever *takes* those actions when explicitly
 * invoked with the corresponding CLI flag — building the capability is not
 * the same as exercising it, same distinction this project has drawn for
 * canary/release before.
 */

export type ChangeCard = {
  number: number;
  title: string;
  branch: string;
  url: string;
  whatHappened: string;
  whatChanged: string;
  evidence: string;
  filesChanged: string[];
  defaultAction: "auto-apply" | "ask-first";
  defaultReason: string;
};

/** Pure and separately tested: parses the exact template agent.ts's
 * fix-agent is instructed to end its summary with (`## What happened` /
 * `## What changed` / `## Evidence`), which pr.ts writes verbatim as the PR
 * body. Falls back to putting the whole body under "what happened" rather
 * than throwing — a card with a slightly-off layout is still useful; a
 * crash on an unexpected format is not. */
export function parsePrBody(body: string): {
  whatHappened: string;
  whatChanged: string;
  evidence: string;
} {
  const section = (heading: string): string | null => {
    const re = new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n---\\n|$)`, "i");
    const match = body.match(re);
    return match ? match[1].trim() : null;
  };

  const whatHappened = section("What happened");
  const whatChanged = section("What changed");
  const evidence = section("Evidence");

  if (whatHappened === null && whatChanged === null && evidence === null) {
    return { whatHappened: body.trim() || "(no description provided)", whatChanged: "", evidence: "" };
  }

  return {
    whatHappened: whatHappened ?? "(not described)",
    whatChanged: whatChanged ?? "(not described)",
    evidence: evidence ?? "(not provided)",
  };
}

/** Reuses the same sensitive-path judgment `evaluateAutonomy` already makes
 * for the auto-release path, rather than re-implementing the pattern list —
 * one source of truth for "does this touch payments/auth/login/data".
 * Matches the source doc's own default-action table exactly: sensitive
 * changes always ask first; ordinary Step 1 bug fixes default to applying
 * automatically, with a notification and one-tap undo. */
export function classifyDefaultAction(filesChanged: string[]): {
  action: "auto-apply" | "ask-first";
  reason: string;
} {
  const change: ChangeForAutonomy = {
    sourceId: "approval-card",
    filesChanged,
    isBugfix: true,
    verifierApproved: true,
    ciPassed: true,
  };
  const decision = evaluateAutonomy(change, DEFAULT_AUTONOMY_CONFIG);

  if (decision.area === "sensitive-override") {
    return {
      action: "ask-first",
      reason: decision.reason,
    };
  }
  return {
    action: "auto-apply",
    reason:
      "Bug fix restoring intended behavior (Step 1) — per the source doc's own default, " +
      "these apply automatically with a notification and one-tap undo, unless a sensitive " +
      "path overrides that (see above).",
  };
}

type RawPr = {
  number: number;
  title: string;
  headRefName: string;
  url: string;
  body: string;
};

/** Lists every currently-open, healing-pipeline-authored PR (branch prefix
 * `day2-fix-`) as a plain-language `ChangeCard`. Read-only — only ever
 * calls `gh pr list`/`gh pr view`, never merges or closes anything. */
export async function fetchPendingChangeCards(repoPath: string): Promise<ChangeCard[]> {
  const listJson = await $`gh pr list --state open --json number,title,headRefName,url,body --limit 100`
    .cwd(repoPath)
    .text();
  const allOpen = JSON.parse(listJson) as RawPr[];
  const dayFixPrs = allOpen.filter((pr) => pr.headRefName.startsWith("day2-fix-"));

  const cards: ChangeCard[] = [];
  for (const pr of dayFixPrs) {
    const filesJson = await $`gh pr view ${pr.number} --json files`.cwd(repoPath).text();
    const { files } = JSON.parse(filesJson) as { files: Array<{ path: string }> };
    const filesChanged = files.map((f) => f.path);
    const { whatHappened, whatChanged, evidence } = parsePrBody(pr.body);
    const { action, reason } = classifyDefaultAction(filesChanged);

    cards.push({
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      url: pr.url,
      whatHappened,
      whatChanged,
      evidence,
      filesChanged,
      defaultAction: action,
      defaultReason: reason,
    });
  }
  return cards;
}

/** Matches the source doc's own card format: "what happened, who was
 * affected, what the runtime did, and the evidence", plus the
 * Apply/Undo/Ask-a-question affordances and which one is recommended by
 * default for this specific change. */
export function renderChangeCard(card: ChangeCard): string {
  return [
    `# ${card.title}`,
    "",
    `**What happened:** ${card.whatHappened}`,
    "",
    `**What we did:** ${card.whatChanged}`,
    "",
    `**Evidence:** ${card.evidence}`,
    "",
    card.defaultAction === "auto-apply"
      ? `**Recommended default: Apply** (with one-tap Undo after) — ${card.defaultReason}`
      : `**Recommended default: Ask a question first** — ${card.defaultReason}`,
    "",
    `[ Apply ]   [ Undo ]   [ Ask a question ]`,
    "",
    `_PR #${card.number} — ${card.url}_`,
  ].join("\n");
}

/** Real, hard-to-reverse action: merges the PR. Only ever called when a
 * caller explicitly asks for it (the CLI's `--apply` flag) — never as a
 * side effect of listing or rendering cards. */
export async function applyChange(repoPath: string, prNumber: number): Promise<void> {
  await $`gh pr merge ${prNumber} --squash`.cwd(repoPath).text();
}

/** Closes the PR without merging — "Undo" for a still-pending change.
 * Deliberately does not delete the branch or force-push anything; a closed,
 * unmerged PR is fully recoverable (reopenable) if that turns out wrong. */
export async function undoChange(repoPath: string, prNumber: number): Promise<void> {
  await $`gh pr close ${prNumber}`.cwd(repoPath).text();
}

/** "Ask a question" — takes no action on the change itself, just posts the
 * question as a PR comment so it's visible wherever the change is actually
 * reviewed (GitHub, in developer mode, per the source doc). */
export async function askQuestion(repoPath: string, prNumber: number, question: string): Promise<void> {
  await $`gh pr comment ${prNumber} --body ${question}`.cwd(repoPath).text();
}
