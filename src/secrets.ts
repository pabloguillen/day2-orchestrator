import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption for customer secrets at rest (JIRA/Linear tokens and the like).
 *
 * AES-256-GCM with a key from DAY2_SECRETS_KEY (32 random bytes, base64 —
 * `openssl rand -base64 32`). Each value gets a fresh 96-bit IV, and is bound
 * to what it belongs to (`context`, e.g. the app id) as associated data, so a
 * ciphertext copied onto another row won't decrypt.
 *
 * Format: `v1.<iv>.<tag>.<ciphertext>` (base64url parts). The version prefix
 * leaves room to rotate keys later.
 */

const PREFIX = "v1";

function key(): Buffer {
  const raw = process.env.DAY2_SECRETS_KEY;
  if (!raw) throw new Error("DAY2_SECRETS_KEY is not set — generate one with `openssl rand -base64 32`.");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("DAY2_SECRETS_KEY must be 32 bytes, base64-encoded (`openssl rand -base64 32`).");
  return k;
}

export function hasSecretsKey(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  c.setAAD(Buffer.from(context, "utf-8"));
  const ct = Buffer.concat([c.update(plaintext, "utf-8"), c.final()]);
  return [PREFIX, iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(value: string, context: string): string {
  const [v, iv, tag, ct] = value.split(".");
  if (v !== PREFIX || !iv || !tag || ct === undefined) throw new Error("Unrecognized secret format.");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(context, "utf-8"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf-8");
}
