import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { choices, chooseAccount, chooseIdentity, finishConnect, recheckIdentities, startConnect, type FlowDeps } from "./connect-flow";
import type { PlatformConnect } from "./connect/types";
import { fileConnections } from "./connections";
import { filePlatformIdentities } from "./identities";
import { CONNECTS, MODULES, resolvePlatforms } from "./registry";
import type { AdPlatform } from "./types";

/** One-click connecting, end to end, with a fake LinkedIn (a platform whose ads show as the app's own page). */

const root = mkdtempSync(join(tmpdir(), "day2-connect-"));
const realConnect = CONNECTS.linkedin;
const realModule = MODULES.linkedin;
const prevKey = process.env.DAY2_SECRETS_KEY;
let pageApproved = false;
let canSpend = true;

const fakeConnect: PlatformConnect = {
  platform: "linkedin",
  appEnv: ["LI_ID", "LI_SECRET"],
  appCredentials: (env) => (env.LI_ID && env.LI_SECRET ? { id: env.LI_ID, secret: env.LI_SECRET } : null),
  async authorizeUrl(_app, o) {
    return { url: `https://linkedin.example/oauth?state=${o.state}&redirect_uri=${encodeURIComponent(o.redirectUri)}&purpose=${o.purpose}` };
  },
  async exchange(_app, o) {
    if (o.query.code !== "good") throw new Error("bad code");
    return { accessToken: `tok-${o.query.who ?? "owner"}`, refreshToken: "r1" };
  },
  async listAdAccounts() {
    return [
      { id: "508", name: "Buddy Ads", currency: "EUR", canSpend: true },
      { id: "509", name: "Old account", currency: "USD", canSpend: false, problem: "billing isn't set up" },
    ];
  },
  async listIdentities() {
    return [{ ref: "urn:li:organization:42", name: "Buddy", kind: "company page" }];
  },
  async grantIdentity() {
    return { status: "pending", todo: "A super admin of Buddy approves day2's role in Page admin → Manage admins." };
  },
  credentials: (_app, tokens, adAccountId) => ({ tokens, adAccountId }),
};

const fakeAdapter = (creds: { tokens: { accessToken: string }; adAccountId: string }) =>
  ({
    async accountInfo() {
      return { id: creds.adAccountId, name: "x", currency: "EUR", canSpend, ...(canSpend ? {} : { problem: "payment method declined" }) };
    },
    async checkIdentity() {
      return pageApproved ? { ok: true as const } : { ok: false as const, problem: "role not approved yet" };
    },
  }) as unknown as AdPlatform;

const env = { LI_ID: "id", LI_SECRET: "s" };
let d: FlowDeps;
const CALLBACK = "https://day2.example/api/ads/connect/callback/linkedin";

beforeAll(() => {
  process.env.DAY2_SECRETS_KEY = randomBytes(32).toString("base64");
  Object.assign(CONNECTS, { linkedin: fakeConnect });
  Object.assign(MODULES, { linkedin: { ...realModule, create: fakeAdapter } });
  d = { store: fileConnections(join(root, "conn.json")), identities: filePlatformIdentities(join(root, "ids.json")), env };
});
afterAll(() => {
  Object.assign(CONNECTS, { linkedin: realConnect });
  Object.assign(MODULES, { linkedin: realModule });
  if (prevKey === undefined) delete process.env.DAY2_SECRETS_KEY;
  else process.env.DAY2_SECRETS_KEY = prevKey;
  rmSync(root, { recursive: true, force: true });
});

const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

describe("connecting an ad account", () => {
  test("without day2's developer app keys, it says which are missing", async () => {
    await expect(startConnect({ ...d, env: {} }, { platform: "linkedin", scope: "day2", purpose: "account", appId: null, by: "op", callbackUrl: CALLBACK })).rejects.toThrow("LI_ID, LI_SECRET");
  });

  test("day2's own account: sign in, pick an account that can spend, tokens stored encrypted", async () => {
    const { url } = await startConnect(d, { platform: "linkedin", scope: "day2", purpose: "account", appId: null, by: "op", callbackUrl: CALLBACK });
    expect(url).toContain("purpose=account");
    await expect(finishConnect(d, { platform: "linkedin", query: { state: "forged", code: "good" }, callbackUrl: CALLBACK })).rejects.toThrow("expired");
    const back = await finishConnect(d, { platform: "linkedin", query: { state: stateOf(url), code: "good", who: "day2" }, callbackUrl: CALLBACK });
    expect(back.scope).toBe("day2");
    const c = await choices(d, back.pendingId, null);
    expect(c.accounts.map((a) => a.id)).toEqual(["508", "509"]);
    expect(c.identities).toEqual([]); // day2's own connection doesn't pick a page
    await expect(chooseAccount(d, back.pendingId, null, "509", "op")).rejects.toThrow("billing isn't set up");
    const r = await chooseAccount(d, back.pendingId, null, "508", "op");
    expect(r).toEqual({ accountName: "Buddy Ads", currency: "EUR", nextIdentity: false });
    expect(readFileSync(join(root, "conn.json"), "utf-8")).not.toContain("tok-day2");
    expect((await d.store.get("day2", "linkedin"))!.tokens.accessToken).toBe("tok-day2");
    expect(await d.store.pending(back.pendingId)).toBeNull();
  });

  test("an account that the platform says can't spend is not kept", async () => {
    canSpend = false;
    const { url } = await startConnect(d, { platform: "linkedin", scope: { appId: "app_1" }, purpose: "account", appId: "app_1", by: "ana", callbackUrl: CALLBACK });
    const back = await finishConnect(d, { platform: "linkedin", query: { state: stateOf(url), code: "good" }, callbackUrl: CALLBACK });
    await expect(chooseAccount(d, back.pendingId, "app_1", "508", "ana")).rejects.toThrow("payment method declined");
    expect(await d.store.get({ appId: "app_1" }, "linkedin")).toBeNull();
    canSpend = true;
  });

  test("another app can't use someone else's half-done connection", async () => {
    const { url } = await startConnect(d, { platform: "linkedin", scope: { appId: "app_1" }, purpose: "identity", appId: "app_1", by: "ana", callbackUrl: CALLBACK });
    const back = await finishConnect(d, { platform: "linkedin", query: { state: stateOf(url), code: "good" }, callbackUrl: CALLBACK });
    await expect(choices(d, back.pendingId, "app_other")).rejects.toThrow("expired");
  });

  test("the app's page with day2's account: access requested, pending until the owner approves, then ready", async () => {
    const { url } = await startConnect(d, { platform: "linkedin", scope: { appId: "app_1" }, purpose: "identity", appId: "app_1", by: "ana", callbackUrl: CALLBACK });
    const back = await finishConnect(d, { platform: "linkedin", query: { state: stateOf(url), code: "good" }, callbackUrl: CALLBACK });
    const c = await choices(d, back.pendingId, "app_1");
    expect(c.identities.map((i) => i.name)).toEqual(["Buddy"]);
    const r = await chooseIdentity(d, back.pendingId, "app_1", "urn:li:organization:42", "ana");
    expect(r.status).toBe("pending");
    expect(r.todo).toContain("super admin");
    expect(await recheckIdentities(d, "app_1")).toEqual([]);
    pageApproved = true;
    expect(await recheckIdentities(d, "app_1")).toEqual(["linkedin"]);
    expect((await d.identities.forApp("app_1")).find((i) => i.platform === "linkedin")).toMatchObject({ status: "ready", todo: null });
  });

  test("the app's own account wins over day2's, and isn't billed in credits", async () => {
    const before = await resolvePlatforms("app_1", d.store, env);
    expect(before.get("linkedin")).toMatchObject({ source: "day2", billing: "credits", currency: "EUR" });
    const { url } = await startConnect(d, { platform: "linkedin", scope: { appId: "app_1" }, purpose: "account", appId: "app_1", by: "ana", callbackUrl: CALLBACK });
    const back = await finishConnect(d, { platform: "linkedin", query: { state: stateOf(url), code: "good" }, callbackUrl: CALLBACK });
    const r = await chooseAccount(d, back.pendingId, "app_1", "508", "ana");
    expect(r.nextIdentity).toBe(true); // the same sign-in goes on to pick the page
    const after = await resolvePlatforms("app_1", d.store, env);
    expect(after.get("linkedin")).toMatchObject({ source: "app", billing: "own", accountName: "Buddy Ads" });
    // Another app still uses day2's.
    expect((await resolvePlatforms("app_2", d.store, env)).get("linkedin")).toMatchObject({ source: "day2" });
  });
});
