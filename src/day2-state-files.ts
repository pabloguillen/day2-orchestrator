import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * day2 keeps per-app state next to the app's code: day2-backlog.json,
 * day2-connect.json, day2-money.json, day2-mobile-releases.json,
 * day2-*.jsonl logs… They're day2's, never the customer's code, and must
 * never end up in a commit to the customer's repo.
 *
 * Two guards:
 *  - the checkout's own `.git/info/exclude` lists them (local to that
 *    checkout, never committed, doesn't touch the customer's .gitignore),
 *    so a `git add -A` there — by the owner or anything else — skips them;
 *  - every commit day2 makes with `git add -A` excludes them by pathspec
 *    (`COMMIT_EXCLUDES`), in case a clone has them anyway.
 */

export const STATE_PATTERNS = ["/day2-*.json", "/day2-*.jsonl", "/day2-*.tmp"] as const;
export const COMMIT_EXCLUDES = [":(exclude,glob)day2-*.json", ":(exclude,glob)day2-*.jsonl", ":(exclude,glob)day2-*.tmp"] as const;

/** Pure. Is this repo-relative path a day2 state file? */
export function isDay2StateFile(path: string): boolean {
  return /^day2-[^/]*\.(json|jsonl|tmp)$/.test(path.replace(/^\.\//, ""));
}

/** The checkout's git directory (a `.git` folder, or the folder a `.git` file points at), or null. */
function gitDir(repoPath: string): string | null {
  const dot = join(repoPath, ".git");
  if (!existsSync(dot)) return null;
  if (statSync(dot).isDirectory()) return dot;
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf-8"));
  if (!m) return null;
  const p = m[1]!.trim();
  return isAbsolute(p) ? p : resolve(repoPath, p);
}

/** Adds day2's state files to the checkout's .git/info/exclude (once). Best effort; true when they're excluded. */
export function excludeDay2State(repoPath: string): boolean {
  try {
    const dir = gitDir(repoPath);
    if (!dir) return false;
    const file = join(dir, "info", "exclude");
    const have = existsSync(file) ? readFileSync(file, "utf-8") : "";
    const missing = STATE_PATTERNS.filter((p) => !have.split("\n").includes(p));
    if (!missing.length) return true;
    mkdirSync(join(dir, "info"), { recursive: true });
    appendFileSync(file, `${have && !have.endsWith("\n") ? "\n" : ""}# day2's state files — never committed\n${missing.join("\n")}\n`);
    return true;
  } catch {
    return false;
  }
}
