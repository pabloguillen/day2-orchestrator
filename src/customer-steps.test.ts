import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { withDay2Env } from "./field-turn-on";
import { checkAsc, checkPlay } from "./mobile-release/check-access";
import { changesFor, disclosure, practicesFrom } from "./store-privacy";
import { walkthrough } from "./store-walkthrough";

/** What app owners still do themselves, made as small as it can be. */

describe("day2 turns itself on in release builds (a pull request on eas.json)", () => {
  test("the two settings go into the production profile; the rest stays", () => {
    const next = JSON.parse(withDay2Env(JSON.stringify({ cli: { appVersionSource: "remote" }, build: { production: { autoIncrement: true } } }), "EXPO_PUBLIC_DAY2_KEY", "EXPO_PUBLIC_DAY2_ENDPOINT", "d2k_x", "https://app.example.com")!);
    expect(next.build.production).toEqual({ autoIncrement: true, env: { EXPO_PUBLIC_DAY2_KEY: "d2k_x", EXPO_PUBLIC_DAY2_ENDPOINT: "https://app.example.com" } });
    expect(next.cli).toEqual({ appVersionSource: "remote" });
    expect(withDay2Env(JSON.stringify(next), "EXPO_PUBLIC_DAY2_KEY", "EXPO_PUBLIC_DAY2_ENDPOINT", "d2k_x", "https://app.example.com")).toBeNull();
    expect(JSON.parse(withDay2Env("{}", "DAY2_KEY", null, "d2k_y", "x")!).build.production.env).toEqual({ DAY2_KEY: "d2k_y" });
  });
});

describe("store privacy answers: day2 in the app by hand counts", () => {
  test("wired in by hand (with identify): usage, diagnostics and the user id need answering", () => {
    const p = practicesFrom([], { adConversions: "off", deviceId: false }, { identify: true });
    expect(p).toMatchObject({ fieldChecks: true, identify: true, adConversions: false });
    expect(disclosure(p).ios.rows.map((r) => r.type)).toEqual(["Product Interaction", "Crash Data", "Performance Data", "Other Diagnostic Data", "User ID"]);
    expect(practicesFrom([], { adConversions: "off", deviceId: false }).fieldChecks).toBe(false);
  });

  test("“do it with me”: where to click, each change, then publish", () => {
    const changes = changesFor("ios", null, practicesFrom([], { adConversions: "off", deviceId: false }, { identify: false }));
    const ios = walkthrough("ios", changes, { appName: "Dotty", appStoreId: "6751234567" });
    expect(ios[0]).toMatchObject({ title: "Open App Privacy", link: { url: "https://appstoreconnect.apple.com/apps/6751234567/distribution/privacy" } });
    expect(ios.at(-1)!.title).toBe("Publish");
    expect(ios.filter((s) => s.title.startsWith("Change ")).length).toBe(changes.length);
    expect(ios[2]!.detail).toContain("Product Interaction");
    const play = walkthrough("android", changesFor("android", null, practicesFrom([], { adConversions: "off", deviceId: false }, { identify: false })), { appName: "Dotty", appStoreId: null });
    expect(play[1]!.detail).toContain("encrypted in transit? Yes");
    expect(play.at(-1)!.title).toBe("Save and submit");
    expect(walkthrough("ios", [], { appName: "Dotty", appStoreId: null })).toEqual([]);
  });
});

describe("connecting the stores: only what works is kept, and a mistake says what to fix", () => {
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const asc = { issuerId: "69a6de7e-1111-47e3-e053-5b8c7c11a4d1", keyId: "2X9R4HXF34", privateKey: ec };
  const play = { clientEmail: "day2@proj.iam.gserviceaccount.com", privateKey: rsa };
  const respond = (fn: (url: string, init?: RequestInit) => Response) => (async (u: string | URL | Request, init?: RequestInit) => fn(String(u), init)) as typeof fetch;

  test("App Store Connect: wrong ids, wrong role, wrong team, works", async () => {
    expect(await checkAsc(asc, "de.x.dotty", respond(() => new Response("{}", { status: 401 })))).toMatchObject({ ok: false, why: expect.stringContaining("issuer id") });
    expect(await checkAsc(asc, "de.x.dotty", respond(() => new Response("{}", { status: 403 })))).toMatchObject({ ok: false, why: expect.stringContaining("App Manager") });
    expect(await checkAsc(asc, "de.x.dotty", respond(() => Response.json({ data: [] })))).toMatchObject({ ok: false, why: expect.stringContaining("no app with the bundle id de.x.dotty") });
    let url = "";
    const ok = await checkAsc(asc, "de.x.dotty", respond((u) => ((url = u), Response.json({ data: [{ attributes: { name: "Dotty" } }] }))));
    expect(ok).toEqual({ ok: true, who: "App Store Connect: Dotty" });
    expect(url).toBe("https://api.appstoreconnect.apple.com/v1/apps?filter[bundleId]=de.x.dotty&limit=1");
  });

  test("Google Play: API off, not invited, works (and the trial edit is thrown away)", async () => {
    const token = (u: string) => (u.includes("oauth2") ? Response.json({ access_token: "t" }) : null);
    expect(await checkPlay(play, "de.x.dotty", respond((u) => token(u) ?? new Response("Google Play Android Developer API has not been used in project", { status: 403 })))).toMatchObject({ ok: false, why: expect.stringContaining("Turn on the Google Play Android Developer API") });
    expect(await checkPlay(play, "de.x.dotty", respond((u) => token(u) ?? new Response("The caller does not have permission", { status: 403 })))).toMatchObject({ ok: false, why: expect.stringContaining("invite day2@proj.iam.gserviceaccount.com") });
    const calls: string[] = [];
    const ok = await checkPlay(play, "de.x.dotty", respond((u, init) => (calls.push(`${init?.method ?? "GET"} ${u}`), token(u) ?? Response.json({ id: "e1" }))));
    expect(ok).toEqual({ ok: true, who: "Google Play: de.x.dotty" });
    expect(calls.at(-1)).toBe("DELETE https://androidpublisher.googleapis.com/androidpublisher/v3/applications/de.x.dotty/edits/e1");
  });
});
