import { homedir } from "node:os";

/**
 * Shared sandbox/denylist config for every agent-invoking function in this
 * orchestrator: `agent.ts`'s fix/verifier agents, `swarm.ts`'s personas,
 * `calibration.ts`'s skeptic, `evolution.ts`'s proposal generator. This was
 * identical, hand-duplicated code in all four files — `calibration.ts` and
 * `evolution.ts` deliberately kept their own copies rather than editing
 * `swarm.ts`/`agent.ts` near the sandbox settings while GitHub Actions'
 * sandbox-tooling gap (COORDINATION.md W28: `ubuntu-latest` runners don't
 * ship `bubblewrap`/`socat`, so `failIfUnavailable: true` failed every
 * persona unconditionally in CI) was still being actively fixed there.
 * W28 landed (PR #37), closing that collision window — deduped here.
 *
 * Real OS-level sandboxing for command execution (fails loud rather than
 * silently running unsandboxed if unsupported on the host). Scoped
 * narrowly: this isn't network/filesystem lockdown — an agent may still
 * need to `bun install` and read its own repo tree — just denying the two
 * concrete things that must never leak into a shell that untrusted,
 * potentially attacker-influenced input (a bug report's text, a deployed
 * page's content) could ever steer: the orchestrator's own secrets, and
 * the credential stores under the operator's home directory.
 *
 * `CLOUDFLARE_API_TOKEN`/`~/.wrangler` are denied for the same reason as
 * Sentry/Anthropic, not a separate concern: `release.ts` runs real
 * `wrangler` deploys from this same operator environment, so whichever
 * credential wrangler picks up (env var or `~/.wrangler`'s OAuth session)
 * is just as reachable to a sandboxed agent's shell as `SENTRY_AUTH_TOKEN`
 * was before that got added here — found by re-auditing this denylist
 * against everything else in the repo that needs a real secret in this
 * process's environment, not by an incident.
 */

export const DENIED_ENV_VARS = [
  "SENTRY_AUTH_TOKEN",
  "SENTRY_REGION_URL",
  "ANTHROPIC_API_KEY",
  "CLOUDFLARE_API_TOKEN",
];

const home = homedir();
export const DENIED_READ_PATHS = [
  `${home}/.ssh`,
  `${home}/.aws`,
  `${home}/.claude`,
  `${home}/.config/gh`,
  `${home}/.netrc`,
  `${home}/.npmrc`,
  `${home}/.docker`,
  `${home}/.gnupg`,
  `${home}/.wrangler`,
];

/** The exact `sandbox` option object every agent-invoking `query()` call in
 * this orchestrator passes — a fresh object per call (not a shared
 * reference) so no caller can ever mutate another's config by touching the
 * object it got back. */
export function sandboxConfig() {
  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    failIfUnavailable: true,
    credentials: {
      envVars: DENIED_ENV_VARS.map((name) => ({ name, mode: "deny" as const })),
    },
    filesystem: { denyRead: [...DENIED_READ_PATHS] },
  };
}
