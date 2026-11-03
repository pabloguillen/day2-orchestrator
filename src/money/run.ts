import type { AppEntry } from "../apps-registry";
import { allApps } from "../apps-store";
import { authorize, CreditsError } from "../credits";
import { db } from "../db";
import { withCreditContext, type CreditContext } from "../metered-query";
import { fieldStore, loadAccountTenant, localTenant, releaseCredentials, serverMode, type Tenant } from "../tenant";
import type { Json } from "../../packages/sensors/src/types";
import { addExperiment } from "../live/experiments";
import { startExperiment } from "../live/pass";
import { liveStore } from "../live/runtime";
import type { LiveExperimentsPort } from "./offer-tests";
import type { MoneyPassDeps } from "./pass";
import { researchStrategy } from "./strategy";
import { catalogsFor, moneyCredentials, moneyLedger, verifyDepsFor } from "./wiring";

/** Money's pass dependencies for one app, charged to its account (like growth-autopilot-run.ts). */

export const STRATEGY_MAX_USD = 2;

export function moneyPassDeps(tenant: Tenant, app: AppEntry): MoneyPassDeps {
  const ledger = moneyLedger();
  const store = fieldStore();
  return {
    ledger,
    store,
    verify: () => verifyDepsFor(app, { ledger, credentials: moneyCredentials(), release: releaseCredentials(), store }),
    catalogs: () => catalogsFor(app, releaseCredentials()),
    async research(input) {
      const check = await authorize(tenant.credits, { appId: app.id, appName: app.name, service: "scan_answer", maxCostUsd: STRATEGY_MAX_USD });
      if (!check.ok) throw new CreditsError(check);
      const ctx: CreditContext = { appId: app.id, appName: app.name, service: "scan_answer", description: "How the app earns (autopilot)" };
      const result = await withCreditContext(ctx, () => researchStrategy(input));
      return { result, credits: ctx.charged ?? 0 };
    },
    experiments: liveExperiments(),
  };
}

/** Store webhooks carry only the app id: find the app and its account. */
export async function findAppForWebhook(appId: string): Promise<{ tenant: Tenant; app: AppEntry } | null> {
  if (serverMode() === "local") {
    const t = localTenant();
    const app = await t.apps.find(appId);
    return app ? { tenant: t, app } : null;
  }
  const hit = (await allApps(db())).find((x) => x.app.id === appId);
  if (!hit) return null;
  const tenant = await loadAccountTenant(hit.accountId);
  return tenant ? { tenant, app: hit.app } : null;
}

/**
 * Money's tests run in Live's experiments engine: added as a draft with the
 * metric revenue per user (Live adds D7 retention and crash rate as
 * guardrails), then started — at once when the app's code already reads the
 * keys, else after Live's build ticket. Live's autonomy setting applies to
 * day2's own tests; one the owner approved on the Money page starts as theirs.
 */
export function liveExperiments(): LiveExperimentsPort {
  return {
    async start(app, spec) {
      const store = liveStore();
      const now = new Date();
      const id = await store.update(app.id, (s) => {
        const r = addExperiment(
          s,
          { title: spec.name, hypothesis: spec.hypothesis, keys: spec.keys, variants: spec.variants.map((v) => ({ ...v, values: v.values as Record<string, Json> })), metric: { kind: "revenue_per_user" }, createdBy: spec.by === "owner" ? "owner" : "day2" },
          new Set(),
          now,
        );
        return { state: r.state, result: r.experiment.id };
      });
      await startExperiment(app, store, id, { by: spec.by, now });
      return { id };
    },
    async result(app, id) {
      const e = (await liveStore().get(app.id)).experiments.find((x) => x.id === id);
      if (!e) return { state: "stopped", winner: null, note: `${id} isn't in Live any more.` };
      if (e.state === "stopped") return { state: "stopped", winner: null, note: e.stopReason ?? "Stopped in Live." };
      if ((e.state === "decided" || e.state === "promoted") && e.decision) return { state: "decided", winner: e.decision.winner, note: e.decision.note };
      return { state: "running", winner: null, note: "" };
    },
  };
}
