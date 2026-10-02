/**
 * Day2's generic friction-signal aggregator — canonical source, meant to be
 * installed verbatim into every rolled-out app's server, the same
 * installation model as `interaction-telemetry.ts` on the client side. Pure
 * function: takes whatever event log an app's server already has (the exact
 * `{type, at, metadata}` shape every day2 app's event pipeline already
 * stores) and derives aggregate friction signals — zero knowledge of any
 * specific app's routes, components, or KV bindings. The per-app server
 * file wraps this with its own KV-fetching boilerplate (unavoidably
 * per-app, since Workers bindings aren't shared across deployments) and
 * exposes it at `GET /api/day2-friction-signals` — the one HTTP contract
 * `orchestrator/src/sources/interaction-friction-signals.ts` expects from
 * ANY app, by URL alone.
 */

export type GenericStoredEvent = { type: string; at: string; metadata: unknown };

export type AggregateFrictionSignal = {
  target: string;
  path: string;
  /** Total rage-click streaks observed across every device — not a count
   * of individual clicks, which would overstate frequency. */
  occurrences: number;
  /** Distinct devices that hit this, the generic proxy for "affected
   * users" this schema has (expense-buddy-and-every-other-app's identity
   * model is device-keyed, per the existing per-user-model discipline). */
  affectedDevices: number;
  firstSeen: string;
  lastSeen: string;
};

/** Reads whatever shape a `rage_click` event's metadata carries (the exact
 * fields `interaction-telemetry.ts`'s `FrictionSignal` posts) without
 * assuming a stricter type than `recordEvent`'s own loose
 * `Record<string, unknown>` parameter guarantees. */
function parseRageClickMetadata(metadata: unknown): { target: string; path: string } | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as { target?: unknown; path?: unknown };
  if (typeof m.target !== "string" || typeof m.path !== "string") return null;
  return { target: m.target, path: m.path };
}

/**
 * `eventsByDevice` — every device's event log, keyed by device id. The
 * per-app server wrapper is responsible for assembling this (e.g. by
 * enumerating its KV namespace, the same pattern `handleStats` already
 * established) — this function only ever touches the data it's handed.
 */
export function deriveFrictionSignals(
  eventsByDevice: Record<string, GenericStoredEvent[]>,
): AggregateFrictionSignal[] {
  const byKey = new Map<
    string,
    { target: string; path: string; occurrences: number; devices: Set<string>; firstSeen: string; lastSeen: string }
  >();

  for (const [deviceId, events] of Object.entries(eventsByDevice)) {
    for (const event of events) {
      if (event.type !== "rage_click") continue;
      const parsed = parseRageClickMetadata(event.metadata);
      if (!parsed) continue;

      const key = `${parsed.path}::${parsed.target}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.occurrences += 1;
        existing.devices.add(deviceId);
        if (event.at < existing.firstSeen) existing.firstSeen = event.at;
        if (event.at > existing.lastSeen) existing.lastSeen = event.at;
      } else {
        byKey.set(key, {
          target: parsed.target,
          path: parsed.path,
          occurrences: 1,
          devices: new Set([deviceId]),
          firstSeen: event.at,
          lastSeen: event.at,
        });
      }
    }
  }

  return [...byKey.values()].map((v) => ({
    target: v.target,
    path: v.path,
    occurrences: v.occurrences,
    affectedDevices: v.devices.size,
    firstSeen: v.firstSeen,
    lastSeen: v.lastSeen,
  }));
}
