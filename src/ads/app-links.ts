import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ads for an app that lives in the App Store and Google Play (no website):
 * every ad links to day2's smart link, which sends the person to the right
 * store and carries the ad's tag as far as each store allows:
 *
 *  - Google Play: in the install referrer (`referrer=d2=B-4.tiktok.v1`), which
 *    the app reads on its first open (field library) → exact results per ad,
 *    through sign-up;
 *  - App Store: as an App Store campaign token (`ct=B-4.tiktok.v1`, with the
 *    owner's provider token `pt`), counted by Apple in App Analytics. Apple
 *    doesn't pass it to the app without tracking, so iPhone results are per
 *    platform (installs each platform reports, and Apple Search Ads' own).
 *
 * The smart link itself records the tap, per ad, on every device.
 */

export const APP_LINKS_FILENAME = "day2-app-links.json";

export type AppLinks = {
  ios: { bundleId: string; appStoreId: string | null; name: string | null; screenshots?: string[] } | null;
  android: { packageName: string } | null;
  /** App Store Connect → App Analytics → campaign links: the provider token (pt). Optional. */
  providerToken: string | null;
  checkedAt: string | null;
};

export function loadAppLinks(path: string): AppLinks {
  const empty: AppLinks = { ios: null, android: null, providerToken: null, checkedAt: null };
  if (!existsSync(path)) return empty;
  try {
    return { ...empty, ...(JSON.parse(readFileSync(path, "utf-8")) as Partial<AppLinks>) };
  } catch {
    return empty;
  }
}

export function saveAppLinks(path: string, l: AppLinks): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(l, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Pure enough: the app's store identifiers from app.json (Expo) or the native projects. */
export function storeIdsFromRepo(repoPath: string): { bundleId: string | null; packageName: string | null } {
  let bundleId: string | null = null;
  let packageName: string | null = null;
  try {
    const j = JSON.parse(readFileSync(join(repoPath, "app.json"), "utf-8")) as { expo?: Record<string, unknown> } & Record<string, unknown>;
    const expo = (j.expo ?? j) as { ios?: { bundleIdentifier?: string }; android?: { package?: string } };
    bundleId = expo.ios?.bundleIdentifier ?? null;
    packageName = expo.android?.package ?? null;
  } catch {
    // No app.json (or a dynamic app.config): try the config files' literals.
  }
  for (const f of ["app.config.ts", "app.config.js"]) {
    if (bundleId && packageName) break;
    const p = join(repoPath, f);
    if (!existsSync(p)) continue;
    const t = readFileSync(p, "utf-8");
    bundleId ??= t.match(/bundleIdentifier\s*:\s*["']([\w.-]+)["']/)?.[1] ?? null;
    packageName ??= t.match(/\bpackage\s*:\s*["']([\w.]+)["']/)?.[1] ?? null;
  }
  return { bundleId, packageName };
}

/** The App Store id (adamId) for a bundle id, from Apple's public lookup. */
export async function lookupAppStoreId(bundleId: string, doFetch: typeof fetch = fetch): Promise<{ appStoreId: string; name: string; screenshots: string[] } | null> {
  for (const country of ["us", "de", "gb"]) {
    try {
      const r = await doFetch(`https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}&country=${country}`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) continue;
      const j = (await r.json()) as { resultCount?: number; results?: Array<{ trackId?: number; trackName?: string; screenshotUrls?: string[] }> };
      const hit = j.results?.find((x) => x.trackId);
      if (hit) return { appStoreId: String(hit.trackId), name: hit.trackName ?? "", screenshots: (hit.screenshotUrls ?? []).filter((u) => /^https:\/\//.test(u)).slice(0, 6) };
    } catch {
      // Try the next storefront.
    }
  }
  return null;
}

/** Fills in what's missing (store ids from the repo, the App Store id from Apple), at most daily. */
export async function refreshAppLinks(repoPath: string, now: Date, doFetch: typeof fetch = fetch): Promise<AppLinks> {
  const path = join(repoPath, APP_LINKS_FILENAME);
  const l = loadAppLinks(path);
  if (l.checkedAt && now.getTime() - Date.parse(l.checkedAt) < 86_400_000 && (l.ios || l.android)) return l;
  const ids = storeIdsFromRepo(repoPath);
  // Google Play: only once the listing is public (the details page answers).
  if (ids.packageName) {
    const listed = await doFetch(`https://play.google.com/store/apps/details?id=${encodeURIComponent(ids.packageName)}&hl=en`, { method: "HEAD", signal: AbortSignal.timeout(10_000) })
      .then((r) => r.status !== 404)
      .catch(() => Boolean(l.android));
    l.android = listed ? { packageName: ids.packageName } : null;
  }
  if (ids.bundleId) {
    const found = await lookupAppStoreId(ids.bundleId, doFetch);
    l.ios = found ? { bundleId: ids.bundleId, appStoreId: found.appStoreId, name: found.name, screenshots: found.screenshots } : { bundleId: ids.bundleId, appStoreId: l.ios?.appStoreId ?? null, name: l.ios?.name ?? null, screenshots: l.ios?.screenshots ?? [] };
  }
  l.checkedAt = now.toISOString();
  saveAppLinks(path, l);
  return l;
}

export const hasStores = (l: AppLinks) => Boolean(l.android || l.ios?.appStoreId);

/** Pure. Store URLs carrying an ad's tag. */
export function storeUrl(store: "ios" | "android", l: AppLinks, tag: string): string | null {
  const t = tag.slice(0, 40);
  if (store === "android" && l.android) return `https://play.google.com/store/apps/details?id=${encodeURIComponent(l.android.packageName)}&referrer=${encodeURIComponent(`d2=${t}&utm_source=day2&utm_medium=paid&utm_campaign=${t}`)}`;
  if (store === "ios" && l.ios?.appStoreId) return `https://apps.apple.com/app/id${l.ios.appStoreId}?mt=8&ct=${encodeURIComponent(t)}${l.providerToken ? `&pt=${encodeURIComponent(l.providerToken)}` : ""}`;
  return null;
}

/** Pure. Which store a visitor's browser belongs to. */
export function storeFor(userAgent: string): "ios" | "android" | null {
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && /Mobile/i.test(userAgent))) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return null;
}

/** day2's smart link for an app (public): `?d2=` is added per ad like any tracked link. */
export const smartLink = (publicUrl: string, appId: string) => `${publicUrl.replace(/\/+$/, "")}/api/l/${encodeURIComponent(appId)}`;

/** Pure. The page for desktop visitors: both store badges, nothing else. */
export function storeChooserHtml(name: string, ios: string | null, android: string | null): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const a = (href: string, label: string) => `<a href="${esc(href)}" style="display:block;margin:12px auto;max-width:280px;padding:14px 18px;border-radius:14px;background:#111;color:#fff;text-decoration:none;font:600 16px system-ui">${label}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(name)}</title></head><body style="margin:0;padding:64px 16px;text-align:center;font:16px system-ui;background:#f6f6f4;color:#111"><h1 style="font:600 28px system-ui">${esc(name)}</h1><p>Get the app on your phone:</p>${ios ? a(ios, "Download on the App Store") : ""}${android ? a(android, "Get it on Google Play") : ""}</body></html>`;
}

/** The app's App Store screenshots as local files (its real screens), for ad images and Motion videos. */
export async function storeScreenshots(l: AppLinks, dir: string, doFetch: typeof fetch = fetch): Promise<string[]> {
  const { mkdirSync, writeFileSync: write } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (const [n, url] of (l.ios?.screenshots ?? []).entries()) {
    try {
      const r = await doFetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) continue;
      const f = join(dir, `store-${n}.${/\.png(\?|$)/i.test(url) ? "png" : "jpg"}`);
      write(f, Buffer.from(await r.arrayBuffer()));
      out.push(f);
    } catch {
      // Skip that one.
    }
  }
  return out;
}
