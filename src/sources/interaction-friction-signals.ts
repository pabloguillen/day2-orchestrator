import type { Signal } from "../signals/types";
import type { AggregateFrictionSignal } from "../../sdk/friction-signals";

/**
 * Consumes any day2-managed app's `GET /api/day2-friction-signals`
 * endpoint (the generic contract `sdk/friction-signals.ts` implements) and
 * turns its aggregate friction data into `Signal`s. Generic across every
 * app by construction — parameterized by URL only, never hardcoded to one
 * app's routes or component names.
 */
export async function fetchFrictionSignals(appId: string, appBaseUrl: string): Promise<Signal[]> {
  const res = await fetch(new URL("/api/day2-friction-signals", appBaseUrl));
  if (!res.ok) {
    throw new Error(`${appBaseUrl}/api/day2-friction-signals returned ${res.status}`);
  }
  const body = (await res.json()) as { signals: AggregateFrictionSignal[] };

  return body.signals.map((s) => ({
    id: `friction-${appId}-${s.path}-${s.target}`,
    source: "interaction-friction" as const,
    appId,
    at: s.lastSeen,
    finding: `Repeated rapid clicks on "${s.target}" at ${s.path} with no visible response`,
    evidence: { target: s.target, firstSeen: s.firstSeen, lastSeen: s.lastSeen },
    occurrences: s.occurrences,
    affectedUsers: s.affectedDevices,
    path: s.path,
    suggestedAction: `Investigate why "${s.target}" at ${s.path} doesn't visibly respond to a click — likely a missing loading/disabled state, a silently-failing handler, or a genuine broken control.`,
  }));
}
