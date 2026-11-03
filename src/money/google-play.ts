import { createPublicKey, createSign, verify as verifySig } from "node:crypto";
import { redact } from "../ads/http";
import type { PlayCredential } from "../mobile-release/credentials";

/**
 * Google's side of revenue truth:
 *  - Real-time developer notifications (RTDN) arrive as Pub/Sub push
 *    requests. Each carries an OIDC token (Authorization: Bearer) signed by
 *    Google for the push subscription's service account; it's checked
 *    (RS256 against Google's published keys, issuer, audience, email,
 *    expiry) before anything in the body is believed.
 *  - The notification only says "something happened to this purchase
 *    token"; the truth comes from the Play Developer API with the service
 *    account already connected for releases: purchases.subscriptionsv2.get
 *    and purchases.products.get (and acknowledge, as a safety net).
 *  - Pub/Sub topic + push subscription can be created with the same service
 *    account when it has Pub/Sub rights in its project.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const PLAY = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const PUBSUB = "https://pubsub.googleapis.com/v1";
export const SCOPE_PLAY = "https://www.googleapis.com/auth/androidpublisher";
export const SCOPE_PUBSUB = "https://www.googleapis.com/auth/pubsub";
/** Google Play publishes RTDN as this account; it needs Pub/Sub Publisher on the topic. */
export const PLAY_PUBLISHER = "serviceAccount:google-play-developer-notifications@system.gserviceaccount.com";

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export class GoogleError extends Error {
  constructor(
    message: string,
    public status?: number,
    public retryable = false,
  ) {
    super(`Google: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// OIDC token of a Pub/Sub push
// ---------------------------------------------------------------------------

type Jwk = { kid?: string; kty?: string; n?: string; e?: string; alg?: string; [k: string]: unknown };
let certCache: { keys: Jwk[]; until: number } | null = null;
/** When the keys were last fetched because a token named a kid day2 didn't have. */
let lastUnknownKidRefetch = 0;
/** At most one such refetch per this long: unknown kids in forged tokens can't make day2 hammer Google. */
export const UNKNOWN_KID_REFETCH_MS = 5 * 60_000;

export function resetGoogleCertCache(): void {
  certCache = null;
  lastUnknownKidRefetch = 0;
}

async function googleKeys(doFetch: typeof fetch, now: number, fresh = false): Promise<Jwk[]> {
  if (!fresh && certCache && certCache.until > now) return certCache.keys;
  const r = await doFetch(GOOGLE_CERTS);
  if (!r.ok) throw new GoogleError(`couldn't load Google's signing keys (${r.status})`, r.status, true);
  const j = (await r.json()) as { keys?: Jwk[] };
  const maxAge = Number(/max-age=(\d+)/.exec(r.headers.get("cache-control") ?? "")?.[1] ?? 3600);
  certCache = { keys: j.keys ?? [], until: now + Math.min(maxAge, 86_400) * 1000 };
  return certCache.keys;
}

export type PushIdentity = { email: string; aud: string };

/**
 * Verifies the push's OIDC token. Returns null when it's fine, or why not.
 * https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions
 */
export async function verifyPushToken(authorization: string | null, expect: { audience: string; email: string }, deps: { fetch?: typeof fetch; now?: Date } = {}): Promise<string | null> {
  const m = /^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/.exec(authorization ?? "");
  if (!m) return "no OIDC token";
  const [h, p, s] = m[1]!.split(".") as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: { iss?: string; aud?: string; email?: string; email_verified?: boolean; exp?: number; iat?: number };
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString());
    claims = JSON.parse(Buffer.from(p, "base64url").toString());
  } catch {
    return "the token isn't a JWT";
  }
  if (header.alg !== "RS256") return "unexpected token algorithm";
  const now = (deps.now ?? new Date()).getTime();
  const doFetch = deps.fetch ?? fetch;
  let jwk = (await googleKeys(doFetch, now)).find((k) => k.kid === header.kid);
  // Google rotates its keys: a kid not in the cached set gets one refetch (rate-limited).
  if (!jwk && typeof header.kid === "string" && now - lastUnknownKidRefetch >= UNKNOWN_KID_REFETCH_MS) {
    lastUnknownKidRefetch = now;
    jwk = (await googleKeys(doFetch, now, true)).find((k) => k.kid === header.kid);
  }
  if (!jwk) return "the token wasn't signed by a current Google key";
  const ok = verifySig("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk as never, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!ok) return "the token's signature doesn't match";
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") return "the token isn't from Google";
  if (claims.aud !== expect.audience) return "the token is for another audience";
  if (claims.email !== expect.email || claims.email_verified !== true) return "the token is for another service account";
  if (!claims.exp || claims.exp * 1000 < now - 60_000) return "the token has expired";
  return null;
}

// ---------------------------------------------------------------------------
// RTDN body
// ---------------------------------------------------------------------------

/** https://developer.android.com/google/play/billing/rtdn-reference */
export type DeveloperNotification = {
  version?: string;
  packageName: string;
  eventTimeMillis: string;
  subscriptionNotification?: { version?: string; notificationType: number; purchaseToken: string; subscriptionId?: string };
  oneTimeProductNotification?: { version?: string; notificationType: number; purchaseToken: string; sku: string };
  voidedPurchaseNotification?: { purchaseToken: string; orderId: string; productType: number; refundType?: number };
  testNotification?: { version?: string };
};

export const SUBSCRIPTION_NOTIFICATION: Record<number, string> = {
  1: "SUBSCRIPTION_RECOVERED",
  2: "SUBSCRIPTION_RENEWED",
  3: "SUBSCRIPTION_CANCELED",
  4: "SUBSCRIPTION_PURCHASED",
  5: "SUBSCRIPTION_ON_HOLD",
  6: "SUBSCRIPTION_IN_GRACE_PERIOD",
  7: "SUBSCRIPTION_RESTARTED",
  8: "SUBSCRIPTION_PRICE_CHANGE_CONFIRMED",
  9: "SUBSCRIPTION_DEFERRED",
  10: "SUBSCRIPTION_PAUSED",
  11: "SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED",
  12: "SUBSCRIPTION_REVOKED",
  13: "SUBSCRIPTION_EXPIRED",
  17: "SUBSCRIPTION_ITEMS_CHANGED",
  19: "SUBSCRIPTION_PRICE_CHANGE_UPDATED",
  20: "SUBSCRIPTION_PENDING_PURCHASE_CANCELED",
};

/** Pure. The Pub/Sub push body → message id and the developer notification. */
export function parsePush(body: unknown): { messageId: string; notification: DeveloperNotification } | null {
  const b = (body ?? {}) as { message?: { data?: string; messageId?: string; message_id?: string } };
  const id = b.message?.messageId ?? b.message?.message_id;
  if (!b.message?.data || !id) return null;
  try {
    const n = JSON.parse(Buffer.from(b.message.data, "base64").toString("utf-8")) as DeveloperNotification;
    if (!n || typeof n.packageName !== "string") return null;
    return { messageId: String(id), notification: n };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Play Developer API: purchases
// ---------------------------------------------------------------------------

/** https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2 */
export type SubscriptionPurchaseV2 = {
  kind?: string;
  regionCode?: string;
  startTime?: string;
  subscriptionState?: string;
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  acknowledgementState?: string;
  testPurchase?: Record<string, never>;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string; obfuscatedExternalProfileId?: string };
  canceledStateContext?: unknown;
  lineItems?: Array<{
    productId: string;
    expiryTime?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean; recurringPrice?: { currencyCode: string; units?: string; nanos?: number } };
    offerDetails?: { basePlanId?: string; offerId?: string; offerTags?: string[] };
    latestSuccessfulOrderId?: string;
  }>;
};

/** https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products */
export type ProductPurchase = {
  purchaseTimeMillis?: string;
  purchaseState?: number; // 0 purchased, 1 canceled, 2 pending
  consumptionState?: number;
  orderId?: string;
  acknowledgementState?: number;
  purchaseType?: number; // 0 test, 1 promo, 2 rewarded
  obfuscatedExternalAccountId?: string;
  regionCode?: string;
  quantity?: number;
};

export const moneyOf = (p?: { currencyCode: string; units?: string; nanos?: number }) => (p ? { amount: Number(p.units ?? 0) + (p.nanos ?? 0) / 1e9, currency: p.currencyCode } : null);

/** Pure. An RS256 service-account assertion for any scope. */
export function scopedJwt(cred: PlayCredential, scope: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: cred.clientEmail, scope, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const key = cred.privateKey.includes("\\n") ? cred.privateKey.replace(/\\n/g, "\n") : cred.privateKey;
  return `${header}.${claims}.${b64url(signer.sign(key))}`;
}

export type GoogleClient = {
  call<T>(url: string, init?: { method?: string; body?: unknown; query?: Record<string, string> }): Promise<T>;
};

/** A small authorized JSON client for one scope (token cached until a minute before expiry). */
export function googleClient(cred: PlayCredential, scope: string, deps: { fetch?: typeof fetch; now?: () => Date } = {}): GoogleClient {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  let token: { value: string; until: number } | null = null;
  const access = async () => {
    if (token && token.until - 60_000 > now().getTime()) return token.value;
    const r = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: scopedJwt(cred, scope, now()) }).toString(),
    });
    if (!r.ok) throw new GoogleError("didn't accept the service account key", r.status, r.status >= 500);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    token = { value: j.access_token, until: now().getTime() + j.expires_in * 1000 };
    return token.value;
  };
  return {
    async call<T>(url: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
      const u = new URL(url);
      for (const [k, v] of Object.entries(init.query ?? {})) u.searchParams.set(k, v);
      let res: Response;
      try {
        res = await doFetch(u.toString(), {
          method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
          headers: { authorization: `Bearer ${await access()}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
      } catch (err) {
        throw new GoogleError(`couldn't reach Google (${redact((err as Error).message)})`, undefined, true);
      }
      const text = await res.text();
      if (!res.ok) {
        let msg = text.slice(0, 300);
        try {
          msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
        } catch {
          /* not JSON */
        }
        throw new GoogleError(`${res.status} ${redact(msg)}`, res.status, res.status === 429 || res.status >= 500);
      }
      return (text ? JSON.parse(text) : undefined) as T;
    },
  };
}

export type PlayPurchases = {
  subscription(pkg: string, token: string): Promise<SubscriptionPurchaseV2>;
  product(pkg: string, productId: string, token: string): Promise<ProductPurchase>;
  acknowledgeSubscription(pkg: string, subscriptionId: string, token: string): Promise<void>;
  acknowledgeProduct(pkg: string, productId: string, token: string): Promise<void>;
  /** Order ids Google voided (refunds, chargebacks) since a time (purchases.voidedpurchases.list, subscriptions and one-time). */
  voidedOrders(pkg: string, sinceMs: number): Promise<Set<string>>;
};

export function createPlayPurchases(client: GoogleClient): PlayPurchases {
  const app = (pkg: string) => `${PLAY}/applications/${encodeURIComponent(pkg)}`;
  return {
    subscription: (pkg, token) => client.call(`${app(pkg)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`),
    product: (pkg, productId, token) => client.call(`${app(pkg)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`),
    acknowledgeSubscription: (pkg, sub, token) => client.call(`${app(pkg)}/purchases/subscriptions/${encodeURIComponent(sub)}/tokens/${encodeURIComponent(token)}:acknowledge`, { method: "POST", body: {} }),
    acknowledgeProduct: (pkg, productId, token) => client.call(`${app(pkg)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`, { method: "POST", body: {} }),
    async voidedOrders(pkg, sinceMs) {
      const r = await client.call<{ voidedPurchases?: Array<{ orderId?: string }> }>(`${app(pkg)}/purchases/voidedpurchases`, { query: { startTime: String(sinceMs), type: "1", maxResults: "1000" } });
      return new Set((r?.voidedPurchases ?? []).map((v) => v.orderId).filter((x): x is string => Boolean(x)));
    },
  };
}

// ---------------------------------------------------------------------------
// Pub/Sub: topic + push subscription (optional automation)
// ---------------------------------------------------------------------------

export type PubSubSetup = { topic: string; subscription: string };

/**
 * Creates (or reuses) the topic, lets Google Play publish to it, and pushes
 * it to day2's webhook with an OIDC token as `pushAs`. Needs the service
 * account to have Pub/Sub Admin in `project`; any 403 becomes a walkthrough.
 * https://developer.android.com/google/play/billing/getting-ready#configure-rtdn
 */
export async function setupPubSub(client: GoogleClient, o: { project: string; topicName: string; endpoint: string; pushAs: string }): Promise<PubSubSetup> {
  const topic = `projects/${o.project}/topics/${o.topicName}`;
  const subscription = `projects/${o.project}/subscriptions/${o.topicName}-day2`;
  const exists = (err: unknown) => err instanceof GoogleError && err.status === 409;
  await client.call(`${PUBSUB}/${topic}`, { method: "PUT", body: {} }).catch((err) => {
    if (!exists(err)) throw err;
  });
  const policy = await client.call<{ bindings?: Array<{ role: string; members: string[] }>; etag?: string }>(`${PUBSUB}/${topic}:getIamPolicy`);
  const bindings = policy.bindings ?? [];
  const pub = bindings.find((b) => b.role === "roles/pubsub.publisher");
  if (!pub?.members.includes(PLAY_PUBLISHER)) {
    const next = pub ? bindings.map((b) => (b === pub ? { ...b, members: [...b.members, PLAY_PUBLISHER] } : b)) : [...bindings, { role: "roles/pubsub.publisher", members: [PLAY_PUBLISHER] }];
    await client.call(`${PUBSUB}/${topic}:setIamPolicy`, { method: "POST", body: { policy: { ...policy, bindings: next } } });
  }
  await client
    .call(`${PUBSUB}/${subscription}`, {
      method: "PUT",
      body: { topic, pushConfig: { pushEndpoint: o.endpoint, oidcToken: { serviceAccountEmail: o.pushAs, audience: o.endpoint } }, ackDeadlineSeconds: 30 },
    })
    .catch((err) => {
      if (!exists(err)) throw err;
    });
  return { topic, subscription };
}
