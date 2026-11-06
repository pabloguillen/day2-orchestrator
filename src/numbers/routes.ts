import type { AppEntry } from "../apps-registry";
import { storeIdsFromRepo } from "../ads/app-links";
import { createLimiter } from "../rate-limit";
import { releaseCredentials, type Tenant } from "../tenant";
import { appleReason, AppleReportError, createAppleReports, parseSalesReport } from "./apple";
import { bucketName, createPlayReports, googleReason } from "./google";
import { refreshing, refreshNumbers } from "./run";
import { numbersStoreFor } from "./store";
import { PERIODS, type Period } from "./types";
import { clearNumbersCache, numbersView } from "./view";

/**
 * The Numbers API, registered from api-server.ts with one line:
 *  - GET  /api/apps/:id/numbers?days=7|30|90   the page (from the cache and day2's own data)
 *  - POST /api/apps/:id/numbers/refresh        read the stores now (at most every 10 minutes per app)
 *  - PUT  /api/apps/:id/numbers/settings       Apple vendor number, Play reports bucket
 *  - POST /api/apps/:id/numbers/test/:store    connection test for "apple" or "google"
 */

type Handler = (req: Request, params: Record<string, string>, t: Tenant) => Promise<Response> | Response;
export type NumbersRouteContext = {
  route: (method: string, pathname: string, handler: Handler) => void;
  json: (data: unknown, init?: ResponseInit) => Response;
  httpError: (status: number, message: string) => Error;
  requireApp: (t: Tenant, id: string) => Promise<AppEntry>;
  requireManager: (t: Tenant) => void;
};

export const REFRESH_EVERY_MS = 10 * 60_000;
const limiter = createLimiter(10_000);
export const resetNumbersLimits = () => limiter.reset();

/** Pure. "?days=" → a period (30 when missing or not one of 7, 30, 90). */
export function periodParam(v: string | null): Period {
  const n = Number(v);
  return (PERIODS as readonly number[]).includes(n) ? (n as Period) : 30;
}

/** Pure. The vendor number as Apple shows it (digits), or null when cleared; throws on anything else. */
export function parseVendorNumber(v: unknown): string | null {
  if (v === null || v === "") return null;
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  if (!/^\d{5,12}$/.test(s)) throw new Error("The vendor number is the number shown in App Store Connect → Payments and Financial Reports (top left), digits only.");
  return s;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = (await req.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function registerNumbersRoutes(ctx: NumbersRouteContext): void {
  const { route, json, httpError, requireApp, requireManager } = ctx;

  const respond = async (app: AppEntry, days: Period) => {
    const view = await numbersView(app, days);
    const doc = await numbersStoreFor(app).load(app.id);
    const last = doc.refreshRequestedAt ? Date.parse(doc.refreshRequestedAt) : 0;
    return json({ ...view, refreshing: refreshing(app.id), refreshableAt: last ? new Date(last + REFRESH_EVERY_MS).toISOString() : null });
  };

  route("GET", "/api/apps/:id/numbers", async (req, p, t) => respond(await requireApp(t, p.id!), periodParam(new URL(req.url).searchParams.get("days"))));

  route("POST", "/api/apps/:id/numbers/refresh", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    const now = new Date();
    const doc = await numbersStoreFor(app).load(app.id);
    const last = doc.refreshRequestedAt ? Date.parse(doc.refreshRequestedAt) : 0;
    if (refreshing(app.id)) throw httpError(409, "day2 is already reading the stores for this app.");
    if (now.getTime() - last < REFRESH_EVERY_MS || !limiter.allow(`numbers:${app.id}`, 1, now.getTime(), REFRESH_EVERY_MS)) {
      const mins = Math.max(1, Math.ceil((last + REFRESH_EVERY_MS - now.getTime()) / 60_000));
      throw httpError(429, `The numbers were refreshed a moment ago — try again in ${mins} minute${mins === 1 ? "" : "s"}.`);
    }
    await numbersStoreFor(app).update(app.id, (d) => ({ doc: { ...d, refreshRequestedAt: now.toISOString() }, result: null }));
    void refreshNumbers(app, now).catch((err: Error) => console.error(`[day2-numbers] ${app.name}: ${err.message}`));
    clearNumbersCache(app.id);
    return json({ refreshing: true, refreshableAt: new Date(now.getTime() + REFRESH_EVERY_MS).toISOString() }, { status: 202 });
  });

  route("PUT", "/api/apps/:id/numbers/settings", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const b = await body(req);
    const patch: { appleVendorNumber?: string | null; playBucket?: string | null } = {};
    try {
      if ("appleVendorNumber" in b) patch.appleVendorNumber = parseVendorNumber(b.appleVendorNumber);
    } catch (err) {
      throw httpError(400, (err as Error).message);
    }
    if ("playBucket" in b) {
      if (b.playBucket === null || b.playBucket === "") patch.playBucket = null;
      else {
        const name = typeof b.playBucket === "string" ? bucketName(b.playBucket) : null;
        if (!name) throw httpError(400, "Paste the Cloud Storage URI from Play Console → Download reports (it starts with gs://pubsite_prod_).");
        patch.playBucket = name;
      }
    }
    await numbersStoreFor(app).update(app.id, (d) => ({ doc: { ...d, settings: { ...d.settings, ...patch } }, result: null }));
    clearNumbersCache(app.id);
    return respond(app, periodParam(new URL(req.url).searchParams.get("days")));
  });

  route("POST", "/api/apps/:id/numbers/test/:store", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    if (!limiter.allow(`numbers-test:${app.id}`, 6, Date.now())) throw httpError(429, "Too many tests in a row — wait a minute.");
    const doc = await numbersStoreFor(app).load(app.id);
    const ids = storeIdsFromRepo(app.repoPath);
    if (p.store === "apple") {
      const cred = await releaseCredentials().get(app.id, "asc");
      if (!cred) return json({ ok: false, message: "App Store Connect isn't connected — connect it on Connect your stores first." });
      if (!doc.settings.appleVendorNumber) return json({ ok: false, message: "Add the vendor number first." });
      const a = createAppleReports(cred.value);
      const day = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);
      try {
        const text = await a.salesDay(doc.settings.appleVendorNumber, day);
        const units = text ? parseSalesReport(text, doc.apple.appId).downloads : 0;
        return json({ ok: true, message: `Sales and Trends answered: ${units} download${units === 1 ? "" : "s"} on ${day}.` });
      } catch (err) {
        return json({ ok: false, message: err instanceof AppleReportError ? err.message : appleReason(undefined, (err as Error).message, "sales report") });
      }
    }
    if (p.store === "google") {
      const cred = await releaseCredentials().get(app.id, "play");
      if (!cred) return json({ ok: false, message: "Google Play isn't connected — connect it on Connect your stores first." });
      if (!doc.settings.playBucket) return json({ ok: false, message: "Add the Cloud Storage URI first." });
      if (!ids.packageName) return json({ ok: false, message: "day2 can't find the Android package name in app.json." });
      try {
        const files = await createPlayReports(cred.value).installReports(doc.settings.playBucket, ids.packageName);
        return json(
          files.length
            ? { ok: true, message: `The reports bucket answered: ${files.length} installs report${files.length === 1 ? "" : "s"} for ${ids.packageName}.` }
            : { ok: false, message: `The bucket answered but has no installs reports for ${ids.packageName} yet — Google writes the first one a day or two after the app's first installs.` },
        );
      } catch (err) {
        return json({ ok: false, message: googleReason(err, "installs") });
      }
    }
    throw httpError(404, "Unknown store.");
  });
}
