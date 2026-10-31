import { describe, expect, test } from "bun:test";
import type { Ticket } from "./backlog";
import { INSTALL_KEY } from "./field-work";
import { IDENTIFY_KEY } from "./retention";
import { ATT_KEY, attTicket, changesFor, disclosure, practicesFrom, storeStatus, versionOf, type Practices, type StorePrivacyFile } from "./store-privacy";

/** What the owner has to change in App Store Connect and the Play Console when day2 adds something to a mobile app. */

const ticket = (key: string, state: Ticket["state"] = "done") => ({ id: key, state, source: { kind: "day2_proposal", key } }) as unknown as Ticket;
const off: Practices = { fieldChecks: false, identify: false, treatments: false, deviceId: false, adConversions: false };
const installed: Practices = { ...off, fieldChecks: true, identify: true };
const file = (over: Partial<StorePrivacyFile> = {}): StorePrivacyFile => ({ settings: { adConversions: "off", deviceId: false }, confirmed: {}, ...over });

describe("what's in the app", () => {
  test("from merged day2 work and the owner's settings — not from what's merely planned", () => {
    expect(practicesFrom([ticket(INSTALL_KEY, "todo")], file().settings)).toEqual(off);
    expect(practicesFrom([ticket(INSTALL_KEY)], file().settings)).toEqual(installed);
    expect(practicesFrom([ticket(IDENTIFY_KEY)], file().settings)).toMatchObject({ fieldChecks: false, identify: true });
    expect(practicesFrom([ticket(INSTALL_KEY), ticket("retention:new-invite"), ticket("retention:undo:x")], file().settings).treatments).toBe(true);
    // Ad conversions count only once the tracking prompt is in the app.
    const withAds = { adConversions: "with_consent" as const, deviceId: false };
    expect(practicesFrom([ticket(INSTALL_KEY)], withAds).adConversions).toBe(false);
    expect(practicesFrom([ticket(INSTALL_KEY), ticket(ATT_KEY)], withAds).adConversions).toBe(true);
  });
});

describe("App Store privacy answers", () => {
  const now: Practices = { ...installed, treatments: true };

  test("field checks, identify and treatments: usage data linked, diagnostics not, user id — no tracking", () => {
    expect(changesFor("ios", null, now)).toEqual([
      "Add Usage Data → Product Interaction (screens, taps, sign-ups and first use). Purposes: Analytics, App Functionality and Product Personalization. Linked to the user: Yes. Used to track you: No.",
      "Add Diagnostics → Crash Data (crashes and errors). Purposes: App Functionality and Analytics. Linked to the user: No. Used to track you: No.",
      "Add Diagnostics → Performance Data (freezes and loading times). Purposes: App Functionality and Analytics. Linked to the user: No. Used to track you: No.",
      "Add Diagnostics → Other Diagnostic Data (failed checks and device details). Purposes: App Functionality and Analytics. Linked to the user: No. Used to track you: No.",
      "Add Identifiers → User ID (a salted hash of the app's user id). Purposes: Analytics and Product Personalization. Linked to the user: Yes. Used to track you: No.",
    ]);
  });

  test("a fixed device id adds Device ID", () => {
    expect(changesFor("ios", now, { ...now, deviceId: true })).toEqual([
      "Add Identifiers → Device ID (a random id kept on the device, not the advertising id). Purposes: Analytics. Linked to the user: Yes. Used to track you: No.",
    ]);
  });

  test("ad conversions are tracking: advertising data, 'used to track you', and the ATT prompt", () => {
    const steps = changesFor("ios", now, { ...now, adConversions: true });
    expect(steps).toContain("Usage Data → Product Interaction: add the purpose Developer's Advertising or Marketing.");
    expect(steps).toContain("Usage Data → Product Interaction: Used to track you → Yes.");
    expect(steps).toContain("Identifiers → User ID: Used to track you → Yes.");
    expect(steps).toContain("Add Usage Data → Advertising Data (which ad brought the user: the ad platform's click id, sent back to that platform). Purposes: Developer's Advertising or Marketing. Linked to the user: Yes. Used to track you: Yes.");
    expect(steps.at(-1)).toContain('"Data Used to Track You"');
    expect(disclosure({ ...now, adConversions: true }).ios.trackingPrompt).toBe(true);
  });
});

describe("Google Play Data safety answers", () => {
  test("collected, not shared — until ad conversions share with the ad platforms", () => {
    const now: Practices = { ...installed, treatments: true };
    const first = changesFor("android", null, now);
    expect(first[0]).toBe("Add App activity → App interactions (screens, taps, sign-ups and first use): collected, not shared. Purposes: Analytics, App functionality and Personalization.");
    expect(first).toContain("Add Personal info → User IDs (a salted hash of the app's user id): collected, not shared. Purposes: Analytics and Personalization.");
    expect(first.at(-1)).toBe("Data encrypted in transit: Yes (day2 sends over HTTPS).");
    const ads = changesFor("android", now, { ...now, adConversions: true });
    expect(ads).toContain("App activity → App interactions: mark it as shared (with the ad platforms).");
    expect(ads).toContain("Personal info → User IDs: add the purpose Advertising or marketing.");
  });
});

describe("asking again when something changes", () => {
  test("up to date after confirming; a change in the app makes it due again with just the difference", () => {
    expect(storeStatus(file(), off).every((s) => s.upToDate)).toBe(true); // nothing to declare yet
    const due = storeStatus(file(), installed);
    expect(due.map((s) => [s.store, s.upToDate, s.steps.length > 0])).toEqual([["ios", false, true], ["android", false, true]]);
    const ios = due.find((s) => s.store === "ios")!;
    const confirmed = file({ confirmed: { ios: { version: ios.version, practices: installed, at: "2026-10-31T10:00:00Z", by: "Pablo" } } });
    expect(storeStatus(confirmed, installed).find((s) => s.store === "ios")).toMatchObject({ upToDate: true, steps: [], confirmedBy: "Pablo" });
    const later = storeStatus(confirmed, { ...installed, treatments: true }).find((s) => s.store === "ios")!;
    expect(later.upToDate).toBe(false);
    expect(later.steps).toEqual(["Usage Data → Product Interaction: add the purpose Product Personalization.", "Identifiers → User ID: add the purpose Product Personalization."]);
  });
  test("the version only moves when the answers do", () => {
    expect(versionOf(disclosure(installed).ios)).toBe(versionOf(disclosure({ ...installed }).ios));
    expect(versionOf(disclosure(installed).ios)).not.toBe(versionOf(disclosure({ ...installed, deviceId: true }).ios));
  });
  test("the code change for ad conversions asks first", () => {
    const t = attTicket();
    expect(t.description).toContain('adClickIds: "after_consent"');
    expect(t.description).toContain("day2.allowAdTracking()");
    expect(t.doneWhen).toContain("NSUserTrackingUsageDescription is set");
  });
});
