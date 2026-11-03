import { X509Certificate, verify as verifySig } from "node:crypto";

/**
 * Apple's signed data (JWS) — App Store Server Notifications V2, and the
 * signed transactions / renewal infos inside them and in App Store Server
 * API answers.
 *
 * Verified the way Apple's own App Store Server Library does it:
 *  1. The header's x5c chain (leaf, intermediate, root) — each certificate
 *     within its validity dates and issued and signed by the next one.
 *  2. The root is Apple Root CA - G3 (pinned by its SHA-256 fingerprint).
 *  3. The leaf carries Apple's marker OID 1.2.840.113635.100.6.11.1 and the
 *     intermediate 1.2.840.113635.100.6.2.1 (Apple's WWDR intermediate).
 *  4. The ES256 signature over header.payload, with the leaf's key.
 * Nothing is trusted before all four hold.
 */

/** SHA-256 of Apple Root CA - G3 (https://www.apple.com/certificateauthority/). */
export const APPLE_ROOT_CA_G3_SHA256 = "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79";

// DER encodings of Apple's marker OIDs (tag 06, length 0A, value).
const LEAF_OID = Buffer.from("060a2a864886f76364060b01", "hex"); // 1.2.840.113635.100.6.11.1
const INTERMEDIATE_OID = Buffer.from("060a2a864886f76364060201", "hex"); // 1.2.840.113635.100.6.2.1

export class JwsError extends Error {}

export type JwsOptions = {
  /** Accepted root fingerprints (default: Apple Root CA - G3). Tests pass their own. */
  roots?: string[];
  now?: Date;
};

const norm = (fp: string) => fp.replace(/:/g, "").toUpperCase();

function b64urlJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));
  } catch {
    throw new JwsError("not a JWS (a part isn't base64url JSON)");
  }
}

/** Pure. Verifies an Apple JWS and returns its payload. Throws JwsError. */
export function verifyAppleJws<T = Record<string, unknown>>(jws: string, opts: JwsOptions = {}): T {
  if (typeof jws !== "string") throw new JwsError("not a JWS");
  const parts = jws.split(".");
  if (parts.length !== 3) throw new JwsError("not a JWS (needs three parts)");
  const [h, p, s] = parts as [string, string, string];
  const header = b64urlJson(h) as { alg?: string; x5c?: unknown };
  if (header.alg !== "ES256") throw new JwsError(`unexpected algorithm ${String(header.alg)}`);
  if (!Array.isArray(header.x5c) || header.x5c.length !== 3 || !header.x5c.every((c) => typeof c === "string")) throw new JwsError("the certificate chain (x5c) must have three certificates");

  let certs: X509Certificate[];
  try {
    certs = (header.x5c as string[]).map((c) => new X509Certificate(Buffer.from(c, "base64")));
  } catch {
    throw new JwsError("a certificate in the chain doesn't parse");
  }
  const [leaf, intermediate, root] = certs as [X509Certificate, X509Certificate, X509Certificate];
  const now = (opts.now ?? new Date()).getTime();
  for (const c of certs) if (!(Date.parse(c.validFrom) <= now && now <= Date.parse(c.validTo))) throw new JwsError("a certificate in the chain is expired or not yet valid");
  if (!leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) throw new JwsError("the signing certificate isn't issued by the intermediate");
  if (!intermediate.checkIssued(root) || !intermediate.verify(root.publicKey)) throw new JwsError("the intermediate isn't issued by the root");
  if (!root.verify(root.publicKey)) throw new JwsError("the root isn't self-signed");
  const roots = (opts.roots ?? [APPLE_ROOT_CA_G3_SHA256]).map(norm);
  if (!roots.includes(norm(root.fingerprint256))) throw new JwsError("the chain doesn't end in Apple Root CA - G3");
  if (!leaf.raw.includes(LEAF_OID)) throw new JwsError("the signing certificate isn't Apple's App Store signing certificate");
  if (!intermediate.raw.includes(INTERMEDIATE_OID)) throw new JwsError("the intermediate isn't Apple's WWDR certificate");

  const sig = Buffer.from(s, "base64url");
  if (sig.length !== 64) throw new JwsError("bad signature length");
  const ok = verifySig("sha256", Buffer.from(`${h}.${p}`), { key: leaf.publicKey, dsaEncoding: "ieee-p1363" }, sig);
  if (!ok) throw new JwsError("the signature doesn't match");
  return b64urlJson(p) as T;
}

// ---------------------------------------------------------------------------
// Decoded shapes (the fields day2 uses; Apple sends more)
// ---------------------------------------------------------------------------

export type AppleEnvironment = "Sandbox" | "Production" | "Xcode" | "LocalTesting";

/** https://developer.apple.com/documentation/appstoreservernotifications/responsebodyv2decodedpayload */
export type AppleNotification = {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  version?: string;
  signedDate?: number;
  data?: {
    appAppleId?: number;
    bundleId?: string;
    bundleVersion?: string;
    environment?: AppleEnvironment;
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
    status?: number;
  };
  summary?: unknown;
};

/** https://developer.apple.com/documentation/appstoreserverapi/jwstransactiondecodedpayload */
export type AppleTransaction = {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate: number;
  originalPurchaseDate?: number;
  expiresDate?: number;
  type: "Auto-Renewable Subscription" | "Non-Consumable" | "Consumable" | "Non-Renewing Subscription";
  appAccountToken?: string;
  quantity?: number;
  /** Price in milliunits of `currency` (e.g. 4990 = 4.99), tax included. */
  price?: number;
  currency?: string;
  storefront?: string;
  environment?: AppleEnvironment;
  transactionReason?: "PURCHASE" | "RENEWAL";
  /** 1 = introductory offer, 2 = promotional, 3 = offer code, 4 = win-back. */
  offerType?: number;
  offerDiscountType?: "FREE_TRIAL" | "PAY_AS_YOU_GO" | "PAY_UP_FRONT";
  revocationDate?: number;
  revocationReason?: number;
  inAppOwnershipType?: "PURCHASED" | "FAMILY_SHARED";
};

/** https://developer.apple.com/documentation/appstoreserverapi/jwsrenewalinfodecodedpayload */
export type AppleRenewalInfo = {
  originalTransactionId: string;
  autoRenewProductId?: string;
  productId?: string;
  autoRenewStatus?: 0 | 1;
  expirationIntent?: number;
  isInBillingRetryPeriod?: boolean;
  gracePeriodExpiresDate?: number;
  renewalPrice?: number;
  currency?: string;
};

export type DecodedAppleNotification = { notification: AppleNotification; transaction: AppleTransaction | null; renewal: AppleRenewalInfo | null };

/** Pure. A notification's signedPayload with its signed transaction and renewal info, all verified. */
export function decodeAppleNotification(signedPayload: string, opts: JwsOptions = {}): DecodedAppleNotification {
  const notification = verifyAppleJws<AppleNotification>(signedPayload, opts);
  if (!notification.notificationType || !notification.notificationUUID) throw new JwsError("not an App Store Server Notification V2");
  const d = notification.data ?? {};
  return {
    notification,
    transaction: d.signedTransactionInfo ? verifyAppleJws<AppleTransaction>(d.signedTransactionInfo, opts) : null,
    renewal: d.signedRenewalInfo ? verifyAppleJws<AppleRenewalInfo>(d.signedRenewalInfo, opts) : null,
  };
}
