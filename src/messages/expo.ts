/**
 * Expo Push API (https://docs.expo.dev/push-notifications/sending-notifications/):
 *
 *   POST https://exp.host/--/api/v2/push/send        ≤ 100 messages per request
 *   POST https://exp.host/--/api/v2/push/getReceipts ≤ 1000 ids per request
 *
 * With "enhanced push security" on in the Expo project, every request needs
 * `Authorization: Bearer <Expo access token>` — the owner's token day2
 * already keeps for releases (mobile-release/credentials.ts). Sending with
 * a token when the setting is off works too, so day2 always sends it.
 *
 * Tickets come back in the same order as the messages; receipts appear
 * after a few minutes (check after ~15 minutes, gone after 24 hours).
 * Network errors, 429 and 5xx are retried with exponential backoff and
 * jitter; 4xx and credential errors aren't.
 */

export const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
export const SEND_BATCH = 100;
export const RECEIPT_BATCH = 1000;

export type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  channelId?: string;
  priority?: "default" | "normal" | "high";
  /** Seconds Expo/APNs/FCM keep trying while the device is offline. */
  ttl?: number;
};

export type ExpoError = "DeviceNotRegistered" | "MessageTooBig" | "MessageRateExceeded" | "MismatchSenderId" | "InvalidCredentials" | string;
export type ExpoTicket = { status: "ok"; id: string } | { status: "error"; message: string; error: ExpoError | null };
export type ExpoReceipt = { status: "ok" } | { status: "error"; message: string; error: ExpoError | null };

/** The whole request failed (e.g. UNAUTHORIZED, TOO_MANY_REQUESTS after retries). */
export class ExpoRequestError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ExpoDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  accessToken: string | null;
  sleep?: (ms: number) => Promise<void>;
  /** For backoff jitter; injected so tests are deterministic. */
  random?: () => number;
};

const MAX_TRIES = 4;

async function post(url: string, body: unknown, deps: ExpoDeps): Promise<unknown> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  let last = "";
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    if (attempt) await sleep(Math.round(1000 * 2 ** (attempt - 1) * (0.5 + random())));
    let res: Response;
    try {
      res = await deps.fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "accept-encoding": "gzip, deflate",
          "content-type": "application/json",
          ...(deps.accessToken ? { authorization: `Bearer ${deps.accessToken}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      last = `network: ${(err as Error).message}`;
      continue;
    }
    const json = (await res.json().catch(() => null)) as { data?: unknown; errors?: Array<{ code?: string; message?: string }> } | null;
    if (res.status === 429 || res.status >= 500) {
      last = json?.errors?.[0]?.code ?? `HTTP ${res.status}`;
      continue;
    }
    const err = json?.errors?.[0];
    if (!res.ok || (err && json?.data === undefined)) {
      throw new ExpoRequestError(err?.code ?? `HTTP_${res.status}`, err?.message ?? `Expo answered ${res.status}.`);
    }
    return json?.data;
  }
  throw new ExpoRequestError(last.startsWith("network") ? "NETWORK" : last || "UNAVAILABLE", `Expo couldn't be reached (${last}).`);
}

type RawResult = { status?: string; id?: string; message?: string; details?: { error?: string } };
const toTicket = (r: RawResult | undefined): ExpoTicket =>
  r?.status === "ok" && typeof r.id === "string" ? { status: "ok", id: r.id } : { status: "error", message: r?.message ?? "No ticket.", error: r?.details?.error ?? null };

/** Sends in batches of 100; tickets in the same order as `messages`. */
export async function sendPush(messages: ExpoMessage[], deps: ExpoDeps): Promise<ExpoTicket[]> {
  const out: ExpoTicket[] = [];
  for (let i = 0; i < messages.length; i += SEND_BATCH) {
    const batch = messages.slice(i, i + SEND_BATCH);
    const data = (await post(EXPO_SEND_URL, batch, deps)) as RawResult[] | RawResult | undefined;
    const list = Array.isArray(data) ? data : [data];
    for (let j = 0; j < batch.length; j++) out.push(toTicket(list[j]));
  }
  return out;
}

/** Receipts for ticket ids (missing = not ready yet). */
export async function getReceipts(ids: string[], deps: ExpoDeps): Promise<Record<string, ExpoReceipt>> {
  const out: Record<string, ExpoReceipt> = {};
  for (let i = 0; i < ids.length; i += RECEIPT_BATCH) {
    const data = ((await post(EXPO_RECEIPTS_URL, { ids: ids.slice(i, i + RECEIPT_BATCH) }, deps)) ?? {}) as Record<string, RawResult>;
    for (const [id, r] of Object.entries(data)) {
      out[id] = r?.status === "ok" ? { status: "ok" } : { status: "error", message: r?.message ?? "Failed.", error: r?.details?.error ?? null };
    }
  }
  return out;
}

/** What the owner has to do about an error, in plain words (null = nothing; day2 handles it). */
export function ownerFix(error: ExpoError | null, platform: "ios" | "android" | null): string | null {
  if (error === "InvalidCredentials") {
    return platform === "android"
      ? "Google rejected the push credentials. In expo.dev → Project settings → Credentials → Android, upload the FCM V1 service account key again."
      : "Apple rejected the push credentials. Run `eas credentials` for iOS and set up a new push key, then make a new build.";
  }
  if (error === "MismatchSenderId") return "The Android push key in EAS belongs to a different Firebase project than the app's google-services.json. Upload the FCM V1 key of the same project.";
  if (error === "UNAUTHORIZED") return "Expo refused day2's access token. Enhanced push security is on, so day2 needs a valid Expo access token (Releases → connections).";
  return null;
}
