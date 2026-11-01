import { runCmd, tail } from "../device-checks/run-cmd";
import { ascJwt } from "./app-store";
import type { AscCredential, ExpoCredential, PlayCredential } from "./credentials";
import { serviceAccountJwt } from "./play";

/**
 * Before a connection is saved: does it actually work for this app? Each
 * answer says, in plain words, what to fix — the most common mistakes
 * (wrong role, app not added to the service account, a revoked token) get
 * their own message.
 */

export type Access = { ok: true; who: string } | { ok: false; why: string };

export async function checkExpo(cred: ExpoCredential): Promise<Access> {
  const r = await runCmd(["npx", "--yes", "eas-cli@27.2.0", "whoami"], { env: { EXPO_TOKEN: cred.token, CI: "1" }, timeoutMs: 90_000 });
  const who = r.out.trim().split("\n")[0]?.trim();
  if (r.code === 0 && who) return { ok: true, who: `Expo account ${who}` };
  if (/unauthori|invalid|expired|401/i.test(r.err + r.out)) return { ok: false, why: "Expo didn't accept that token. Create a new one (expo.dev → Account settings → Access tokens) and paste it whole." };
  return { ok: false, why: `day2 couldn't reach Expo to check the token (${tail(r.err || r.out, 2) || "no answer"}). Try again in a minute.` };
}

export async function checkAsc(cred: AscCredential, bundleId: string | null, doFetch: typeof fetch = fetch): Promise<Access> {
  let res: Response;
  try {
    const q = bundleId ? `?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1` : "?limit=1";
    res = await doFetch(`https://api.appstoreconnect.apple.com/v1/apps${q}`, { headers: { authorization: `Bearer ${ascJwt(cred, new Date())}` }, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    if (/key|pem|asn1|decoder/i.test((err as Error).message)) return { ok: false, why: "The .p8 file didn't read as a key. Paste the whole file, including the BEGIN and END lines." };
    return { ok: false, why: "day2 couldn't reach App Store Connect. Try again in a minute." };
  }
  if (res.status === 401) return { ok: false, why: "Apple didn't accept the key: check the issuer id (top of the Keys page) and the key id (next to the key's name), and that the key isn't revoked." };
  if (res.status === 403) return { ok: false, why: "The key works but can't see apps. Create it with the App Manager role (Users and Access → Integrations → Team Keys)." };
  if (!res.ok) return { ok: false, why: `App Store Connect answered ${res.status}. Try again in a minute.` };
  const j = (await res.json().catch(() => ({}))) as { data?: Array<{ attributes?: { name?: string } }> };
  if (bundleId && !j.data?.length) return { ok: false, why: `The key works, but App Store Connect has no app with the bundle id ${bundleId} for this team. Is it the right Apple team?` };
  return { ok: true, who: j.data?.[0]?.attributes?.name ? `App Store Connect: ${j.data[0].attributes.name}` : "App Store Connect" };
}

export async function checkPlay(cred: PlayCredential, packageName: string | null, doFetch: typeof fetch = fetch): Promise<Access> {
  let token = "";
  try {
    const t = await doFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountJwt(cred, new Date()) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!t.ok) return { ok: false, why: "Google didn't accept the service account key. Create a new JSON key for it (Google Cloud → IAM → Service accounts → Keys) and paste the whole file." };
    token = ((await t.json()) as { access_token?: string }).access_token ?? "";
  } catch {
    return { ok: false, why: "day2 couldn't reach Google. Try again in a minute." };
  }
  if (!packageName) return { ok: true, who: cred.clientEmail };
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/edits`;
  // Opening an edit (and throwing it away) is the lightest call that proves release access.
  const r = await doFetch(base, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!r) return { ok: false, why: "day2 couldn't reach Google Play. Try again in a minute." };
  if (r.status === 403) {
    const text = await r.text();
    if (/has not been used|disabled|SERVICE_DISABLED/i.test(text)) return { ok: false, why: "Turn on the Google Play Android Developer API for the service account's Google Cloud project (the link in step 2), wait a minute, then try again." };
    return { ok: false, why: `The service account can't release ${packageName} yet. In Play Console → Users and permissions, invite ${cred.clientEmail} and give it access to this app with "Release to production" and "Manage testing tracks" — it can take a few minutes to apply.` };
  }
  if (r.status === 404) return { ok: false, why: `Google Play has no app ${packageName} for this account yet — the first upload has to happen once by hand in the Play Console.` };
  if (!r.ok) return { ok: false, why: `Google Play answered ${r.status}. Try again in a minute.` };
  const id = ((await r.json().catch(() => ({}))) as { id?: string }).id;
  if (id) await doFetch(`${base}/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }).catch(() => {});
  return { ok: true, who: `Google Play: ${packageName}` };
}
