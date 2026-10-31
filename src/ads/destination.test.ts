import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { AppEntry } from "../apps-registry";
import { betTicket, type Bet } from "../growth-bets";
import { betTicketOpts, effectiveDestination, handoffJs, handoffKey, handoffPresent, handoffTicket } from "./destination";

const links = { ios: { bundleId: "de.x.dotty", appStoreId: "123", name: "Dotty" }, android: { packageName: "de.x.dotty" }, providerToken: null, checkedAt: null };

describe("where ads lead", () => {
  test("the owner's choice when it's possible, else what the app has (website first)", () => {
    expect(effectiveDestination("store", true, true)).toBe("store");
    expect(effectiveDestination("website", true, true)).toBe("website");
    expect(effectiveDestination(null, true, true)).toBe("website");
    expect(effectiveDestination("store", true, false)).toBe("website");
    expect(effectiveDestination("website", false, true)).toBe("store");
    expect(effectiveDestination(null, false, false)).toBeNull();
  });

  test("experiment tickets follow the destination", () => {
    const repo = mkdtempSync(join(tmpdir(), "day2-dest-"));
    const app: AppEntry = { id: "app_d", name: "Dotty", repoPath: repo, connectionMethod: "local_path", appBaseUrl: "https://dotty.example", addedAt: "2026-09-01T00:00:00Z" };
    const b = { id: "B-1", title: "Map", angle: "Friends on a map", audience: "", channel: "ads", metric: "activation", landingPath: "/go/map", ticketId: null, source: null, status: "building", createdAt: "", liveAt: null, stoppedAt: null } as unknown as Bet;
    expect(betTicketOpts(app, true)).toEqual({ storeApp: true, destination: "website" });
    expect(betTicket(b, betTicketOpts(app, true)).description).toContain("data-day2-store");
    expect(betTicket(b, betTicketOpts(app, true)).description).toContain('day2.cameFrom()?.experiment === "B-1"');
    writeFileSync(join(repo, "day2-ads.json"), JSON.stringify({ destination: "store" }));
    expect(betTicket(b, betTicketOpts(app, true)).title).toBe('Experiment B-1: the first minute for "Map"');
    expect(betTicket(b, betTicketOpts(app, false)).title).toBe('Experiment B-1: build the page for "Map"');
  });
});

describe("the website's handoff to the stores", () => {
  const app: AppEntry = { id: "app_d", name: "Dotty", repoPath: "/x", connectionMethod: "local_path", appBaseUrl: "https://dotty.example", addedAt: "" };

  test("the ticket: one script tag on every page, store badges marked for day2", () => {
    const t = handoffTicket(app, "https://day2.example", links);
    expect(t.description).toContain('<script src="https://day2.example/api/l/app_d/handoff.js" defer></script>');
    expect(t.description).toContain('<a data-day2-store href="https://day2.example/api/l/app_d">');
    expect(t.description).toContain("the App Store and Google Play");
    expect(t.source.key).toBe(handoffKey("https://day2.example"));
    expect(handoffPresent('<head><script src="https://day2.example/api/l/app_d/handoff.js" defer></script>', "https://day2.example", "app_d")).toBe(true);
    // A new day2 address needs the website changed again.
    expect(handoffPresent('<script src="https://old.example/api/l/app_d/handoff.js">', "https://day2.example", "app_d")).toBe(false);
  });

  const runScript = (url: string, ua: string, touch = 0, stored: string | null = null) => {
    const badges = [{ href: "x", setAttribute(_: string, v: string) { this.href = v; } }];
    const store = new Map<string, string>(stored ? [["day2-d2", stored]] : []);
    const loc = { search: new URL(url).search, replaced: null as string | null, replace(u: string) { this.replaced = u; } };
    runInNewContext(handoffJs("https://day2.example/api/l/app_d"), {
      location: loc,
      URLSearchParams,
      navigator: { userAgent: ua, maxTouchPoints: touch },
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
      document: { readyState: "complete", querySelectorAll: () => badges },
    });
    return { redirected: loc.replaced, badge: badges[0]!.href, stored: store.get("day2-d2") ?? null };
  };
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
  const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36";
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18 Safari/605.1.15";

  test("phones from an ad go straight on to the stores, with the ad's tag", () => {
    expect(runScript("https://dotty.example/go/map?d2=B-1.tiktok.v1", IPHONE).redirected).toBe("https://day2.example/api/l/app_d?d2=B-1.tiktok.v1");
    expect(runScript("https://dotty.example/?d2=B-1.meta.v2", ANDROID).redirected).toBe("https://day2.example/api/l/app_d?d2=B-1.meta.v2");
    // iPads present themselves as Macs, with touch.
    expect(runScript("https://dotty.example/?d2=B-1.meta", MAC, 5).redirected).toBe("https://day2.example/api/l/app_d?d2=B-1.meta");
  });

  test("computers and visitors not from an ad stay on the page; badges carry the tag", () => {
    const desk = runScript("https://dotty.example/go/map?d2=B-1.tiktok.v1", MAC);
    expect(desk.redirected).toBeNull();
    expect(desk.badge).toBe("https://day2.example/api/l/app_d?d2=B-1.tiktok.v1");
    const organic = runScript("https://dotty.example/", IPHONE);
    expect(organic).toEqual({ redirected: null, badge: "https://day2.example/api/l/app_d", stored: null });
    // Back on another page of the site in the same visit: the badge still carries the ad's tag.
    expect(runScript("https://dotty.example/help.html", IPHONE, 0, "B-1.tiktok.v1")).toMatchObject({ redirected: null, badge: "https://day2.example/api/l/app_d?d2=B-1.tiktok.v1" });
    // Tags are cleaned.
    expect(runScript("https://dotty.example/?d2=%3Cscript%3EB-1", ANDROID).redirected).toBe("https://day2.example/api/l/app_d?d2=scriptB-1");
  });
});
