import { $ } from "bun";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneIsolatedWorkspace } from "../git";
import { gitEnv } from "../tenant";
import type { ReleaseDeps } from "./pass";
import type { Change } from "./types";

/**
 * The git side of releasing: what's on main, what changed, a checkout with
 * dependencies installed (kept for the release's lifetime, so each pass
 * doesn't reinstall), and the version bump a store release needs — made as
 * its own small pull request that day2 merges (it changes nothing but the
 * version).
 */

const TICKET_RE = /\bD2-\d+\b/;

/** Reads files as they are on origin's default branch (fetched), not the local working tree. */
export async function mainReader(repoPath: string): Promise<(path: string) => string | null> {
  await $`git -C ${repoPath} fetch origin`.env(await gitEnv()).quiet().nothrow();
  const ref = (await $`git -C ${repoPath} symbolic-ref --short refs/remotes/origin/HEAD`.quiet().nothrow().text()).trim() || "origin/main";
  const files = new Map<string, string | null>();
  for (const f of ["package.json", "app.json", "app.config.ts", "app.config.js", "eas.json"]) {
    const r = await $`git -C ${repoPath} show ${`${ref}:${f}`}`.quiet().nothrow();
    files.set(f, r.exitCode === 0 ? r.stdout.toString() : null);
  }
  return (p) => files.get(p) ?? null;
}

/** Pure. "1.4.0" → the app.json / app.config text with that version, or null when it isn't a plain value. */
export function withVersion(text: string, file: string, to: string): string | null {
  if (file.endsWith(".json")) {
    try {
      const j = JSON.parse(text) as { expo?: { version?: string }; version?: string };
      const target = j.expo ?? j;
      if (typeof target.version !== "string") return null;
      target.version = to;
      return `${JSON.stringify(j, null, 2)}\n`;
    } catch {
      return null;
    }
  }
  const re = /(\bversion\s*:\s*)(["'])(\d+\.\d+(?:\.\d+)?)\2/;
  return re.test(text) ? text.replace(re, `$1$2${to}$2`) : null;
}

/** Pure. Which install command the lockfile asks for. */
export function installCommand(dir: string): string[] {
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return ["bun", "install", "--frozen-lockfile"];
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return ["npx", "--yes", "pnpm@9", "install", "--frozen-lockfile"];
  if (existsSync(join(dir, "yarn.lock"))) return ["npx", "--yes", "yarn@1", "install", "--frozen-lockfile"];
  return ["npm", "ci", "--no-audit", "--no-fund"];
}

export function gitWorkdirs(appId: string, repoPath: string): ReleaseDeps["git"] {
  const branch = async () => {
    const ref = (await $`git -C ${repoPath} symbolic-ref --short refs/remotes/origin/HEAD`.quiet().nothrow().text()).trim();
    return ref || "origin/main";
  };
  return {
    async head() {
      await $`git -C ${repoPath} fetch origin`.env(await gitEnv()).quiet();
      const [sha, at] = (await $`git -C ${repoPath} log -1 --format=%H%x09%cI ${await branch()}`.quiet().text()).trim().split("\t");
      return { sha: sha!, at: at! };
    },
    async changes(from, to) {
      const range = from ? `${from}..${to}` : `${to}~20..${to}`;
      const out = (await $`git -C ${repoPath} log --reverse --format=%H%x09%s ${range}`.quiet().nothrow().text()).trim();
      return out
        .split("\n")
        .filter(Boolean)
        .map((l): Change => {
          const [sha, subject = ""] = l.split("\t");
          return { sha: sha!, subject, ticketId: subject.match(TICKET_RE)?.[0] ?? null };
        });
    },
    async checkout(sha) {
      const dir = join(tmpdir(), `day2-release-${appId.replace(/[^A-Za-z0-9_-]/g, "_")}-${sha.slice(0, 12)}`);
      const done = async () => rmSync(dir, { recursive: true, force: true });
      if (existsSync(join(dir, ".day2-ready"))) return { dir, done };
      rmSync(dir, { recursive: true, force: true });
      const clone = await cloneIsolatedWorkspace(repoPath);
      await $`mv ${clone} ${dir}`.quiet();
      await $`git -C ${dir} checkout ${sha}`.quiet();
      const install = installCommand(dir);
      const r = await $`${install}`.cwd(dir).env({ ...process.env, CI: "1" }).quiet().nothrow();
      if (r.exitCode !== 0) throw new Error(`Installing the app's dependencies failed: ${r.stderr.toString().trim().split("\n").slice(-3).join(" ")}`);
      writeFileSync(join(dir, ".day2-ready"), sha);
      return { dir, done };
    },
    async bumpVersion(to) {
      const work = await cloneIsolatedWorkspace(repoPath);
      try {
        const file = ["app.json", "app.config.ts", "app.config.js"].find((f) => existsSync(join(work, f)));
        if (!file) return null;
        const next = withVersion(readFileSync(join(work, file), "utf-8"), file, to);
        if (!next) return null;
        const env = await gitEnv();
        const br = `day2-release-${to}`;
        await $`git -C ${work} checkout -B ${br}`.quiet();
        writeFileSync(join(work, file), next);
        await $`git -C ${work} add ${file}`.quiet();
        await $`git -C ${work} -c user.name=day2 -c user.email=day2@users.noreply.github.com commit -m ${`Release ${to}`}`.quiet();
        await $`git -C ${work} push -u origin ${br} --force`.env(env).quiet();
        const body = `Raises the app version to ${to} for the next store release (native changes). Only the version changes; day2 merges this itself and releases from it.`;
        const created = await $`gh pr create --title ${`Release ${to}`} --body ${body} --head ${br}`.cwd(work).env(env).quiet().nothrow();
        if (created.exitCode !== 0 && !/already exists/.test(created.stderr.toString())) return null;
        const merged = await $`gh pr merge ${br} --squash --delete-branch`.cwd(work).env(env).quiet().nothrow();
        if (merged.exitCode !== 0) return null;
        await $`git -C ${repoPath} fetch origin`.env(env).quiet();
        return (await $`git -C ${repoPath} rev-parse ${await branch()}`.quiet().text()).trim();
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
}
