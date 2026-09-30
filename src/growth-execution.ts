import {
  type Arm,
  type AllocatorState,
  armKey,
  decodeArmKey,
  loadAllocatorState,
  recordOutcome,
  saveAllocatorState,
} from "./growth-allocator";
import type { AuthenticityVerdict, ClaimCheckVerdict, Creative } from "./growth-creative";
import type { GrowthCapability, ToolBinding } from "./growth-tools-config";
import { evaluateSpend, type BudgetConfig, type SpendDecision, type SpendLedgerEntry, type SpendRequest } from "./spend-governance";

/**
 * Step 4 (self-distributing), Component 6 — execution layer + transparency
 * feed (COORDINATION.md W43, docs/step4-self-distributing-plan.md).
 *
 * Composes Components 1-5. Component 5 (`growth-creative.ts`, W42) landed
 * mid-build here (`9270381`) — confirmed its real `Creative`/
 * `ClaimCheckVerdict`/`AuthenticityVerdict` match this file's original
 * disclosed stand-ins byte-for-byte before importing them directly, same
 * dedup discipline `growth-allocator.ts`'s `GrowthCapability` stand-in
 * followed for Component 4.
 *
 * Architectural refinement beyond a stopgap, though: `executeChannelAction`
 * is designed to be **pure**, taking already-computed `claimsCheck`/
 * `authenticityCheck` verdicts as plain inputs rather than calling
 * Component 5's agents itself. This isn't just a way to avoid depending on
 * an unbuilt file — it matches this project's own standing discipline of
 * keeping every decision core pure and pushing agent calls into a thin,
 * separately-tested (or untested-by-unit-tests, live-validated-only)
 * wrapper: `evaluateAutonomy`/`evaluateSpend`/`selectArm` are all pure;
 * `calibration.ts` splits `parseCalibrationVerdict` (pure) from
 * `runSkepticCheck` (agent-invoking) the exact same way. Here, that thin
 * wrapper is whichever future orchestration script calls Component 5's real
 * `checkTruthfulClaims`/`checkAuthenticity` and then this function with
 * their results — not written yet, and not this component's job to write.
 */

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type ChannelExecutionOptions = {
  creative: Creative;
  claimsCheck: ClaimCheckVerdict;
  authenticityCheck: AuthenticityVerdict;
  /** Undefined for organic/free actions needing no external tool at all
   * (e.g. a plain referral-invite text post) — every tool-related gate
   * below is skipped in that case, never force-failed for having nothing
   * to resolve. Set by the caller from the same format→capability mapping
   * `growth-allocator.ts`'s own `buildCandidateArms` already used to decide
   * this arm was even proposable — not re-derived here, to avoid a second,
   * potentially-drifting copy of that mapping. */
  requiredCapability?: GrowthCapability;
  /** The real, already-resolved-and-selected binding (via Component 4's
   * `resolveBindings` + `selectBestFitBinding`), or `undefined` if nothing
   * resolved for `requiredCapability`. Already known to be `enabled` and,
   * for identity-bearing capabilities, already known to have a real
   * `connectedAccountRef` — `resolveBindings` only ever returns bindings
   * that clear both — so this function doesn't re-check either. */
  toolBinding?: ToolBinding;
  spendRequest: SpendRequest;
  budget: BudgetConfig;
  ledger: SpendLedgerEntry[];
  /** How many consecutive prior actions for this exact segment/channel were
   * `blocked_by_authenticity_check` immediately before this one — safety
   * rail 6's mechanical bar. Tracked by the caller (`growth-feed.ts`'s own
   * audit trail is the natural source), not by this function. */
  consecutiveGenericFlags: number;
  /** Default FALSE — opposite polarity from `release.ts`'s `dryRun`, same
   * late placement (checked last, immediately before the one real external
   * call). See the file header on why the polarity must differ: everything
   * upstream of a traffic shift in `release.ts` is reversible with an
   * earned track record; a real ad spend or a real public post is neither,
   * yet, for this system. */
  allowLiveAction?: boolean;
};

export type ChannelExecutionResult =
  | { status: "blocked_by_claims_check"; verdict: ClaimCheckVerdict }
  | { status: "blocked_by_authenticity_check"; verdict: AuthenticityVerdict }
  | { status: "blocked_by_budget"; spendDecision: SpendDecision }
  | { status: "blocked_by_tool_policy"; reason: string }
  | { status: "blocked_by_unconnected_account"; capability: GrowthCapability }
  | { status: "simulated_stopped_before_live_action"; spendDecision: SpendDecision; wouldSpendUsd: number; wouldPublishTo: string }
  | { status: "executed"; spendDecision: SpendDecision; externalRef: string }
  | { status: "execution_failed"; reason: string };

/** True if the binding's own `toolPolicy` explicitly forbids at least one
 * of its `allowedTools` — a real, if minimal, policy check rather than
 * assuming "enabled" alone means "safe to call." Deeper per-call SDK tool
 * matching is out of scope here; this is the honest floor. */
function hasAlwaysDenyPolicy(binding: ToolBinding): boolean {
  return (binding.toolPolicy ?? []).some((p) => p.permission_policy === "always_deny");
}

/**
 * Pure — see the file header. Order, real and unconditional up to the last
 * step, matching the plan exactly: claims-check → authenticity-check
 * (blocks only on the repeated-consecutive-flag rule, safety rail 6) →
 * account-connection check (`blocked_by_unconnected_account`, safety rail
 * 5) → `evaluateSpend` (real budget math, safety rails 1/2/3/7 all apply
 * here since they live inside `evaluateSpend` itself) → tool-policy check
 * → only then `allowLiveAction`, immediately before the one real external
 * call. The caller is responsible for calling `recordSpend` with the
 * returned `spendDecision` afterward — this function never writes to disk,
 * matching `spend-governance.ts`'s own "the ledger write is the caller's
 * job, evaluation is pure" split.
 */
export async function executeChannelAction(opts: ChannelExecutionOptions): Promise<ChannelExecutionResult> {
  if (!opts.claimsCheck.truthful || opts.claimsCheck.fabricatesTestimonialIdentity) {
    return { status: "blocked_by_claims_check", verdict: opts.claimsCheck };
  }

  if (opts.authenticityCheck.readsAsGeneric && opts.consecutiveGenericFlags >= 1) {
    return { status: "blocked_by_authenticity_check", verdict: opts.authenticityCheck };
  }

  if (opts.requiredCapability && !opts.toolBinding) {
    return { status: "blocked_by_unconnected_account", capability: opts.requiredCapability };
  }

  const spendDecision = evaluateSpend(opts.spendRequest, opts.budget, opts.ledger);
  if (!spendDecision.allowed) {
    return { status: "blocked_by_budget", spendDecision };
  }

  if (opts.toolBinding && hasAlwaysDenyPolicy(opts.toolBinding)) {
    return {
      status: "blocked_by_tool_policy",
      reason: `"${opts.toolBinding.mcpServerName}" has an always_deny tool policy configured.`,
    };
  }

  if (!opts.allowLiveAction) {
    return {
      status: "simulated_stopped_before_live_action",
      spendDecision,
      wouldSpendUsd: opts.spendRequest.amountUsd,
      wouldPublishTo: opts.toolBinding?.mcpServerName ?? "(organic — no external tool)",
    };
  }

  return performLiveAction(opts, spendDecision);
}

/**
 * The one real external call this whole plan gates behind `allowLiveAction`
 * — and, per the user's explicit "no real money, no real public-facing
 * action yet," deliberately not implemented in this pass. Unlike
 * `allowLiveSpend` (kept as a pure, unimplemented type-level seam per the
 * plan's ad-platform 3-way split), `allowLiveAction` IS a real, reachable
 * code path here — the ordering/placement above is provably correct and
 * live-testable — it just has nothing real to call yet, since no MCP
 * tool-invocation mechanism exists anywhere in this codebase, and honestly
 * reports that rather than faking a result. This is the concrete seam
 * where real tool invocation gets wired in once the owner authorizes it.
 */
async function performLiveAction(
  opts: ChannelExecutionOptions,
  _spendDecision: SpendDecision,
): Promise<ChannelExecutionResult> {
  void opts;
  return {
    status: "execution_failed",
    reason:
      "Live execution is not implemented in this pass — no real MCP tool-invocation mechanism exists yet. " +
      "allowLiveAction is real and reachable (unlike allowLiveSpend's pure type-level seam); calling out to " +
      "a real bound tool is deliberately unbuilt until the owner authorizes real spend/publishing.",
  };
}

// ---------------------------------------------------------------------------
// Reconciliation — folding real outcomes back into the allocator
// ---------------------------------------------------------------------------

/** A device landing via a real, executed creative — `armKey` is the exact
 * encoding `growth-allocator.ts`'s `armKey()` produces, carried through
 * the real `acquisition_landing` event's metadata (`{source, campaign,
 * creativeId, armKey}`) so this can attribute the landing back to the arm
 * that produced it. `creativeId` links 1:1 back to the specific
 * `GrowthActionRecord` that spent the money — not just the arm in general,
 * since the same arm/format gets tried many times over. */
export type AcquisitionEvent = { creativeId: string; armKey: string; deviceId: string; landedAt: string };
/** A later real signal for the same device — e.g. `expense_added`, matching
 * the per-user model's own "did a second real signal follow" activation
 * bar (Step 2). Deliberately generic (not tied to one specific event type)
 * — what counts as activation is the caller's real, current definition of
 * it, not hardcoded here. */
export type ActivationEvent = { deviceId: string; occurredAt: string };

const DEFAULT_ACTIVATION_WINDOW_DAYS = 14;

/**
 * Pure. Folds real-world outcomes for `executed` `GrowthActionRecord`s into
 * `AllocatorState`, exactly once per `creativeId` (tracked via
 * `AllocatorState.reconciledCreativeIds`, so repeated on-demand runs are
 * naturally idempotent — never re-derives an already-recorded outcome, and
 * never fabricates one for a record with no real acquisition signal yet;
 * those are simply left for the next run).
 *
 * Deliberately skips every record whose `executionResult !== "executed"` —
 * a `simulated_stopped_before_live_action` record never actually ran, so
 * there is no real acquisition/activation signal to look for; treating its
 * absence as a "failure" would be inventing data, not reconciling it. In
 * this pass, `executed` is unreachable in practice (see `performLiveAction`)
 * — this function is built and tested against synthetic `executed` records
 * now anyway, same discipline as `dryRun`/`allowCalibrationOverride`'s own
 * real-but-not-yet-exercised-in-production branches elsewhere in this
 * project.
 */
export function reconcileOutcomes(
  state: AllocatorState,
  records: Pick<GrowthActionRecordForReconciliation, "creativeId" | "arm" | "executionResult" | "spendRequested">[],
  acquisitionEvents: AcquisitionEvent[],
  activationEvents: ActivationEvent[],
  windowDays: number = DEFAULT_ACTIVATION_WINDOW_DAYS,
): { state: AllocatorState; reconciledCreativeIds: string[] } {
  const alreadyReconciled = new Set(state.reconciledCreativeIds ?? []);
  let next = state;
  const newlyReconciled: string[] = [];
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  for (const record of records) {
    if (alreadyReconciled.has(record.creativeId)) continue;
    if (record.executionResult !== "executed") continue;

    const landing = acquisitionEvents.find((e) => e.creativeId === record.creativeId);
    if (!landing) continue; // no real signal yet — retry on the next reconciliation run

    const landedAtMs = new Date(landing.landedAt).getTime();
    const success = activationEvents.some((a) => {
      if (a.deviceId !== landing.deviceId) return false;
      const delta = new Date(a.occurredAt).getTime() - landedAtMs;
      return delta >= 0 && delta <= windowMs;
    });

    next = recordOutcome(next, record.arm, success, record.spendRequested);
    newlyReconciled.push(record.creativeId);
  }

  if (newlyReconciled.length === 0) return { state: next, reconciledCreativeIds: [] };
  return {
    state: { ...next, reconciledCreativeIds: [...alreadyReconciled, ...newlyReconciled] },
    reconciledCreativeIds: newlyReconciled,
  };
}

/** Minimal shape `reconcileOutcomes` actually needs from a `GrowthActionRecord`
 * — declared here (not importing all of `growth-feed.ts`'s richer type) so
 * this file's own test suite doesn't need a full `GrowthActionRecord`
 * fixture just to exercise pure reconciliation logic. `growth-feed.ts`'s
 * real `GrowthActionRecord` structurally satisfies this via its
 * `creativeId`/`arm`/`executionResult`/`spend.requested` fields — the thin
 * file wrapper below maps between them. */
export type GrowthActionRecordForReconciliation = {
  creativeId: string;
  arm: Arm;
  executionResult: ChannelExecutionResult["status"];
  spendRequested: number;
};

/** Thin file-I/O wrapper around the pure core above — reads real
 * `AllocatorState` from disk via `growth-allocator.ts`'s own
 * `loadAllocatorState`/`saveAllocatorState`, reconciles, writes the updated
 * state back. Takes already-loaded `records` (see
 * `GrowthActionRecordForReconciliation` above) rather than reading the
 * audit file itself, so this file never needs to import `growth-feed.ts`
 * (which in turn types its own `GrowthActionRecord.executionResult` against
 * this file's `ChannelExecutionResult` — importing both directions would be
 * circular); whoever calls this in practice reads real records via
 * `growth-feed.ts`'s `loadGrowthActions` first. No scheduler triggers this
 * (Component 3's own "closing the loop" open question) — run on demand,
 * same idiom as every other feed/CLI in this project. */
export function reconcileOutcomesIntoAllocator(
  records: GrowthActionRecordForReconciliation[],
  allocatorStatePath: string,
  acquisitionEvents: AcquisitionEvent[],
  activationEvents: ActivationEvent[],
): { state: AllocatorState; reconciledCreativeIds: string[] } {
  const state = loadAllocatorState(allocatorStatePath);
  const result = reconcileOutcomes(state, records, acquisitionEvents, activationEvents);
  saveAllocatorState(allocatorStatePath, result.state);
  return result;
}

// Re-exported so a caller assembling a real `acquisition_landing` event's
// `armKey` metadata field (or decoding one back) doesn't need a second
// import from `growth-allocator.ts` just for this.
export { armKey, decodeArmKey };

// ---------------------------------------------------------------------------
// Closed loop M1 (docs/closed-loop-spec.md) — real acquisition events in
// ---------------------------------------------------------------------------

/** Structural, not imported — `orchestrator/` and `expense-buddy/` are
 * separate deployable repos with no runtime dependency between them, same
 * disclosed-duplication call this file already makes for its own stand-in
 * types (see the file header, Component 5's `Creative` stand-in). Matches
 * `expense-buddy/src/server.ts`'s real `StoredEvent` shape field-for-field. */
export type StoredEventLike = {
  type: string;
  at: string;
  metadata: unknown;
  acquisition?: {
    touch: "first";
    channel: string;
    source?: string;
    medium?: string;
    campaignId?: string;
    creativeId?: string;
    armKey?: string;
    referrerUserId?: string;
    landingPath: string;
    firstSeenAt: string;
  };
};

/**
 * Resolves the spec's flagged conflict #3 (docs/closed-loop-spec.md
 * header): `day2-acquisition.ts` (expense-buddy) deliberately reuses this
 * file's own `armKey`/`creativeId` field names in its richer
 * `AcquisitionContext`, so this adapter needs no field-mapping logic beyond
 * picking the two fields `reconcileOutcomes` actually reads. Returns `null`
 * for a non-`acquisition_landing` event, or one missing `armKey`/`creativeId`
 * (an organic/unattributed landing — not every real visit came from a day2
 * arm) — never fabricates an `AcquisitionEvent` for a landing this arm's
 * own allocator can't attribute back to anything. Uses the event's
 * server-assigned `at` for `landedAt`, not the client-supplied
 * `firstSeenAt` — `at` is trustworthy (server clock, set inside
 * `handleEvents`), a client timestamp isn't. */
export function acquisitionEventFromStoredEvent(
  deviceId: string,
  event: StoredEventLike,
): AcquisitionEvent | null {
  if (event.type !== "acquisition_landing") return null;
  const acq = event.acquisition;
  if (!acq?.armKey || !acq.creativeId) return null;
  return { creativeId: acq.creativeId, armKey: acq.armKey, deviceId, landedAt: event.at };
}

/** Batches the above over one device's full stored event log — the shape
 * `reconcileOutcomesIntoAllocator` actually needs its `acquisitionEvents`
 * argument built from. Filters, doesn't throw, on events with no
 * attributable landing. */
export function acquisitionEventsFromStoredEvents(
  deviceId: string,
  events: StoredEventLike[],
): AcquisitionEvent[] {
  return events
    .map((e) => acquisitionEventFromStoredEvent(deviceId, e))
    .filter((e): e is AcquisitionEvent => e !== null);
}
