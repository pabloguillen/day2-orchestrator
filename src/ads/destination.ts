import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import type { NewTicketInput } from "../backlog";
import { APP_LINKS_FILENAME, hasStores, loadAppLinks, smartLink, type AppLinks } from "./app-links";

/**
 * Where an app's ads lead, when it has both a website and store listings —
 * the owner's choice:
 *
 *  - "website": to a page on the app's website (one per experiment). Phones
 *    that arrive from an ad go straight on to the App Store / Google Play
 *    (day2's handoff script, added to the website once); computers see the
 *    page with store badges. The ad's tag travels along to the store.
 *  - "store": straight to the App Store / Google Play through day2's smart
 *    link — one step fewer.
 *
 * Apps with only one of the two use that one. Running ads keep the link they
 * were launched with; the choice applies to new ads.
 */

export type Destination = "website" | "store";

/** Pure. The destination in effect, or null when the app has neither. */
export function effectiveDestination(choice: Destination | null | undefined, hasWebsite: boolean, storeApp: boolean): Destination | null {
  if (choice === "store" && storeApp) return "store";
  if (choice === "website" && hasWebsite) return "website";
  if (hasWebsite) return "website";
  return storeApp ? "store" : null;
}

/** The app's store presence and destination without network calls (what day2 last learned). */
export function destinationFor(app: AppEntry, choice: Destination | null | undefined): { storeApp: boolean; links: AppLinks; destination: Destination | null } {
  const links = loadAppLinks(join(app.repoPath, APP_LINKS_FILENAME));
  const storeApp = hasStores(links);
  return { storeApp, links, destination: effectiveDestination(choice, Boolean(app.appBaseUrl), storeApp) };
}

export const handoffScriptUrl = (publicUrl: string, appId: string) => `${smartLink(publicUrl, appId)}/handoff.js`;

/** Pure. Whether a page of the website carries day2's handoff script (from this day2's address). */
export function handoffPresent(html: string, publicUrl: string, appId: string): boolean {
  return html.includes(handoffScriptUrl(publicUrl, appId));
}

/** Fetches a page of the website and checks for the handoff script. */
export async function checkHandoff(pageUrl: string, publicUrl: string, appId: string, doFetch: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await doFetch(pageUrl, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "day2-check/1 (desktop)" } });
    return r.ok && handoffPresent(await r.text(), publicUrl, appId);
  } catch {
    return false;
  }
}

/**
 * Pure. The handoff script the website loads. A visitor from an ad (?d2= in
 * the address) on a phone goes straight to the right store with the ad's
 * tag; everyone else stays on the page, and store badges marked
 * `data-day2-store` point at day2's smart link (with the tag, if any).
 */
export function handoffJs(link: string): string {
  return `/* day2: website → App Store / Google Play */
(function () {
  var L = ${JSON.stringify(link)};
  var q = new URLSearchParams(location.search);
  var fromAd = (q.get("d2") || "").replace(/[^\\w.-]/g, "").slice(0, 40);
  var t = fromAd;
  try {
    if (t) sessionStorage.setItem("day2-d2", t);
    else t = sessionStorage.getItem("day2-d2") || "";
  } catch (e) {}
  var href = L + (t ? "?d2=" + encodeURIComponent(t) : "");
  var ua = navigator.userAgent;
  var phone = /iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (fromAd && phone) {
    location.replace(href);
    return;
  }
  function wire() {
    var a = document.querySelectorAll("a[data-day2-store]");
    for (var i = 0; i < a.length; i++) a[i].setAttribute("href", href);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
`;
}

export const handoffKey = (publicUrl: string) => `ads:website-handoff:${new URL(publicUrl).host}`;

/** The one-time ticket that adds the handoff to the app's website (in its repo). */
export function handoffTicket(app: AppEntry, publicUrl: string, links: AppLinks): NewTicketInput {
  const script = handoffScriptUrl(publicUrl, app.id);
  const link = smartLink(publicUrl, app.id);
  const stores = [links.ios?.appStoreId ? "the App Store" : null, links.android ? "Google Play" : null].filter(Boolean).join(" and ");
  return {
    title: "Website: send people from ads on to the App Store / Google Play",
    type: "task",
    description: [
      `The owner chose to run ads to the app's website (${app.appBaseUrl}). People on a phone who arrive from an ad should go straight on to ${stores}; people on a computer see the page with store badges. day2 does the redirect with a small script — the website only has to load it and mark its store badges.`,
      "",
      "In the website's code (in this repo):",
      `1. In the <head> of every page — including the experiment pages under /go/ and any page template — add exactly: <script src="${script}" defer></script>`,
      `2. Where the page invites people to get the app (e.g. a "coming soon" note), show the official badges for ${stores}, each as a link: <a data-day2-store href="${link}">…badge…</a>. The script points them at the right store and carries the ad's tag. Use the official badge artwork (Apple's "Download on the App Store", Google's "Get it on Google Play"), in the page's language.`,
      "3. Change nothing else on the website. No other scripts or trackers.",
      "",
      "Once the website is deployed with this, day2 sees the script on the live pages and starts the ads.",
    ].join("\n"),
    doneWhen: ["Every page of the website loads day2's handoff script", `The pages show ${stores} badges marked data-day2-store`, "Nothing else on the website changes"],
    priority: 2,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: handoffKey(publicUrl) },
    actor: "day2",
    createdNote: "The owner chose to run the app's ads to its website.",
  };
}

/** What an experiment's ticket needs to know (growth-bets.ts betTicket): a mobile app, and where its ads lead. */
export function betTicketOpts(app: AppEntry, mobileApp: boolean): { storeApp: boolean; destination: Destination | null } {
  if (!mobileApp) return { storeApp: false, destination: app.appBaseUrl ? "website" : null };
  let choice: Destination | null = null;
  try {
    const d = (JSON.parse(readFileSync(join(app.repoPath, "day2-ads.json"), "utf-8")) as { destination?: unknown }).destination;
    if (d === "website" || d === "store") choice = d;
  } catch {
    // No ads file yet: day2's default.
  }
  return { storeApp: true, destination: effectiveDestination(choice, Boolean(app.appBaseUrl), true) };
}
