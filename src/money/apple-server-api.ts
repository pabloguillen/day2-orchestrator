import { createSign } from "node:crypto";
import { redact } from "../ads/http";
import type { IapCredential } from "./credentials";

/**
 * App Store Server API — looking up a transaction or a subscription's
 * status, and asking Apple to send a test notification. Authenticated with
 * the In-App Purchase key (not the App Store Connect API key): an ES256 JWT
 * with iss (issuer id), iat, exp (≤ 60 min), aud "appstoreconnect-v1" and
 * bid (the app's bundle id), and the key id as kid.
 * https://developer.apple.com/documentation/appstoreserverapi/generating-json-web-tokens-for-api-requests
 */

export const STOREKIT_PRODUCTION = "https://api.storekit.itunes.apple.com";
export const STOREKIT_SANDBOX = "https://api.storekit-sandbox.itunes.apple.com";
const TTL_SEC = 20 * 60;

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** Pure. */
export function storeKitJwt(cred: IapCredential, bundleId: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", kid: cred.keyId, typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: cred.issuerId, iat, exp: iat + TTL_SEC, aud: "appstoreconnect-v1", bid: bundleId }));
  const key = cred.privateKey.includes("\\n") ? cred.privateKey.replace(/\\n/g, "\n") : cred.privateKey;
  const signer = createSign("SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign({ key, dsaEncoding: "ieee-p1363" }))}`;
}

export class StoreKitError extends Error {
  constructor(
    message: string,
    public status?: number,
    public retryable = false,
  ) {
    super(`App Store Server API: ${message}`);
  }
}

export type AppStoreServerApi = {
  /** The signed transaction (JWS) for a transaction id. Tries production, then sandbox (Apple's advice for TestFlight/sandbox purchases). */
  transaction(transactionId: string): Promise<{ signedTransactionInfo: string; sandbox: boolean }>;
  /** All subscription statuses for a transaction's subscription group. */
  subscriptionStatuses(transactionId: string): Promise<{ data: Array<{ subscriptionGroupIdentifier: string; lastTransactions: Array<{ status: number; originalTransactionId: string; signedTransactionInfo: string; signedRenewalInfo: string }> }> }>;
  /** Asks Apple to send a TEST notification to the URL set in App Store Connect. */
  requestTestNotification(sandbox?: boolean): Promise<{ testNotificationToken: string }>;
  /** Whether Apple delivered that test notification (and what our server answered). */
  testNotificationStatus(token: string, sandbox?: boolean): Promise<{ firstSendAttemptResult?: string; sendAttempts?: Array<{ attemptDate: number; sendAttemptResult: string }> }>;
};

export function createAppStoreServerApi(cred: IapCredential, bundleId: string, deps: { fetch?: typeof fetch; now?: () => Date } = {}): AppStoreServerApi {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());

  async function call<T>(base: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${storeKitJwt(cred, bundleId, now())}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (err) {
      throw new StoreKitError(`couldn't reach Apple (${redact((err as Error).message)})`, undefined, true);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { errorMessage?: string; errorCode?: number };
        if (j.errorMessage) msg = `${j.errorMessage}${j.errorCode ? ` (${j.errorCode})` : ""}`;
      } catch {
        /* not JSON */
      }
      if (res.status === 401) msg = "Apple didn't accept the In-App Purchase key (check the issuer id, the key id and that the key isn't revoked).";
      throw new StoreKitError(`${res.status} ${redact(msg)}`, res.status, res.status === 429 || res.status >= 500);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Production first; a 404 there means the transaction may be in the sandbox. */
  async function either<T>(path: string): Promise<{ r: T; sandbox: boolean }> {
    try {
      return { r: await call<T>(STOREKIT_PRODUCTION, path), sandbox: false };
    } catch (err) {
      if (!(err instanceof StoreKitError) || err.status !== 404) throw err;
      return { r: await call<T>(STOREKIT_SANDBOX, path), sandbox: true };
    }
  }

  return {
    async transaction(id) {
      const { r, sandbox } = await either<{ signedTransactionInfo: string }>(`/inApps/v1/transactions/${encodeURIComponent(id)}`);
      return { signedTransactionInfo: r.signedTransactionInfo, sandbox };
    },
    async subscriptionStatuses(id) {
      return (await either<Awaited<ReturnType<AppStoreServerApi["subscriptionStatuses"]>>>(`/inApps/v1/subscriptions/${encodeURIComponent(id)}`)).r;
    },
    requestTestNotification: (sandbox = false) => call(sandbox ? STOREKIT_SANDBOX : STOREKIT_PRODUCTION, "/inApps/v1/notifications/test", { method: "POST" }),
    testNotificationStatus: (token, sandbox = false) => call(sandbox ? STOREKIT_SANDBOX : STOREKIT_PRODUCTION, `/inApps/v1/notifications/test/${encodeURIComponent(token)}`),
  };
}
