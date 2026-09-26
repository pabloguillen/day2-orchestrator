import { resolve } from "node:path";
import { applyChange, askQuestion, fetchPendingChangeCards, renderChangeCard, undoChange } from "./approvals";

/**
 * CLI for the plain-language approval cards (COORDINATION.md W20). Default
 * mode (no action flag) is read-only: lists every pending healing-pipeline
 * PR as a card, exactly what a non-technical owner would see per the source
 * doc's "Approvals without pull requests" — but takes no action.
 *
 * `--apply`/`--undo` are real GitHub actions (merge/close a PR) — hard to
 * fully reverse once merged, so this CLI never takes them implicitly or in
 * a batch; each requires its own explicit `--apply <n>` / `--undo <n>` /
 * `--ask <n> "..."` invocation, one change at a time, same "a human decides,
 * per change" posture as everywhere else the real pipeline can act.
 *
 * Usage:
 *   bun run src/approval-cli.ts --repo <path>                    # list (read-only)
 *   bun run src/approval-cli.ts --repo <path> --apply <pr>       # merge
 *   bun run src/approval-cli.ts --repo <path> --undo <pr>        # close, no merge
 *   bun run src/approval-cli.ts --repo <path> --ask <pr> "<question>"
 */

export function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    repo: get("--repo"),
    apply: get("--apply"),
    undo: get("--undo"),
    ask: get("--ask"),
    askText: get("--ask") ? args[args.indexOf("--ask") + 2] : undefined,
  };
}

async function main() {
  const { repo, apply, undo, ask, askText } = parseArgs();
  if (!repo) {
    console.error(
      "Usage: bun run src/approval-cli.ts --repo <path> " +
        "[--apply <pr> | --undo <pr> | --ask <pr> \"<question>\"]\n\n" +
        "No flag: lists every pending day2-fix-* PR as a plain-language card (read-only).",
    );
    process.exit(1);
  }
  const repoPath = resolve(repo);

  if (apply) {
    await applyChange(repoPath, Number(apply));
    console.log(`[day2-approval] Applied (merged) PR #${apply}.`);
    return;
  }
  if (undo) {
    await undoChange(repoPath, Number(undo));
    console.log(`[day2-approval] Undone (closed without merging) PR #${undo}.`);
    return;
  }
  if (ask) {
    if (!askText) {
      console.error('--ask requires a question: --ask <pr> "your question here"');
      process.exit(1);
    }
    await askQuestion(repoPath, Number(ask), askText);
    console.log(`[day2-approval] Posted question on PR #${ask}.`);
    return;
  }

  const cards = await fetchPendingChangeCards(repoPath);
  if (cards.length === 0) {
    console.log("[day2-approval] Nothing pending — no open day2-fix-* PRs.");
    return;
  }
  for (const card of cards) {
    console.log(renderChangeCard(card));
    console.log("\n" + "=".repeat(60) + "\n");
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[day2-approval] Fatal error:", err);
    process.exit(1);
  });
}
