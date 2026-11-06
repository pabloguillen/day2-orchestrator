import { ascJwt } from "../mobile-release/app-store";
import type { AscCredential } from "../mobile-release/credentials";
import { AppleReportError, createAppleReports } from "../numbers/apple";

/**
 * The Apple steps day2 can do or check itself with the App Store Connect
 * API key. Apple has no API to create keys, sign agreements or read the
 * vendor number, so those stay on the guided checklist (connect/hub.ts).
 *
 * - Server notification URL: PATCH /v1/apps/{id} with subscriptionStatusUrl
 *   (+ ForSandbox, Version "V2") — the attributes App Store Connect API's
 *   AppUpdateRequest takes. Needs an App Manager or Admin key. Not yet run
 *   against a real account.
 * - App Analytics: an ONGOING analyticsReportRequest exists, or the key can
 *   create one (Apple lets only Admin keys create it).
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const BASE = "https://api.appstoreconnect.apple.com";

/** Pure. "AuthKey_ABCD123456.p8" / "SubscriptionKey_ABCD123456.p8" → "ABCD123456". */
export function keyIdFromFilename(name: string | null | undefined): string | null {
  const m = /(?:AuthKey|SubscriptionKey|ApiKey)_([A-Z0-9]{10})\.p8$/i.exec((name ?? "").trim());
  return m ? m[1]!.toUpperCase() : null;
}

export type AppleResult = { ok: true; note: string } | { ok: false; why: string };

async function appleId(cred: AscCredential, bundleId: string, doFetch: FetchLike): Promise<string | null> {
  const res = await doFetch(`${BASE}/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=bundleId&limit=5`, { headers: { authorization: `Bearer ${ascJwt(cred, new Date())}` } });
  if (!res.ok) throw new AppleReportError(res.status === 401 ? "Apple didn't accept the App Store Connect key." : `App Store Connect answered ${res.status}.`, res.status);
  const j = (await res.json()) as { data?: Array<{ id: string; attributes?: { bundleId?: string } }> };
  return j.data?.find((a) => a.attributes?.bundleId === bundleId)?.id ?? null;
}

/** Sets the App Store Server Notifications URLs (production and sandbox, version 2) for the app. */
export async function setNotificationsUrl(cred: AscCredential, bundleId: string, url: string, doFetch: FetchLike = fetch): Promise<AppleResult> {
  let id: string | null;
  try {
    id = await appleId(cred, bundleId, doFetch);
  } catch (err) {
    return { ok: false, why: (err as Error).message };
  }
  if (!id) return { ok: false, why: `App Store Connect has no app with the bundle id ${bundleId} on this key's team.` };
  const res = await doFetch(`${BASE}/v1/apps/${id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${ascJwt(cred, new Date())}`, "content-type": "application/json" },
    body: JSON.stringify({ data: { type: "apps", id, attributes: { subscriptionStatusUrl: url, subscriptionStatusUrlVersion: "V2", subscriptionStatusUrlForSandbox: url, subscriptionStatusUrlVersionForSandbox: "V2" } } }),
  }).catch(() => null);
  if (!res) return { ok: false, why: "day2 couldn't reach App Store Connect. Try again in a minute." };
  if (res.ok) return { ok: true, note: `Apple sends purchase notifications to ${url} (production and sandbox, version 2).` };
  const text = await res.text().catch(() => "");
  if (res.status === 403) return { ok: false, why: "The App Store Connect key can't change the app. It needs the App Manager or Admin role." };
  if (res.status === 409) return { ok: false, why: `Apple refused the address: ${detail(text) ?? "check that it's https and reachable"}.` };
  return { ok: false, why: `App Store Connect answered ${res.status}${detail(text) ? `: ${detail(text)}` : ""}.` };
}

const detail = (text: string): string | null => {
  try {
    return ((JSON.parse(text) as { errors?: Array<{ detail?: string }> }).errors?.[0]?.detail ?? null)?.slice(0, 200) ?? null;
  } catch {
    return null;
  }
};

/**
 * App Analytics: is there an ongoing report request (so Numbers gets
 * impressions, page views and sessions)? If not, try to start one with
 * `cred` — Apple allows that only for Admin keys.
 */
export async function ensureAnalytics(cred: AscCredential, bundleId: string, deps: { fetch?: FetchLike } = {}): Promise<AppleResult & { requestId?: string }> {
  const a = createAppleReports(cred, deps.fetch ? { fetch: deps.fetch } : {});
  try {
    const id = await a.findAppId(bundleId);
    if (!id) return { ok: false, why: `App Store Connect has no app with the bundle id ${bundleId} on this key's team.` };
    const have = await a.ongoingRequest(id);
    if (have) return { ok: true, note: "Apple is preparing the App Analytics reports for day2.", requestId: have };
    const made = await a.createOngoingRequest(id);
    return { ok: true, note: "day2 asked Apple for the App Analytics reports. The first ones arrive in 1–2 days.", requestId: made };
  } catch (err) {
    if (err instanceof AppleReportError && err.status === 403) return { ok: false, why: "Only an Admin key can start the App Analytics reports, once. Create a key with the Admin role, add it here, and revoke it afterwards — day2 doesn't keep it." };
    return { ok: false, why: (err as Error).message };
  }
}
