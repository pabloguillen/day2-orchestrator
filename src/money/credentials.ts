import type { SQL } from "bun";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decryptSecret, encryptSecret } from "../secrets";

/**
 * The keys only Money needs, stored encrypted (DAY2_SECRETS_KEY) like
 * release_credentials and never returned by the API or logged:
 *  - "iap": Apple's In-App Purchase key (App Store Connect → Users and
 *    Access → Integrations → In-App Purchase) — a separate key from the App
 *    Store Connect API key, for the App Store Server API;
 *  - "rtdn": how Google's Pub/Sub push proves itself (the service account
 *    the push subscription signs its OIDC token as, and the audience);
 *  - "revenuecat": only for apps that already use RevenueCat — the webhook
 *    authorization value and a secret API key.
 * The App Store Connect API key and the Google Play service account are the
 * ones already connected for releases (mobile-release/credentials.ts).
 */

export type MoneyCredentialKind = "iap" | "rtdn" | "revenuecat";
export type IapCredential = { issuerId: string; keyId: string; privateKey: string };
export type RtdnCredential = { pushServiceAccount: string; audience: string };
export type RevenueCatCredential = { webhookAuth: string; apiKey?: string };
export type MoneyCredential = { iap: IapCredential; rtdn: RtdnCredential; revenuecat: RevenueCatCredential };

export interface MoneyCredentialStore {
  get<K extends MoneyCredentialKind>(appId: string, kind: K): Promise<MoneyCredential[K] | null>;
  list(appId: string): Promise<Array<{ kind: MoneyCredentialKind; label: string; setBy: string | null; setAt: string }>>;
  set<K extends MoneyCredentialKind>(appId: string, kind: K, value: MoneyCredential[K], label: string, by: string | null): Promise<void>;
  remove(appId: string, kind: MoneyCredentialKind): Promise<void>;
}

const ctx = (appId: string, kind: string) => `money-credential:${appId}:${kind}`;

/** Pure. Checks what a person pasted; throws a plain-language error. */
export function parseMoneyCredential(kind: MoneyCredentialKind, input: unknown): { value: MoneyCredential[MoneyCredentialKind]; label: string } {
  const o = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
  if (kind === "iap") {
    const issuerId = str("issuerId");
    const keyId = str("keyId");
    const privateKey = str("privateKey");
    if (!/^[0-9a-f-]{36}$/i.test(issuerId)) throw new Error("The issuer id is the UUID shown at the top of App Store Connect → Users and Access → Integrations.");
    if (!/^[A-Z0-9]{10}$/.test(keyId)) throw new Error("The key id is 10 letters and digits, next to the In-App Purchase key's name.");
    if (!/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(privateKey)) throw new Error("Paste the whole .p8 file (SubscriptionKey_….p8), including the BEGIN and END lines.");
    return { value: { issuerId, keyId, privateKey }, label: `In-App Purchase key ${keyId}` };
  }
  if (kind === "rtdn") {
    const pushServiceAccount = str("pushServiceAccount");
    const audience = str("audience");
    if (!/^[^@\s]+@[\w-]+\.iam\.gserviceaccount\.com$/.test(pushServiceAccount)) throw new Error("That isn't a Google service account email (…@….iam.gserviceaccount.com).");
    if (!/^https:\/\/\S+$/.test(audience)) throw new Error("The audience is the https address the push subscription sends to.");
    return { value: { pushServiceAccount, audience }, label: `Pub/Sub push as ${pushServiceAccount}` };
  }
  const webhookAuth = str("webhookAuth");
  const apiKey = str("apiKey");
  if (webhookAuth.length < 16) throw new Error("Use a long random value (16+ characters) for RevenueCat's webhook authorization header.");
  if (apiKey && !/^sk_\w{10,}$/.test(apiKey)) throw new Error("RevenueCat secret API keys start with sk_.");
  return { value: { webhookAuth, ...(apiKey ? { apiKey } : {}) }, label: "RevenueCat webhook" };
}

type FileShape = Record<string, { kind: MoneyCredentialKind; secret: string; label: string; setBy: string | null; setAt: string }>;

export function fileMoneyCredentials(path: string): MoneyCredentialStore {
  const load = (): FileShape => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as FileShape) : {});
  const save = (f: FileShape) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(f, null, 2));
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  };
  const key = (appId: string, kind: string) => `${appId}|${kind}`;
  return {
    async get(appId, kind) {
      const r = load()[key(appId, kind)];
      return r ? (JSON.parse(decryptSecret(r.secret, ctx(appId, kind))) as never) : null;
    },
    async list(appId) {
      return Object.entries(load())
        .filter(([k]) => k.startsWith(`${appId}|`))
        .map(([, r]) => ({ kind: r.kind, label: r.label, setBy: r.setBy, setAt: r.setAt }));
    },
    async set(appId, kind, value, label, by) {
      const f = load();
      f[key(appId, kind)] = { kind, secret: encryptSecret(JSON.stringify(value), ctx(appId, kind)), label, setBy: by, setAt: new Date().toISOString() };
      save(f);
    },
    async remove(appId, kind) {
      const f = load();
      delete f[key(appId, kind)];
      save(f);
    },
  };
}

type Row = { kind: MoneyCredentialKind; secret: string; label: string; set_by: string | null; set_at: Date | string };

export function dbMoneyCredentials(sql: SQL): MoneyCredentialStore {
  return {
    async get(appId, kind) {
      const [r] = (await sql`SELECT secret FROM money_credentials WHERE app_id = ${appId} AND kind = ${kind}`) as Row[];
      return r ? (JSON.parse(decryptSecret(r.secret, ctx(appId, kind))) as never) : null;
    },
    async list(appId) {
      const rows = (await sql`SELECT kind, label, set_by, set_at FROM money_credentials WHERE app_id = ${appId}`) as Row[];
      return rows.map((r) => ({ kind: r.kind, label: r.label, setBy: r.set_by, setAt: new Date(r.set_at).toISOString() }));
    },
    async set(appId, kind, value, label, by) {
      await sql`INSERT INTO money_credentials (app_id, kind, secret, label, set_by) VALUES (${appId}, ${kind}, ${encryptSecret(JSON.stringify(value), ctx(appId, kind))}, ${label}, ${by})
                ON CONFLICT (app_id, kind) DO UPDATE SET secret = EXCLUDED.secret, label = EXCLUDED.label, set_by = EXCLUDED.set_by, set_at = now()`;
    },
    async remove(appId, kind) {
      await sql`DELETE FROM money_credentials WHERE app_id = ${appId} AND kind = ${kind}`;
    },
  };
}
