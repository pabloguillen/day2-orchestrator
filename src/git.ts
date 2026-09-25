import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Clones the target repo into a fresh, isolated temp directory and returns its
 * path. Never operate directly on a path someone might have checked out for
 * their own interactive work — the orchestrator switching branches out from
 * under a human's working directory is the same class of collision as
 * Stage 0 de-risk test #2's Lovable-sync finding, just self-inflicted instead
 * of happening to Lovable.
 */
export async function cloneIsolatedWorkspace(sourceRepoPath: string): Promise<string> {
  const remoteUrl = (
    await $`git -C ${sourceRepoPath} remote get-url origin`.quiet().text()
  ).trim();
  const workDir = mkdtempSync(join(tmpdir(), "day2-work-"));
  await $`git clone ${remoteUrl} ${workDir}`.quiet();
  return workDir;
}

/** Checks out a specific commit in an already-cloned isolated workspace —
 * used by the canary release path, which deploys a specific merged SHA
 * rather than whatever's currently at `origin/main`'s tip. */
export async function checkoutSha(cwd: string, sha: string) {
  await $`git -C ${cwd} fetch origin`.quiet();
  await $`git -C ${cwd} checkout ${sha}`.quiet();
}

/** Slugify a bug title into a git-safe branch suffix. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Creates a fresh branch off the current default branch and returns the branch
 * name. Never touches `main` directly — see Stage 0 de-risk test #2: a direct
 * push to the synced branch silently shelved the owner's own in-flight work.
 * Branch + PR is the only safe delivery path, not just a UX nicety.
 */
export async function createFixBranch(cwd: string, sourceId: string, title: string) {
  const branch = `day2-fix-${slugify(title)}-${sourceId.slice(0, 8)}`;
  await $`git -C ${cwd} fetch origin`.quiet();
  await $`git -C ${cwd} checkout -B ${branch} origin/main`.quiet();
  return branch;
}

export async function hasChanges(cwd: string): Promise<boolean> {
  const result = await $`git -C ${cwd} status --porcelain`.quiet().text();
  return result.trim().length > 0;
}

export async function commitAll(cwd: string, message: string) {
  await $`git -C ${cwd} add -A`.quiet();
  await $`git -C ${cwd} commit -m ${message}`.quiet();
}

export async function pushBranch(cwd: string, branch: string) {
  await $`git -C ${cwd} push -u origin ${branch}`.quiet();
}

export async function diffStat(cwd: string): Promise<string> {
  return $`git -C ${cwd} diff origin/main --stat`.quiet().text();
}
