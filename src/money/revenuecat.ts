import { timingSafeEqual } from "node:crypto";
import type { MoneyEventType, MoneyRecord } from "./ledger";
import type { Outcome, VerifyDeps } from "./verify";

/**
 * Apps that already use RevenueCat: day2 doesn't verify with Apple and
 * Google itself (RevenueCat does), it reads RevenueCat's webhooks. The app
 * sets one subscriber attribute, `day2_token` = day2.purchaseToken(), so
 * events map back to the hashed user. The webhook's Authorization header is
 * a shared secret the owner sets in RevenueCat (stored encrypted by day2).
 * https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields
 *
 * Its path (/api/store-notify/revenuecat/:appId) has to be added to the
 * tunnel allowlist next to the Apple and Google ones (owned by Live).
 */

type RcEvent = {
  id: string;
  type: string;
  product_id?: string;
  period_type?: "TRIAL" | "INTRO" | "NORMAL" | "PROMOTIONAL" | "PREPAID";
  purchased_at_ms?: number;
  expiration_at_ms?: number | null;
  event_timestamp_ms?: number;
  price_in_purchased_currency?: number;
  currency?: string;
  environment?: "SANDBOX" | "PRODUCTION";
  transaction_id?: string;
  original_transaction_id?: string;
  cancel_reason?: string;
  subscriber_attributes?: Record<string, { value?: string }>;
};

const TYPES: Record<string, MoneyEventType | null> = {
  INITIAL_PURCHASE: "purchase_verified",
  NON_RENEWING_PURCHASE: "purchase_verified",
  RENEWAL: "renewal",
  CANCELLATION: "cancellation",
  EXPIRATION: "expired",
  BILLING_ISSUE: "billing_issue",
  UNCANCELLATION: null,
  PRODUCT_CHANGE: null,
  TEST: null,
};

export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Pure. */
export function revenueCatRecord(e: RcEvent, who: { user: string; variants: Record<string, string>; source: string | null } | null): MoneyRecord | null {
  let type = TYPES[e.type];
  if (!type) return null;
  const price = e.price_in_purchased_currency ?? 0;
  // RevenueCat reports refunds as a cancellation with a negative price.
  if (type === "cancellation" && (e.cancel_reason === "CUSTOMER_SUPPORT" || price < 0)) type = "refund";
  if (type === "purchase_verified" && e.period_type === "TRIAL") type = "trial_started";
  const amount = type === "purchase_verified" || type === "renewal" || type === "refund" ? Math.abs(price) : 0;
  return {
    id: `revenuecat:${e.transaction_id ?? e.id}:${type}`,
    store: "revenuecat",
    type,
    kind: e.expiration_at_ms ? "subscription" : "purchase",
    productId: e.product_id ?? null,
    at: new Date(e.purchased_at_ms ?? e.event_timestamp_ms ?? Date.now()).toISOString(),
    amount,
    currency: e.currency ?? "USD",
    user: who?.user ?? null,
    variants: who?.variants ?? {},
    source: who?.source ?? null,
    chain: e.original_transaction_id ?? null,
    sandbox: e.environment === "SANDBOX",
    expiresAt: e.expiration_at_ms ? new Date(e.expiration_at_ms).toISOString() : null,
  };
}

/** POST /api/store-notify/revenuecat/:appId */
export async function receiveRevenueCat(appId: string, authorization: string | null, body: unknown, deps: VerifyDeps & { webhookAuth: string | null }): Promise<Outcome> {
  if (!deps.webhookAuth) return { status: 401, note: "RevenueCat isn't connected for this app" };
  const given = (authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!sameSecret(given, deps.webhookAuth)) return { status: 401, note: "wrong authorization" };
  const e = (body as { event?: RcEvent } | null)?.event;
  if (!e?.id || !e.type) return { status: 400, note: "not a RevenueCat event" };
  const now = deps.now ?? new Date();
  const fresh = await deps.ledger.enqueue(appId, { id: `revenuecat:${e.id}`, store: "revenuecat", receivedAt: now.toISOString(), payload: null });
  if (!fresh) return { status: 200, note: "already received" };
  const token = e.subscriber_attributes?.day2_token?.value;
  const who = token ? await deps.who(token) : null;
  const rec = revenueCatRecord(e, who);
  if (rec) {
    await deps.ledger.record(appId, [rec]);
    await deps.emit?.([rec]).catch(() => {});
  }
  await deps.ledger.settle(appId, `revenuecat:${e.id}`, { state: rec ? "done" : "ignored", note: rec ? `${rec.type.replace("_", " ")}: ${rec.productId}` : `${e.type}: nothing to record` });
  return { status: 200, note: "received" };
}
