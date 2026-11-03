import { createSign, generateKeyPairSync, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Test helpers: Apple-style JWS signed by a test chain (testdata/*.pem), and Google-style OIDC tokens. */

const dir = import.meta.dir;
const pem = (n: string) => readFileSync(join(dir, n), "utf-8");
const der = (p: string) => new X509Certificate(p).raw.toString("base64");

export const TEST_ROOT = new X509Certificate(pem("root.pem")).fingerprint256;
const chain = [der(pem("leaf.pem")), der(pem("inter.pem")), der(pem("root.pem"))];
const leafKey = pem("leaf.key");

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

export function appleJws(payload: unknown, opts: { x5c?: string[] } = {}): string {
  const h = b64({ alg: "ES256", x5c: opts.x5c ?? chain });
  const p = b64(payload);
  const s = createSign("SHA256");
  s.update(`${h}.${p}`);
  return `${h}.${p}.${s.sign({ key: leafKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

export const otherRootChain = () => [chain[0]!, chain[1]!, der(pem("other-root.pem"))];

/** A notification with a signed transaction inside. */
export function appleNotification(type: string, tx: Record<string, unknown>, o: { subtype?: string; uuid?: string; bundleId?: string } = {}): string {
  return appleJws({
    notificationType: type,
    ...(o.subtype ? { subtype: o.subtype } : {}),
    notificationUUID: o.uuid ?? `n-${Math.random().toString(36).slice(2)}`,
    version: "2.0",
    signedDate: Date.parse("2026-11-01T10:00:00Z"),
    data: { bundleId: o.bundleId ?? "de.dotty.app", environment: "Production", signedTransactionInfo: appleJws({ bundleId: o.bundleId ?? "de.dotty.app", environment: "Production", ...tx }) },
  });
}

// ---- Google OIDC ----

const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const GOOGLE_KID = "test-kid";
export const googleJwks = { keys: [{ ...google.publicKey.export({ format: "jwk" }), kid: GOOGLE_KID, alg: "RS256", use: "sig" }] };

export function googleOidc(claims: Record<string, unknown>, kid = GOOGLE_KID): string {
  const h = b64({ alg: "RS256", kid, typ: "JWT" });
  const p = b64(claims);
  const s = createSign("RSA-SHA256");
  s.update(`${h}.${p}`);
  return `${h}.${p}.${s.sign(google.privateKey).toString("base64url")}`;
}

export function pubsubPush(messageId: string, notification: unknown) {
  return { message: { data: Buffer.from(JSON.stringify(notification)).toString("base64"), messageId, publishTime: "2026-11-01T10:00:00Z" }, subscription: "projects/p/subscriptions/s" };
}
