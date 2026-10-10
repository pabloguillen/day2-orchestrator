import { AsyncLocalStorage } from "node:async_hooks";
import { resolve, sep } from "node:path";
import { query as sdkQuery, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { authorize, CreditsError, recordCharge, type CreditService, type CreditStore } from "./credits";
import { creditStore } from "./day2-paths";
import { currentTenant, serverMode, tenantForPath } from "./tenant";

/**
 * Every Claude agent run in day2 goes through here, so every run is paid
 * for from the account's credits (credits.ts) — no call site can forget.
 *
 * Drop-in for the SDK's `query`: `const query = meteredQuery("agent_work")`.
 * Before the run starts, the worst case (`maxBudgetUsd`) must fit in the
 * balance and the app's caps, or it throws `CreditsError` without starting.
 * When the run reports its real cost, that — not the worst case — is charged.
 *
 * Which account pays: the tenant of the request (or background job) the run
 * belongs to (tenant.ts), else the account whose app contains the run's
 * `cwd`. In accounts mode a run that belongs to no account is refused —
 * there'd be no one to charge.
 *
 * Which app it's booked against: the surrounding `withCreditContext` if a
 * caller set one (API handlers do), else the app whose repo contains the
 * run's `cwd`, else the account itself (platform-level work).
 */

export type CreditContext = {
  appId?: string | null;
  appName?: string;
  service?: CreditService;
  description?: string;
  killSwitch?: boolean;
  /** Filled in as runs inside the context are charged. */
  charged?: number;
};

const storage = new AsyncLocalStorage<CreditContext>();

/** `ctx` is used as-is (not copied) so the caller can read `ctx.charged`
 * afterwards. */
export function withCreditContext<T>(ctx: CreditContext, fn: () => Promise<T>): Promise<T> {
  ctx.charged ??= 0;
  return storage.run(ctx, fn);
}

export function currentCreditContext(): CreditContext | undefined {
  return storage.getStore();
}

export function creditsEnabled(): boolean {
  return process.env.DAY2_CREDITS !== "off";
}

const contains = (root: string, target: string) => target === root || target.startsWith(root + sep);

async function payerFor(cwd: string | undefined): Promise<{ store: CreditStore; app: { id: string; name: string } | null }> {
  const tenant = currentTenant();
  if (tenant) {
    if (!cwd) return { store: tenant.credits, app: null };
    const target = resolve(cwd);
    const app = (await tenant.apps.list()).find((a) => contains(resolve(a.repoPath), target));
    return { store: tenant.credits, app: app ? { id: app.id, name: app.name } : null };
  }
  const hit = cwd ? await tenantForPath(cwd) : null;
  if (hit) return { store: hit.tenant.credits, app: { id: hit.app.id, name: hit.app.name } };
  if (serverMode() === "accounts") throw new Error("This agent run doesn't belong to any account, so there's no one to charge.");
  return { store: creditStore(), app: null };
}

type QueryParams = Parameters<typeof sdkQuery>[0];

/** Used when a call site sets no `maxBudgetUsd` — the SDK has no cap then, so
 * the pre-check has to assume something; every current call site sets one. */
const DEFAULT_MAX_COST_USD = 1;

export function meteredQuery(defaultService: CreditService, label = "Agent run") {
  return async function* query(params: QueryParams): AsyncGenerator<SDKMessage, void> {
    if (!creditsEnabled()) {
      yield* sdkQuery(params);
      return;
    }
    const ctx = storage.getStore();
    const options = (params.options ?? {}) as { cwd?: string; maxBudgetUsd?: number };
    const payer = await payerFor(options.cwd);
    const inferred = ctx?.appId !== undefined ? null : payer.app;
    const appId = ctx?.appId !== undefined ? ctx.appId : (inferred?.id ?? null);
    const appName = ctx?.appName ?? inferred?.name;
    const service = ctx?.service ?? defaultService;
    const maxCostUsd = options.maxBudgetUsd ?? DEFAULT_MAX_COST_USD;
    const store = payer.store;

    const check = await authorize(store, { appId, appName, service, maxCostUsd, killSwitch: ctx?.killSwitch });
    if (!check.ok) throw new CreditsError(check);

    let costUsd: number | null = null;
    try {
      for await (const message of sdkQuery(params)) {
        if (message.type === "result") costUsd = message.total_cost_usd ?? 0;
        yield message;
      }
    } finally {
      if (costUsd !== null && costUsd > 0) {
        const charge = await recordCharge(store, {
          id: `${service}:${crypto.randomUUID()}`,
          appId,
          service,
          costUsd,
          description: ctx?.description ?? label,
          maxCredits: check.maxCredits,
        });
        if (ctx && charge) ctx.charged = (ctx.charged ?? 0) + charge.credits;
      }
    }
  };
}
