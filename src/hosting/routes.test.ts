import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { isAgentBackedPath } from "../api-server";
import { createTestDatabase } from "../db/test-db";
import { practicesFrom, disclosure, changesFor } from "../store-privacy";
import { noticeSection } from "../privacy-notice";
import type { Tenant } from "../tenant";
import { registeredNeeds } from "../live/native-foundations";
import { ensureHosting } from "./index";
import { hostingPrivacy } from "./privacy";
import { hostingRoutes } from "./routes";
import { dbHostingSecrets, dbHostingStore } from "./store";
import { makeKit, makeRepo, PLAN, type Kit } from "./test-kit";

class Fail extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const prevKey = process.env.DAY2_SECRETS_KEY;
beforeAll(() => {
  process.env.DAY2_SECRETS_KEY = randomBytes(32).toString("base64");
});
afterAll(() => {
  if (prevKey === undefined) delete process.env.DAY2_SECRETS_KEY;
  else process.env.DAY2_SECRETS_KEY = prevKey;
});

function caller(k: Kit, o: { manager?: boolean } = {}) {
  const routes = hostingRoutes({
    requireApp: async (_t, id) => {
      if (id !== k.app.id) throw new Fail(404, "No app");
      return k.app;
    },
    requireManager: () => {
      if (o.manager === false) throw new Fail(403, "Only the account's owners and admins can do this.");
    },
    fail: (s, m) => new Fail(s, m),
    actorName: async () => "Pablo",
    deps: () => k.deps,
    store: () => k.deps.store,
  });
  return async (method: string, path: string, body?: unknown) => {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = new URLPattern({ pathname: r.path }).exec(`http://x${path}`);
      if (!m) continue;
      const params = Object.fromEntries(Object.entries(m.pathname.groups).filter(([, v]) => v !== undefined)) as Record<string, string>;
      try {
        const res = await r.handler(new Request(`http://x${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), params, {} as Tenant);
        return { status: res.status, body: (await res.json()) as Record<string, any>, text: "" };
      } catch (err) {
        if (err instanceof Fail) return { status: err.status, body: { error: err.message } as Record<string, any> };
        throw err;
      }
    }
    return { status: 404, body: {} as Record<string, any> };
  };
}

const settle = async (k: Kit) => {
  for (let i = 0; i < 50; i++) {
    const s = await k.deps.store.state(k.app.id);
    if (!s.working && (s.done.production?.length ?? 0) === 10) return;
    await Bun.sleep(20);
  }
};

describe("hosting API", () => {
  test("Host with day2 starts setup; the page shows status, region, usage in credits and only the publishable key", async () => {
    const k = makeKit();
    const call = caller(k);
    const off = await call("GET", `/api/apps/${k.app.id}/hosting`);
    expect(off.body).toMatchObject({ available: true, enabled: false, status: "off", eligible: { eligible: true, why: "create" } });
    const started = await call("POST", `/api/apps/${k.app.id}/hosting`, { countries: ["DE"], language: "de" });
    expect(started.status).toBe(202);
    expect(started.body.enabled).toBe(true);
    await settle(k);
    const v = await call("GET", `/api/apps/${k.app.id}/hosting`);
    expect(v.body.status).toBe("ready");
    expect(v.body.region).toEqual({ code: "eu-central-1", place: "Frankfurt, Germany (EU)", eu: true });
    expect(v.body.keys.publishableKey).toMatch(/^sb_publishable_/);
    expect(v.body.steps.every((s: { done: boolean }) => s.done)).toBe(true);
    expect(v.body.signIn).toMatchObject({ siteUrl: "habitloop://", emailSender: "day2", emailLanguage: "de" });
    expect(v.body.backendTicket).toBeNull(); // the kit's tickets aren't in a backlog file
    const text = JSON.stringify(v.body);
    expect(text).not.toContain("sb_secret_");
    expect(text).not.toContain("TOPSECRET");
    expect(text).not.toContain("costUsd");
    expect(text).not.toContain("markup");
    // From the console the build agent gets eas.json as a ticket (not a direct edit).
    expect(k.tickets.some((t) => t.source.key === "hosting:app-config")).toBe(true);
  });

  test("Apple sign-in: tested, stored encrypted, pushed to Supabase; a failed test says why", async () => {
    const k = makeKit();
    await ensureHosting(k.app, PLAN, { deps: k.deps });
    const call = caller(k);
    const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const apple = { teamId: "ABCDE12345", keyId: "KEY1234567", privateKey: pem, servicesId: "com.habitloop.signin" };
    k.deps.fetch = (async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 400 })) as unknown as typeof fetch;
    const bad = await call("PUT", `/api/apps/${k.app.id}/hosting/sign-in/apple`, apple);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("Apple didn't accept");
    k.deps.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as unknown as typeof fetch;
    const ok = await call("PUT", `/api/apps/${k.app.id}/hosting/sign-in/apple`, apple);
    expect(ok.status).toBe(200);
    expect(ok.body.signIn.apple).toMatchObject({ state: "connected", label: "Apple key KEY1234567", stored: true });
    expect(JSON.stringify(ok.body)).not.toContain("BEGIN PRIVATE KEY");
    const ref = (await k.deps.store.state(k.app.id)).projects.production!.ref;
    expect(k.fake.auth.get(ref)).toMatchObject({ external_apple_enabled: true, external_apple_client_id: "com.habitloop.signin,com.habitloop" });
    expect(String(k.fake.auth.get(ref)!.external_apple_secret).split(".")).toHaveLength(3);
    const off = await call("DELETE", `/api/apps/${k.app.id}/hosting/sign-in/apple`);
    expect(off.body.signIn.apple).toMatchObject({ state: "off", stored: false });
    expect(k.fake.auth.get(ref)!.external_apple_enabled).toBe(false);
  });

  test("function secrets: set by name, never shown again; members can't manage keys", async () => {
    const k = makeKit();
    await ensureHosting(k.app, PLAN, { deps: k.deps });
    const r = await caller(k)("POST", `/api/apps/${k.app.id}/hosting/secrets`, { name: "OPENAI_KEY", value: "sk-very-secret" });
    expect(r.body.usage.functions.secretNames).toEqual(["OPENAI_KEY"]);
    expect(JSON.stringify(r.body)).not.toContain("sk-very-secret");
    expect(r.body.problem).toBeNull();
    expect((await caller(k)("POST", `/api/apps/${k.app.id}/hosting/secrets`, { name: "SUPABASE_X", value: "v" })).status).toBe(400);
    expect((await caller(k, { manager: false })("PUT", `/api/apps/${k.app.id}/hosting/email`, { sender: "day2" })).status).toBe(403);
  });

  test("apps with their own backend aren't offered hosting", async () => {
    const repo = makeRepo({ files: { "package.json": JSON.stringify({ dependencies: { expo: "54", "@supabase/supabase-js": "2" } }) } });
    rmSync(join(repo, "src", "backend"), { recursive: true });
    const k = makeKit({ repo });
    const call = caller(k);
    expect((await call("GET", `/api/apps/${k.app.id}/hosting`)).body.eligible).toEqual({ eligible: false, why: "own_backend", backend: "its own Supabase project" });
    const r = await call("POST", `/api/apps/${k.app.id}/hosting`, {});
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("doesn't move existing backends");
  });

  test("without operator setup the page says so", async () => {
    const k = makeKit({ operator: null });
    const call = caller(k);
    expect((await call("GET", `/api/apps/${k.app.id}/hosting`)).body).toMatchObject({ available: false, unavailableReason: expect.stringContaining("isn't set up") });
    expect((await call("POST", `/api/apps/${k.app.id}/hosting`, {})).status).toBe(503);
  });

  test("hosting routes aren't agent-backed; the native needs follow the plan", async () => {
    expect(isAgentBackedPath("/api/apps/a/hosting")).toBe(false);
    const k = makeKit();
    caller(k);
    await ensureHosting(k.app, PLAN, { deps: k.deps });
    const mods = [];
    for (const n of registeredNeeds().filter((x) => x.module.startsWith("hosting"))) if (await n.whenNeeded(k.app)) mods.push(n.module);
    expect(mods).toEqual(["hosting", "hosting-apple"]);
  });
});

describe("privacy: Supabase as processor, in the region", () => {
  test("store answers get sign-in email and files; the notice names Supabase and the place", async () => {
    const k = makeKit();
    await ensureHosting(k.app, PLAN, { deps: k.deps });
    const h = (await hostingPrivacy(k.app.id, k.deps.store))!;
    expect(h.practice).toEqual({ processor: "Supabase", region: "eu-central-1", place: "Frankfurt, Germany (EU)", eu: true, accounts: true, files: true });
    const p = practicesFrom([], { adConversions: "off", deviceId: false }, null, h.practice);
    const d = disclosure(p);
    expect(d.ios.rows.map((r) => `${r.category} → ${r.type}`)).toEqual(["Contact Info → Email Address", "User Content → Other User Content"]);
    expect(d.ios.rows[0]).toMatchObject({ linked: true, tracking: false, purposes: ["App Functionality"] });
    expect(d.android.rows.every((r) => !r.shared)).toBe(true);
    expect(changesFor("ios", null, p)[0]).toContain("kept by Supabase in Frankfurt, Germany (EU)");

    const only = noticeSection({ mobile: true, fieldChecks: false, identify: false, treatments: false, deviceId: false, adPlatforms: [], adConsent: false, hosting: h.notice }, "Habit Loop", "de")!;
    expect(only).toContain("## Wo Habit Loop Daten speichert (Supabase)");
    expect(only).toContain("Frankfurt, Deutschland (EU)");
    expect(only).toContain("Unterauftragsverarbeiter");
    const withChecks = noticeSection({ mobile: true, fieldChecks: true, identify: true, treatments: false, deviceId: false, adPlatforms: [], adConsent: false, hosting: { ...h.notice, eu: false, place: { en: "Tokyo, Japan", de: "Tokio, Japan" } } }, "Habit Loop", "en")!;
    expect(withChecks).toContain("**Where your data is stored:**");
    expect(withChecks).toContain("Standard Contractual Clauses");
    expect(await hostingPrivacy("other", k.deps.store)).toBeNull();
  });
});

if (process.env.DAY2_TEST_DATABASE_URL) {
  describe("hosting in Postgres (accounts mode)", () => {
    test("state and encrypted secrets round-trip; updates are serialized", async () => {
      const t = await createTestDatabase();
      try {
        const [acc] = (await t.sql`INSERT INTO accounts (name) VALUES ('A') RETURNING id`) as Array<{ id: string }>;
        await t.sql`INSERT INTO apps (id, account_id, name, repo_path, connection_method) VALUES ('app_db', ${acc!.id}, 'habit', '/tmp/x', 'github')`;
        const store = dbHostingStore(t.sql);
        const secrets = dbHostingSecrets(t.sql);
        expect((await store.state("app_db")).enabled).toBe(false);
        await Promise.all([1, 2, 3].map((i) => store.update("app_db", (s) => void s.log.unshift({ at: String(i), text: `t${i}` }))));
        const s = await store.update("app_db", (x) => void (x.enabled = true));
        expect(s.enabled).toBe(true);
        expect((await store.state("app_db")).log.map((l) => l.text).sort()).toEqual(["t1", "t2", "t3"]);
        await secrets.set("app_db", "secret_key:production", { key: "sb_secret_abc" }, "Secret key");
        expect(await secrets.get<{ key: string }>("app_db", "secret_key:production")).toEqual({ key: "sb_secret_abc" });
        const [raw] = (await t.sql`SELECT secret FROM hosting_secrets WHERE app_id = 'app_db'`) as Array<{ secret: string }>;
        expect(raw!.secret).not.toContain("sb_secret_abc");
        expect(await secrets.list("app_db")).toMatchObject([{ kind: "secret_key:production", label: "Secret key" }]);
        await secrets.remove("app_db", "secret_key:production");
        expect(await secrets.get("app_db", "secret_key:production")).toBeNull();
      } finally {
        await t.drop();
      }
    });
  });
}
