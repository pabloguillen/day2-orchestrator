import { $ } from "bun";
import { rmSync } from "node:fs";
import { DEFAULT_AUTONOMY_CONFIG, evaluateAutonomy, recordAutonomyAudit } from "./autonomy";
import { checkoutSha, cloneIsolatedWorkspace } from "./git";
import { runSwarm, type PersonaResult } from "./swarm";
import type { AutonomyConfig, AutonomyDecision, ChangeForAutonomy } from "./types";

/**
 * Canary rollout + automatic rollback for the release pipeline — Step 1
 * scope, see STAGE1.md. This is a genuinely new capability, separate from
 * the healing pipeline (`pipeline.ts`): it takes an *already-merged* commit
 * on `main` and controls how it actually reaches production traffic, via
 * Cloudflare Workers' native Versions/Gradual-Deployments feature rather
 * than a hand-rolled traffic splitter.
 *
 * Deliberately invoked explicitly (see `index.ts`'s `canary` command), not
 * auto-triggered from `pipeline.ts` — today's autonomy level is L2
 * ("Prepare": a human merges the PR). Wiring this to run automatically post-
 * merge is future work gated on the autonomy-level model (STAGE1.md W4),
 * which decides *whether* an auto-release is allowed; this module only
 * handles *how* one is carried out safely once authorized.
 */

const DEFAULT_CANARY_PERCENT = 5;
const DEFAULT_MONITOR_MINUTES = 15;
const DEFAULT_POLL_INTERVAL_SECONDS = 30;
/** Zero-tolerance by default: expense-buddy's real traffic is low enough
 * (STAGE0.md) that a rate-normalized threshold would be noise — "any
 * canary-tagged error at all" is a defensible v1 guardrail. Override via
 * `errorThreshold` once real traffic volume justifies a rate-based one. */
const DEFAULT_ERROR_THRESHOLD = 0;

export type CanaryReleaseOptions = {
  repoPath: string;
  /** The already-merged `main` commit to release. */
  sha: string;
  sentryOrg: string;
  sentryProject: string;
  workerName: string;
  /** % of production traffic to shift to the canary. */
  canaryPercent?: number;
  /** How long to watch Sentry for `release:<sha>`-tagged errors before
   * deciding. */
  monitorMinutes?: number;
  pollIntervalSeconds?: number;
  /** Canary-tagged error count above which the release is rolled back. */
  errorThreshold?: number;
  /** Upload + smoke-check the version, but stop before shifting any real
   * production traffic. Used to validate the mechanism without touching
   * live traffic — see STAGE1.md's safety stance. */
  dryRun?: boolean;
  /** Skips the swarm v1 persona check (STAGE1.md/COORDINATION.md W13).
   * Off by default — this is a real pre-release safety gate, not an
   * optional extra. Exists for cheap iteration/testing of the release
   * mechanism itself without paying the swarm's agent cost every time. */
  skipSwarmCheck?: boolean;
};

export type CanaryReleaseResult =
  | { status: "smoke_check_failed"; reason: string; canaryVersionId: string }
  | {
      status: "swarm_check_failed";
      reason: string;
      canaryVersionId: string;
      personaResults: PersonaResult[];
    }
  | {
      status: "rolled_back";
      reason: string;
      errorCount: number;
      canaryVersionId: string;
      stableVersionId: string;
    }
  | { status: "promoted"; errorCount: number; canaryVersionId: string }
  | { status: "dry_run_stopped_before_traffic_shift"; canaryVersionId: string; previewUrl: string };

/** Pure decision function — unit-tested independently of any live
 * Cloudflare/Sentry call. Errors strictly above `threshold` roll back;
 * everything else promotes. */
export function evaluateGuardrail(
  errorCount: number,
  threshold: number = DEFAULT_ERROR_THRESHOLD,
): { decision: "promote" | "rollback"; reason: string } {
  if (errorCount > threshold) {
    return {
      decision: "rollback",
      reason: `${errorCount} canary-tagged error(s) observed (threshold: ${threshold}).`,
    };
  }
  return {
    decision: "promote",
    reason: `${errorCount} canary-tagged error(s) observed (threshold: ${threshold}) — clean.`,
  };
}

/** Counts Sentry issue events tagged with this exact release (git SHA).
 * Since each SHA is only ever deployed once, "all events ever tagged with
 * this release" and "all events during this canary's window" are the same
 * set — no need for Sentry's coarse `statsPeriod` buckets (`''`, `24h`,
 * `14d` only — verified against the real API) to line up with the actual
 * monitoring window. */
export async function fetchCanaryErrorCount(
  sentryOrg: string,
  sentryProject: string,
  release: string,
): Promise<number> {
  const token = process.env.SENTRY_AUTH_TOKEN;
  const regionUrl = process.env.SENTRY_REGION_URL ?? "https://sentry.io";
  if (!token) throw new Error("SENTRY_AUTH_TOKEN is not set.");

  const res = await fetch(
    `${regionUrl}/api/0/projects/${sentryOrg}/${sentryProject}/issues/?query=${encodeURIComponent(`release:${release}`)}&statsPeriod=24h&limit=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error(`Sentry API error ${res.status}: ${await res.text()}`);
  }
  const issues = (await res.json()) as Array<{ count: string }>;
  return issues.reduce((sum, issue) => sum + (Number(issue.count) || 0), 0);
}

/** Registers a new Worker version. This alone never affects production
 * traffic — verified against the real deployment (upload, then confirmed
 * `wrangler deployments list` and the live prod URL were both unchanged).
 * Only `deployTraffic` (below) actually routes traffic. */
async function uploadVersion(cwd: string, message: string): Promise<{ versionId: string; previewUrl: string }> {
  const output = await $`bunx wrangler versions upload --message ${message}`.cwd(cwd).text();
  const versionMatch = output.match(/Worker Version ID:\s*([0-9a-f-]{36})/i);
  const previewMatch = output.match(/Version Preview URL:\s*(\S+)/i);
  if (!versionMatch) {
    throw new Error(`Could not parse Worker Version ID from wrangler output:\n${output}`);
  }
  return { versionId: versionMatch[1]!, previewUrl: previewMatch?.[1] ?? "" };
}

/** Finds the currently-live 100% version. Refuses to start a new canary on
 * top of an already-split deployment (a prior canary mid-flight, or a
 * manual split left in a partial state) rather than guessing which side is
 * "stable". */
async function getCurrentStableVersionId(cwd: string, workerName: string): Promise<string> {
  const output = await $`bunx wrangler deployments list --name ${workerName}`.cwd(cwd).text();
  const matches = [...output.matchAll(/\((\d+)%\)\s*([0-9a-f-]{36})/gi)];
  if (matches.length === 0) {
    throw new Error(`Could not find any deployed version in wrangler deployments list output:\n${output}`);
  }
  const [, percent, versionId] = matches[matches.length - 1]!;
  if (Number(percent) !== 100) {
    throw new Error(
      `Current deployment isn't 100% on a single version (found ${percent}% on ${versionId}) — ` +
        `a canary may already be mid-flight. Refusing to start another one on top of it.`,
    );
  }
  return versionId!;
}

/** Hits the canary version's own isolated preview URL — reachable but
 * carrying zero production traffic — before any real user is exposed to
 * it. A dead/500ing canary is caught here, not after real traffic hits it. */
async function smokeCheckPreview(previewUrl: string): Promise<{ ok: boolean; reason?: string }> {
  if (!previewUrl) return { ok: false, reason: "no preview URL returned by wrangler" };
  try {
    const res = await fetch(previewUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, reason: `preview URL returned HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `preview URL unreachable: ${(err as Error).message}` };
  }
}

async function deployTraffic(cwd: string, specs: string[], message: string): Promise<void> {
  await $`bunx wrangler versions deploy ${specs} --yes --message ${message}`.cwd(cwd).quiet();
}

export async function runCanaryRelease(opts: CanaryReleaseOptions): Promise<CanaryReleaseResult> {
  const canaryPercent = opts.canaryPercent ?? DEFAULT_CANARY_PERCENT;
  const monitorMinutes = opts.monitorMinutes ?? DEFAULT_MONITOR_MINUTES;
  const pollIntervalSeconds = opts.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
  const errorThreshold = opts.errorThreshold ?? DEFAULT_ERROR_THRESHOLD;

  const cwd = await cloneIsolatedWorkspace(opts.repoPath);
  try {
    await checkoutSha(cwd, opts.sha);

    console.log(`[day2-release] Building ${opts.sha} (VITE_RELEASE=${opts.sha})...`);
    const buildEnv = { ...process.env, VITE_RELEASE: opts.sha };
    await $`bun install --frozen-lockfile`.cwd(cwd).env(buildEnv).quiet();
    await $`bun run build`.cwd(cwd).env(buildEnv).quiet();

    console.log(`[day2-release] Uploading version (no traffic yet)...`);
    const { versionId: canaryVersionId, previewUrl } = await uploadVersion(
      cwd,
      `day2 canary ${opts.sha.slice(0, 8)}`,
    );
    console.log(`[day2-release] Version ${canaryVersionId} uploaded. Preview: ${previewUrl}`);

    console.log(`[day2-release] Smoke-checking the preview URL before any production traffic shifts...`);
    const smoke = await smokeCheckPreview(previewUrl);
    if (!smoke.ok) {
      return { status: "smoke_check_failed", reason: smoke.reason ?? "unknown", canaryVersionId };
    }

    if (!opts.skipSwarmCheck) {
      console.log(
        `[day2-release] Running swarm v1 (persona pre-release checks) against the preview...`,
      );
      const swarm = await runSwarm(previewUrl);
      for (const r of swarm.results) {
        console.log(
          `[day2-release]   ${r.persona}: ${r.passed ? "PASS" : "FAIL"} — ${r.summary} ` +
            `($${r.costUsd.toFixed(3)})`,
        );
      }
      if (!swarm.allPassed) {
        return {
          status: "swarm_check_failed",
          reason: swarm.results
            .filter((r) => !r.passed)
            .map((r) => `${r.persona}: ${r.summary}`)
            .join("; "),
          canaryVersionId,
          personaResults: swarm.results,
        };
      }
    }

    if (opts.dryRun) {
      console.log(`[day2-release] --dry-run: stopping before any traffic shift.`);
      return { status: "dry_run_stopped_before_traffic_shift", canaryVersionId, previewUrl };
    }

    const stableVersionId = await getCurrentStableVersionId(cwd, opts.workerName);
    console.log(
      `[day2-release] Shifting ${canaryPercent}% of production traffic to ${canaryVersionId} ` +
        `(${100 - canaryPercent}% stays on ${stableVersionId})...`,
    );
    await deployTraffic(
      cwd,
      [`${canaryVersionId}@${canaryPercent}`, `${stableVersionId}@${100 - canaryPercent}`],
      `day2 canary rollout ${opts.sha.slice(0, 8)}`,
    );

    console.log(
      `[day2-release] Monitoring release:${opts.sha} for ${monitorMinutes}m ` +
        `(polling every ${pollIntervalSeconds}s, threshold ${errorThreshold})...`,
    );
    const deadline = Date.now() + monitorMinutes * 60_000;
    let errorCount = 0;
    while (Date.now() < deadline) {
      errorCount = await fetchCanaryErrorCount(opts.sentryOrg, opts.sentryProject, opts.sha);
      if (errorCount > errorThreshold) break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalSeconds * 1000));
    }

    const verdict = evaluateGuardrail(errorCount, errorThreshold);
    if (verdict.decision === "rollback") {
      console.log(`[day2-release] ${verdict.reason} Rolling back to ${stableVersionId}.`);
      await deployTraffic(
        cwd,
        [`${stableVersionId}@100`],
        `day2 auto-rollback ${opts.sha.slice(0, 8)}: ${verdict.reason}`,
      );
      return { status: "rolled_back", reason: verdict.reason, errorCount, canaryVersionId, stableVersionId };
    }

    console.log(`[day2-release] ${verdict.reason} Promoting ${canaryVersionId} to 100%.`);
    await deployTraffic(cwd, [`${canaryVersionId}@100`], `day2 promote ${opts.sha.slice(0, 8)}`);
    return { status: "promoted", errorCount, canaryVersionId };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * The join point between W3 (this file) and W4 (`autonomy.ts`): gates an
 * actual canary release behind the autonomy-level model rather than running
 * unconditionally. Always writes an audit entry, shipped or not — the
 * source doc's audit-trail requirement applies to every evaluated change,
 * not just the ones that auto-ship.
 *
 * With `DEFAULT_AUTONOMY_CONFIG` (L2 everywhere), `evaluateAutonomy` always
 * returns `autoShip: false`, so this always defers to a human — no change
 * to today's default behavior. Nothing currently *calls* this
 * automatically on merge (that needs a merge-detection mechanism — e.g. a
 * GitHub Actions workflow on `push` to `main` — which doesn't exist yet;
 * see STAGE1.md). This function is the building block for when it does.
 */
export async function maybeAutoRelease(
  change: ChangeForAutonomy,
  releaseOpts: CanaryReleaseOptions,
  config: AutonomyConfig = DEFAULT_AUTONOMY_CONFIG,
  auditFile = "day2-autonomy-audit.jsonl",
  summary?: string,
): Promise<{ decision: AutonomyDecision; result?: CanaryReleaseResult }> {
  const decision = evaluateAutonomy(change, config);
  recordAutonomyAudit(auditFile, change, decision, summary);
  if (!decision.autoShip) {
    console.log(`[day2-release] Not auto-shipping (${decision.reason}) — leave as a PR for a human.`);
    return { decision };
  }
  console.log(`[day2-release] Autonomy check passed (${decision.reason}) — starting canary release.`);
  const result = await runCanaryRelease(releaseOpts);
  return { decision, result };
}
