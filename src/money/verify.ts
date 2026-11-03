import { purchaseTokenFor as libraryPurchaseToken } from "../../packages/sensors/src/live";
import { decodeAppleNotification, JwsError, type AppleTransaction, type DecodedAppleNotification } from "./apple-jws";
import type { AppStoreServerApi } from "./apple-server-api";
import { GoogleError, moneyOf, parsePush, SUBSCRIPTION_NOTIFICATION, verifyPushToken, type DeveloperNotification, type PlayPurchases, type SubscriptionPurchaseV2 } from "./google-play";
import { MAX_ATTEMPTS, nextAttempt, tokenId, type MoneyEventType, type MoneyLedger, type MoneyRecord, type QueueItem, type RevenueKind } from "./ledger";
import { StoreKitError } from "./apple-server-api";
import type { RtdnCredential } from "./credentials";
import type { Connection, Product } from "./types";

/**
 * Store notifications → verified money records.
 *
 * Apple (App Store Server Notifications V2): the body's signedPayload and
 * the signed transaction/renewal inside are verified (apple-jws.ts) before
 * anything is believed. Google (RTDN over Pub/Sub push): the push's OIDC
 * token is verified, then the purchase is read from the Play Developer API —
 * the notification itself only names a token.
 *
 * Each notification is queued by its id first (a redelivery is answered
 * "fine" and counted once), checked, recorded, and retried with backoff
 * when a store lookup fails. The purchase carries day2's purchase token
 * (appAccountToken / obfuscatedAccountId = purchaseTokenFor(app key, hashed user)),
 * which maps back to the hashed user and from there to experiment variants
 * and acquisition source.
 */

/**
 * The UUID an app passes as Apple's appAccountToken and Google's
 * obfuscatedAccountId: derived from the hashed user (never the raw id), so
 * the server maps it back without storing anything on the device.
 * `day2.purchaseToken()` in the library must compute the same:
 * sha256("day2-purchase:" + hashedUser), first 16 bytes, version nibble 5,
 * RFC 4122 variant, lowercase 8-4-4-4-12.
 */
/** The same token the app's library gives (`day2.purchaseToken()`): one formula, in packages/sensors/src/live.ts. */
export function purchaseTokenFor(appKey: string, hashedUser: string): string {
  return libraryPurchaseToken(appKey, hashedUser);
}

export type Who = { user: string; variants: Record<string, string>; source: string | null };

/** A resolver from purchase token to the hashed user, from the users day2 knows. */
export function tokenResolver(appKey: string, users: string[], variantsOf: (user: string) => Record<string, string>, sourceOf: (user: string) => string | null): (token: string) => Who | null {
  const byToken = new Map(users.map((u) => [purchaseTokenFor(appKey, u), u]));
  return (token) => {
    const user = byToken.get(token.toLowerCase());
    return user ? { user, variants: variantsOf(user), source: sourceOf(user) } : null;
  };
}

export type VerifyDeps = {
  ledger: MoneyLedger;
  who: (token: string) => Who | null | Promise<Who | null>;
  /** The app's bundle id / package name — notifications for other apps are ignored; without a bundle id every Apple notification is refused. */
  bundleId: string | null;
  /** The app's App Store id, when known: Apple notifications naming another one are ignored. */
  appAppleId?: number | null;
  packageName: string | null;
  /** Test roots for Apple's chain (default Apple Root CA - G3). */
  appleRoots?: string[];
  appleApi?: AppStoreServerApi | null;
  play?: PlayPurchases | null;
  /** Google push identity to expect; null = Pub/Sub isn't set up yet. */
  rtdn?: RtdnCredential | null;
  /** The app's products (Google one-time prices, trial offers). */
  catalog: Product[];
  /** A store's test notification arrived: the connection works. */
  connected?: (c: Connection, note: string) => Promise<void>;
  /** Hands verified records to Live's events (purchase_verified, refund…); optional. */
  emit?: (records: MoneyRecord[]) => Promise<void>;
  fetch?: typeof fetch;
  now?: Date;
};

export type Outcome = { status: number; note: string };

const fmt = (amount: number, currency: string) => `${amount.toFixed(2)} ${currency}`;

// ---------------------------------------------------------------------------
// Apple
// ---------------------------------------------------------------------------

const appleKind = (t: AppleTransaction): RevenueKind => (t.type === "Auto-Renewable Subscription" || t.type === "Non-Renewing Subscription" ? "subscription" : "purchase");
const appleSandbox = (t: { environment?: string } | undefined) => Boolean(t?.environment && t.environment !== "Production");

/** Pure. What a verified Apple notification means, as records (may be none). */
export function appleRecords(d: DecodedAppleNotification, who: Who | null): { records: MoneyRecord[]; note: string } {
  const n = d.notification;
  const t = d.transaction;
  if (!t) return { records: [], note: `${n.notificationType}: nothing to record` };
  const price = (t.price ?? 0) / 1000;
  const currency = t.currency ?? "USD";
  const base = {
    store: "apple" as const,
    kind: appleKind(t),
    productId: t.productId,
    currency,
    user: who?.user ?? null,
    variants: who?.variants ?? {},
    source: who?.source ?? null,
    chain: t.originalTransactionId,
    sandbox: appleSandbox(t) || appleSandbox(n.data),
    expiresAt: t.expiresDate ? new Date(t.expiresDate).toISOString() : null,
  };
  const rec = (type: MoneyEventType, amount: number, at: number | undefined, idPart = t.transactionId): MoneyRecord => ({
    ...base,
    id: `apple:${idPart}:${type}`,
    type,
    amount,
    at: new Date(at ?? n.signedDate ?? Date.now()).toISOString(),
  });
  const trial = t.offerDiscountType === "FREE_TRIAL" || (t.offerType === 1 && price === 0);
  switch (n.notificationType) {
    case "SUBSCRIBED":
    case "OFFER_REDEEMED": {
      if (trial) return { records: [rec("trial_started", 0, t.purchaseDate)], note: `Free trial started: ${t.productId}` };
      return { records: [rec("purchase_verified", price, t.purchaseDate)], note: `New subscription: ${t.productId}, ${fmt(price, currency)}` };
    }
    case "DID_RENEW":
      return { records: [rec("renewal", price, t.purchaseDate)], note: `Renewal: ${t.productId}, ${fmt(price, currency)}` };
    case "ONE_TIME_CHARGE":
      return { records: [rec("purchase_verified", price * (t.quantity ?? 1), t.purchaseDate)], note: `Purchase: ${t.productId}, ${fmt(price * (t.quantity ?? 1), currency)}` };
    case "REFUND":
      return { records: [rec("refund", price * (t.quantity ?? 1), t.revocationDate)], note: `Refund: ${t.productId}, ${fmt(price, currency)}` };
    case "REFUND_REVERSED":
      // The same id as the refund: overwriting it with 0 takes the refund back.
      return { records: [rec("refund", 0, t.revocationDate ?? t.purchaseDate)], note: `Refund reversed: ${t.productId}` };
    case "REVOKE":
      return { records: [rec("cancellation", 0, t.revocationDate)], note: `Family Sharing access ended: ${t.productId}` };
    case "DID_CHANGE_RENEWAL_STATUS":
      if (n.subtype === "AUTO_RENEW_DISABLED") return { records: [{ ...rec("cancellation", 0, n.signedDate), id: `apple:${n.notificationUUID}:cancellation` }], note: `Turned off renewal: ${t.productId}` };
      return { records: [], note: `Turned renewal back on: ${t.productId}` };
    case "EXPIRED":
    case "GRACE_PERIOD_EXPIRED":
      return { records: [rec("expired", 0, t.expiresDate)], note: `Subscription ended: ${t.productId}` };
    case "DID_FAIL_TO_RENEW":
      return { records: [{ ...rec("billing_issue", 0, n.signedDate), id: `apple:${n.notificationUUID}:billing_issue` }], note: `Payment failed at renewal: ${t.productId}` };
    default:
      return { records: [], note: `${n.notificationType}${n.subtype ? ` (${n.subtype})` : ""}: nothing to record` };
  }
}

/** POST /api/store-notify/apple/:appId */
export async function receiveApple(appId: string, body: unknown, deps: VerifyDeps): Promise<Outcome> {
  const signedPayload = (body as { signedPayload?: unknown } | null)?.signedPayload;
  if (typeof signedPayload !== "string") return { status: 400, note: "no signedPayload" };
  if (!deps.bundleId) return { status: 400, note: "the app has no bundle id yet — day2 can't tell whether a notification is for it" };
  let d: DecodedAppleNotification;
  try {
    d = decodeAppleNotification(signedPayload, { roots: deps.appleRoots, now: deps.now });
  } catch (err) {
    if (err instanceof JwsError) return { status: 400, note: `not from Apple: ${err.message}` };
    throw err;
  }
  const now = deps.now ?? new Date();
  const fresh = await deps.ledger.enqueue(appId, { id: `apple:${d.notification.notificationUUID}`, store: "apple", receivedAt: now.toISOString(), payload: { signedPayload } });
  if (!fresh) return { status: 200, note: "already received" };
  const item = (await deps.ledger.due(appId, now, 500)).find((q) => q.id === `apple:${d.notification.notificationUUID}`);
  if (item) await processItem(appId, item, deps);
  return { status: 200, note: "received" };
}

async function processApple(item: QueueItem, deps: VerifyDeps): Promise<{ records: MoneyRecord[]; note: string; state: "done" | "ignored" }> {
  const d = decodeAppleNotification(String(item.payload?.signedPayload ?? ""), { roots: deps.appleRoots, now: deps.now });
  // Whose notification it is, before anything else (also before TEST): any app's signed notification passes Apple's chain.
  const bundle = d.notification.data?.bundleId ?? d.transaction?.bundleId;
  if (!deps.bundleId) return { records: [], note: "the app has no bundle id", state: "ignored" };
  if (bundle !== deps.bundleId) return { records: [], note: `for another app (${bundle ?? "no bundle id"})`, state: "ignored" };
  if (d.transaction?.bundleId && d.transaction.bundleId !== deps.bundleId) return { records: [], note: `transaction for another app (${d.transaction.bundleId})`, state: "ignored" };
  const appleId = d.notification.data?.appAppleId;
  if (deps.appAppleId && appleId && Number(appleId) !== Number(deps.appAppleId)) return { records: [], note: `for another app (App Store id ${appleId})`, state: "ignored" };
  if (d.notification.notificationType === "TEST") {
    await deps.connected?.("apple_notifications", "Apple's test notification arrived and its signature checked out.");
    return { records: [], note: "Apple's test notification arrived", state: "ignored" };
  }
  const token = d.transaction?.appAccountToken;
  const who = token ? await deps.who(token) : null;
  const r = appleRecords(d, who);
  return { ...r, state: r.records.length ? "done" : "ignored" };
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

/** POST /api/store-notify/google/:appId */
/**
 * `replay`: the inbox Worker kept the push while day2 was away and replays
 * it (x-day2-inbox) without Google's Authorization header. Such a message
 * isn't trusted at all: only what the Play Developer API confirms counts
 * (subscriptions and one-time purchases are read from it anyway; refunds
 * are checked against Google's voided purchases; a test notification
 * proves nothing; a change is only recorded when the subscription's state
 * agrees). Replays are queued under their own ids (UNVERIFIED_PREFIX), so
 * they never pre-claim a real Pub/Sub message, and only so many may wait
 * at once (the ledger's MAX_UNVERIFIED_QUEUED). Only drainInbox can mark a
 * request as a replay (ingest-inbox.ts replayOf).
 */
export async function receiveGoogle(appId: string, authorization: string | null, body: unknown, deps: VerifyDeps, opts: { replay?: boolean } = {}): Promise<Outcome> {
  if (!deps.rtdn) return { status: 401, note: "Google notifications aren't set up for this app yet" };
  const unverified = Boolean(opts.replay && !authorization);
  if (!unverified) {
    const why = await verifyPushToken(authorization, { audience: deps.rtdn.audience, email: deps.rtdn.pushServiceAccount }, { fetch: deps.fetch, now: deps.now });
    if (why) return { status: 401, note: why };
  }
  const push = parsePush(body);
  // A malformed message would be redelivered forever: acknowledge and drop it.
  if (!push) return { status: 204, note: "not a developer notification" };
  const now = deps.now ?? new Date();
  // Replays get their own ids: an unverified message can never pre-claim a real Pub/Sub message id.
  const id = unverified ? `${UNVERIFIED_PREFIX}${push.messageId}` : `google:${push.messageId}`;
  const fresh = await deps.ledger.enqueue(appId, { id, store: "google", receivedAt: now.toISOString(), payload: { notification: push.notification, ...(unverified ? { unverified: true } : {}) } });
  if (!fresh) return { status: 204, note: unverified ? "already received, or too many unverified notifications waiting" : "already received" };
  const item = (await deps.ledger.due(appId, now, 500)).find((q) => q.id === id);
  if (item) await processItem(appId, item, deps);
  return { status: 204, note: "received" };
}

/** Queue ids of notifications replayed by the inbox without Google's OIDC token. */
export const UNVERIFIED_PREFIX = "google:inbox:";

/**
 * What the Play Developer API must say for a change to be recorded: a
 * notification type is only believed when the subscription's state agrees
 * (payments are keyed by Google's order id instead, so they need no check).
 */
const STATE_FOR: Partial<Record<MoneyEventType, (s: SubscriptionPurchaseV2) => boolean>> = {
  cancellation: (s) => s.subscriptionState !== "SUBSCRIPTION_STATE_ACTIVE" || Boolean(s.canceledStateContext),
  billing_issue: (s) => s.subscriptionState === "SUBSCRIPTION_STATE_ON_HOLD" || s.subscriptionState === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  expired: (s) => s.subscriptionState === "SUBSCRIPTION_STATE_EXPIRED",
};

const SUB_EVENT: Record<string, MoneyEventType | null> = {
  SUBSCRIPTION_PURCHASED: "purchase_verified",
  SUBSCRIPTION_RENEWED: "renewal",
  SUBSCRIPTION_RECOVERED: "renewal",
  SUBSCRIPTION_RESTARTED: null,
  SUBSCRIPTION_CANCELED: "cancellation",
  SUBSCRIPTION_EXPIRED: "expired",
  SUBSCRIPTION_ON_HOLD: "billing_issue",
  SUBSCRIPTION_IN_GRACE_PERIOD: "billing_issue",
  SUBSCRIPTION_REVOKED: "cancellation",
};

async function processGoogle(appId: string, item: QueueItem, deps: VerifyDeps): Promise<{ records: MoneyRecord[]; note: string; state: "done" | "ignored" }> {
  const n = item.payload?.notification as DeveloperNotification;
  const unverified = item.payload?.unverified === true;
  if (n.testNotification) {
    if (unverified) return { records: [], note: "a test notification kept by the inbox (not proof on its own — send another one)", state: "ignored" };
    await deps.connected?.("rtdn", "Google Play's test notification arrived through Pub/Sub.");
    return { records: [], note: "Google Play's test notification arrived", state: "ignored" };
  }
  if (deps.packageName && n.packageName !== deps.packageName) return { records: [], note: `for another app (${n.packageName})`, state: "ignored" };
  const at = new Date(Number(n.eventTimeMillis) || Date.now()).toISOString();
  if (!deps.play) throw new GoogleError("the Google Play service account isn't connected", undefined, true);
  const play = deps.play;

  if (n.subscriptionNotification) {
    const sn = n.subscriptionNotification;
    const name = SUBSCRIPTION_NOTIFICATION[sn.notificationType] ?? `type ${sn.notificationType}`;
    const type = SUB_EVENT[name];
    if (type === undefined || type === null) return { records: [], note: `${name}: nothing to record`, state: "ignored" };
    const sub = await play.subscription(n.packageName, sn.purchaseToken);
    const line = sub.lineItems?.[0];
    const productId = line?.productId ?? sn.subscriptionId ?? null;
    const token = sub.externalAccountIdentifiers?.obfuscatedExternalAccountId;
    const who = token ? await deps.who(token) : null;
    const price = moneyOf(line?.autoRenewingPlan?.recurringPrice) ?? { amount: 0, currency: "USD" };
    const chain = tokenId(sub.linkedPurchaseToken ?? sn.purchaseToken);
    const product = deps.catalog.find((p) => p.productId === productId);
    const trialOffer = product?.android.offer ?? null;
    const inTrial = type === "purchase_verified" && Boolean(trialOffer && line?.offerDetails?.offerId === trialOffer);
    const orderId = line?.latestSuccessfulOrderId ?? sub.latestOrderId ?? tokenId(sn.purchaseToken);
    const payment = type === "purchase_verified" || type === "renewal";
    const finalType: MoneyEventType = inTrial ? "trial_started" : type;
    if (!payment && STATE_FOR[type] && !STATE_FOR[type]!(sub)) return { records: [], note: `${name}: Google Play says the subscription is ${(sub.subscriptionState ?? "unknown").replace("SUBSCRIPTION_STATE_", "").toLowerCase()} — nothing recorded`, state: "ignored" };
    const record: MoneyRecord = {
      // Payments are keyed by order (each renewal has its own); other changes by the message —
      // or, for an unverified replay, by the purchase and its period, so repeats count once.
      id: payment
        ? `google:${orderId}:${finalType}`
        : unverified
          ? `google:${tokenId(sn.purchaseToken)}:${line?.expiryTime ?? sub.latestOrderId ?? ""}:${finalType}`
          : `google:${item.id.slice(7)}:${finalType}`,
      store: "google",
      type: finalType,
      kind: "subscription",
      productId,
      at,
      amount: payment && !inTrial ? price.amount : 0,
      currency: price.currency,
      user: who?.user ?? null,
      variants: who?.variants ?? {},
      source: who?.source ?? null,
      chain,
      sandbox: Boolean(sub.testPurchase),
      expiresAt: line?.expiryTime ?? null,
    };
    // Safety net: an unacknowledged purchase is refunded by Google after 3 days.
    if (payment && sub.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING" && productId)
      await play.acknowledgeSubscription(n.packageName, productId, sn.purchaseToken).catch(() => {});
    return { records: [record], note: `${name.replace("SUBSCRIPTION_", "").toLowerCase().replace(/_/g, " ")}: ${productId}${record.amount ? `, ${fmt(record.amount, record.currency)}` : ""}`, state: "done" };
  }

  if (n.oneTimeProductNotification) {
    const on = n.oneTimeProductNotification;
    if (on.notificationType !== 1) return { records: [], note: `one-time purchase canceled before paying: ${on.sku}`, state: "ignored" };
    const p = await play.product(n.packageName, on.sku, on.purchaseToken);
    if (p.purchaseState !== 0) return { records: [], note: `purchase of ${on.sku} isn't completed (state ${p.purchaseState})`, state: "ignored" };
    const who = p.obfuscatedExternalAccountId ? await deps.who(p.obfuscatedExternalAccountId) : null;
    // Google doesn't return the price of a one-time purchase: day2's own price for the region.
    const product = deps.catalog.find((x) => x.productId === on.sku);
    const regional = product?.regional.find((r) => r.region === p.regionCode) ?? (product && product.base.region === p.regionCode ? product.base : null);
    const price = regional ?? product?.base ?? { amount: 0, currency: "USD" };
    const amount = price.amount * (p.quantity ?? 1);
    if (p.acknowledgementState === 0) await play.acknowledgeProduct(n.packageName, on.sku, on.purchaseToken).catch(() => {});
    return {
      records: [
        {
          id: `google:${p.orderId ?? tokenId(on.purchaseToken)}:purchase_verified`,
          store: "google",
          type: "purchase_verified",
          kind: "purchase",
          productId: on.sku,
          at: p.purchaseTimeMillis ? new Date(Number(p.purchaseTimeMillis)).toISOString() : at,
          amount,
          currency: price.currency,
          user: who?.user ?? null,
          variants: who?.variants ?? {},
          source: who?.source ?? null,
          chain: null,
          sandbox: p.purchaseType === 0,
          expiresAt: null,
        },
      ],
      note: `Purchase: ${on.sku}, ${fmt(amount, price.currency)}${regional ? "" : " (price of the base region)"}`,
      state: "done",
    };
  }

  if (n.voidedPurchaseNotification) {
    const v = n.voidedPurchaseNotification;
    if (unverified && !(await play.voidedOrders(n.packageName, Number(n.eventTimeMillis) - 86_400_000)).has(v.orderId)) return { records: [], note: `refund of ${v.orderId} not confirmed by Google`, state: "ignored" };
    const kind: RevenueKind = v.productType === 1 ? "subscription" : "purchase";
    // The refunded amount: what day2 recorded for that order.
    const earlier = await deps.ledger.records(appId, new Date(0));
    const paid = earlier.find((r) => r.id.startsWith(`google:${v.orderId}:`) && (r.type === "purchase_verified" || r.type === "renewal"));
    return {
      records: [
        {
          id: `google:${v.orderId}:refund`,
          store: "google",
          type: "refund",
          kind,
          productId: paid?.productId ?? null,
          at,
          amount: paid?.amount ?? 0,
          currency: paid?.currency ?? "USD",
          user: paid?.user ?? null,
          variants: paid?.variants ?? {},
          source: paid?.source ?? null,
          chain: paid?.chain ?? null,
          sandbox: paid?.sandbox ?? false,
          expiresAt: null,
        },
      ],
      note: `Refund: order ${v.orderId}${paid ? `, ${fmt(paid.amount, paid.currency)}` : ""}`,
      state: "done",
    };
  }
  return { records: [], note: "nothing to record", state: "ignored" };
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

const retryable = (err: unknown) => (err instanceof GoogleError || err instanceof StoreKitError ? err.retryable || err.status === undefined || err.status === 401 || err.status === 403 : true);

/** Checks one queued notification; records it, or schedules a retry. */
export async function processItem(appId: string, item: QueueItem, deps: VerifyDeps): Promise<"done" | "ignored" | "queued" | "failed"> {
  const now = deps.now ?? new Date();
  try {
    const r = item.store === "apple" ? await processApple(item, deps) : await processGoogle(appId, item, deps);
    if (r.records.length) {
      await deps.ledger.record(appId, r.records);
      await deps.emit?.(r.records).catch(() => {});
    }
    await deps.ledger.settle(appId, item.id, { state: r.state, note: r.note });
    return r.state;
  } catch (err) {
    const msg = (err as Error).message;
    const again = item.attempts + 1 < MAX_ATTEMPTS && retryable(err);
    await deps.ledger.settle(appId, item.id, again ? { state: "queued", error: msg, nextAt: nextAttempt(item.attempts + 1, now) } : { state: "failed", error: msg });
    return again ? "queued" : "failed";
  }
}

/** The verification queue: everything due, oldest first. */
export async function drainQueue(appId: string, deps: VerifyDeps): Promise<{ done: number; retrying: number; failed: number }> {
  const out = { done: 0, retrying: 0, failed: 0 };
  for (const item of await deps.ledger.due(appId, deps.now ?? new Date())) {
    const r = await processItem(appId, item, deps);
    if (r === "done" || r === "ignored") out.done++;
    else if (r === "queued") out.retrying++;
    else out.failed++;
  }
  return out;
}
