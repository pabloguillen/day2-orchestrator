import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../api-server";
import { PUBLIC_PATH } from "../request-path";
import { adConnections } from "../tenant";
import { keyIdFromFilename, setNotificationsUrl } from "./apple";
import { createExpoApi, expoConfig } from "./expo";
import { bucketCandidates, cloudProblem, createCloud, playDeveloperId, projectIdFor, STORE_APIS } from "./google-cloud";
import { emailFromIdToken, STORES_CALLBACK_PATH, storesAuthorizeUrl, storesOAuthClient } from "./google-oauth";
import { runGoogleSetup, type SetupDeps, type SetupInput } from "./google-setup";
import { hubView, type HubInput } from "./hub";
import { emptyConnect, CONNECT_FILENAME, fileGoogleSessions, pkceChallenge, scrub } from "./state";
import { connectRunning, purgeGoogleSessions } from "./routes";
import { COMMIT_EXCLUDES, excludeDay2State, isDay2StateFile } from "../day2-state-files";
import { commitAll } from "../git";
import { ExpoApiError } from "./expo";
import { fcmProblem } from "./google-setup";
import { playPermissions } from "./google-cloud";
import { googleSessions } from "../tenant";
import { GoogleError } from "../money/google-play";

/**
 * Connect your stores: Google sign-in → project, APIs, service account,
 * Pub/Sub, FCM, Play invite; Expo robot token → EAS project; the Apple
 * checklist. Every Google/Apple/Expo answer here is a recorded (made-up)
 * response — no network.
 */

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const SA = "day2-appx@dotty-day2.iam.gserviceaccount.com";
// Built from parts so secret scanners don't flag the fixture.
const EXPO_TOKEN = ["expo", "robot", "token", "0123456789abcdef"].join("_");
const keyJson = { type: "service_account", project_id: "dotty-day2", private_key_id: "k1", private_key: rsa, client_email: SA };

type Call = { method: string; url: string; body: unknown; auth: string | null };
type Rule = { method?: string; match: RegExp; status?: number; json?: unknown; text?: string };

/** A fake fetch answering by method + URL pattern (first match), recording every call. */
function fakeFetch(rules: Rule[], calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = init?.body;
    let body: unknown = raw;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw));
      }
    }
    const headers = new Headers(init?.headers);
    calls.push({ method, url, body, auth: headers.get("authorization") });
    const r = rules.find((x) => (!x.method || x.method === method) && x.match.test(url));
    if (!r) return new Response(JSON.stringify({ error: { message: `no fake for ${method} ${url}` } }), { status: 599 });
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("pure helpers", () => {
  test("Key ID from the .p8 file name", () => {
    expect(keyIdFromFilename("AuthKey_ABCD123456.p8")).toBe("ABCD123456");
    expect(keyIdFromFilename("SubscriptionKey_zz99yy88xx.p8")).toBe("ZZ99YY88XX");
    expect(keyIdFromFilename("key.p8")).toBeNull();
  });

  test("Play Console address → developer id → bucket names", () => {
    expect(playDeveloperId("https://play.google.com/console/u/0/developers/5551234567890123456/app-list")).toBe("5551234567890123456");
    expect(playDeveloperId("5551234567890123456")).toBe("5551234567890123456");
    expect(playDeveloperId("https://play.google.com/console")).toBeNull();
    expect(bucketCandidates("123456")).toEqual(["pubsite_prod_rev_123456", "pubsite_prod_123456"]);
  });

  test("project ids Google accepts", () => {
    const id = projectIdFor("Dotty — Habit Tracker!", "a1b2c3d4");
    expect(id).toMatch(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
    expect(id.startsWith("dotty-habit-track")).toBe(true);
    expect(projectIdFor("123", "ff")).toMatch(/^[a-z]/);
  });

  test("Google's consent URL: online access only (no refresh token), the store scopes", () => {
    const u = new URL(storesAuthorizeUrl({ clientId: "cid", clientSecret: "s", source: "DAY2_GOOGLE_OAUTH_CLIENT_ID" }, { state: "st", redirectUri: "https://day2.example/api/ads/connect/callback/googlecloud" }));
    expect(u.searchParams.get("access_type")).toBe("online");
    expect(u.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/cloud-platform");
    expect(u.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/androidpublisher");
    expect(u.toString()).not.toContain("secret");
    expect(emailFromIdToken(`x.${Buffer.from(JSON.stringify({ email: "pablo@example.com" })).toString("base64url")}.y`)).toBe("pablo@example.com");
  });

  test("the OAuth client: day2's own, else the sign-in client", () => {
    expect(storesOAuthClient({})).toBeNull();
    expect(storesOAuthClient({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" })?.source).toBe("GOOGLE_CLIENT_ID");
    expect(storesOAuthClient({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b", DAY2_GOOGLE_OAUTH_CLIENT_ID: "c", DAY2_GOOGLE_OAUTH_CLIENT_SECRET: "d" })?.clientId).toBe("c");
  });

  test("the callback is already public on the tunnel (ads callback pattern)", () => {
    expect(PUBLIC_PATH.test(STORES_CALLBACK_PATH)).toBe(true);
  });

  test("Google refusals become what to do", () => {
    expect(cloudProblem(new GoogleError("400 Key creation is not allowed on this service account.", 400), "create a key")).toContain("iam.disableServiceAccountKeyCreation");
    expect(cloudProblem(new GoogleError("403 denied", 403), "turn on the APIs")).toContain("isn't allowed");
  });

  test("app.json: slug, owner, project id", () => {
    expect(expoConfig({ expo: { slug: "dotty", owner: "pablo", extra: { eas: { projectId: "p-1" } } } })).toEqual({ slug: "dotty", owner: "pablo", projectId: "p-1" });
  });
});

// ---------------------------------------------------------------------------

const GOOGLE_RULES = (opts: { keyBlocked?: boolean; inviteDenied?: boolean } = {}): Rule[] => [
  { method: "POST", match: /cloudresourcemanager\.googleapis\.com\/v1\/projects$/, json: { name: "operations/cp.1", done: true } },
  { method: "GET", match: /cloudresourcemanager\.googleapis\.com\/v1\/projects\?/, json: { projects: [{ projectId: "dotty-prod", name: "Dotty" }, { projectId: "other-1", name: "Another" }] } },
  { method: "POST", match: /cloudresourcemanager.*:getIamPolicy$/, json: { bindings: [], etag: "e1" } },
  { method: "POST", match: /cloudresourcemanager.*:setIamPolicy$/, json: {} },
  { method: "POST", match: /serviceusage.*services:batchEnable$/, json: { name: "operations/acf.1", done: false } },
  { method: "GET", match: /serviceusage\.googleapis\.com\/v1\/operations\/acf\.1$/, json: { name: "operations/acf.1", done: true } },
  { method: "POST", match: /iam\.googleapis\.com\/v1\/projects\/[^/]+\/serviceAccounts$/, json: { email: SA } },
  opts.keyBlocked
    ? { method: "POST", match: /serviceAccounts\/.+\/keys$/, status: 400, json: { error: { message: "Key creation is not allowed on this service account. constraints/iam.disableServiceAccountKeyCreation" } } }
    : { method: "POST", match: /serviceAccounts\/.+\/keys$/, json: { privateKeyData: Buffer.from(JSON.stringify(keyJson)).toString("base64") } },
  { method: "GET", match: /firebase\.googleapis\.com\/v1beta1\/projects\/[^/:]+$/, status: 404, json: { error: { message: "not found" } } },
  { method: "POST", match: /firebase.*:addFirebase$/, json: { name: "operations/fb.1", done: true } },
  { method: "GET", match: /firebase.*\/androidApps$/, json: { apps: [] } },
  { method: "POST", match: /firebase.*\/androidApps$/, json: { name: "operations/fa.1", done: true, response: { appId: "1:123:android:abc" } } },
  { method: "GET", match: /firebase.*androidApps\/.+\/config$/, json: { configFileContents: Buffer.from('{"project_info":{"project_id":"dotty-prod"}}').toString("base64") } },
  { method: "PUT", match: /pubsub\.googleapis\.com\/v1\/projects\/.+\/topics\//, json: {} },
  { method: "GET", match: /pubsub.*:getIamPolicy$/, json: { bindings: [] } },
  { method: "POST", match: /pubsub.*:setIamPolicy$/, json: {} },
  { method: "PUT", match: /pubsub\.googleapis\.com\/v1\/projects\/.+\/subscriptions\//, json: {} },
  opts.inviteDenied
    ? { method: "POST", match: /androidpublisher.*\/developers\/.+\/users$/, status: 403, json: { error: { message: "The caller does not have permission" } } }
    : { method: "POST", match: /androidpublisher.*\/developers\/.+\/users$/, json: { email: SA } },
  { method: "POST", match: /androidpublisher.*\/grants$/, json: {} },
  { method: "GET", match: /storage\.googleapis\.com\/storage\/v1\/b\/pubsite_prod_rev_/, json: { items: [] } },
  { method: "GET", match: /storage\.googleapis\.com/, status: 404, json: {} },
];

function setupInput(over: Partial<SetupInput> = {}): SetupInput {
  return { appId: "app_x", appName: "Dotty", packageName: "de.dotty.app", projectId: "dotty-prod", developerId: "5551234567", publicUrl: "https://day2.example", wantsRtdn: true, existingPlay: null, expo: null, googleServicesInRepo: false, randomSuffix: "abcd", ...over };
}

function setupDeps(f: typeof fetch, saved: Record<string, unknown>): SetupDeps {
  return {
    cloud: createCloud("ya29.owner", { fetch: f, sleep: async () => {}, pollEveryMs: 0 }),
    savePlay: async (cred, label) => void (saved.play = { cred, label }),
    saveRtdn: async (v, label) => void (saved.rtdn = { v, label }),
    saveBucket: async (b) => void (saved.bucket = b),
    googleServicesTicket: async (j) => ((saved.googleServices = j), "T-9"),
    probeBucket: async (b) => (await f(`https://storage.googleapis.com/storage/v1/b/${b}/o?maxResults=1`)).ok,
    progress: () => {},
    now: () => new Date("2026-11-06T10:00:00Z"),
  };
}

describe("Sign in with Google → everything on the Google side", () => {
  test("one run: APIs, service account + key, Firebase, Pub/Sub, Play invite, bucket", async () => {
    const calls: Call[] = [];
    const saved: Record<string, unknown> = {};
    const f = fakeFetch(GOOGLE_RULES(), calls);
    const r = await runGoogleSetup(emptyConnect().google, setupInput(), setupDeps(f, saved));
    expect(r.ok).toBe(true);
    expect(r.file.problem).toBeNull();
    expect(r.file.serviceAccount).toBe(SA);
    expect(r.file.apis?.ok).toBe(true);
    expect(r.file.key?.ok).toBe(true);
    expect(r.file.firebase?.ok).toBe(true);
    expect(r.file.pubsub?.topic).toBe("projects/dotty-prod/topics/day2-play-app-x");
    expect(r.file.invite?.ok).toBe(true);
    expect(r.file.bucket?.ok).toBe(true);
    expect(saved.bucket).toBe("pubsite_prod_rev_5551234567");
    expect((saved.play as { cred: { clientEmail: string } }).cred.clientEmail).toBe(SA);
    expect(saved.rtdn).toEqual({ v: { pushServiceAccount: SA, audience: "https://day2.example/api/store-notify/google/app_x" }, label: "Pub/Sub projects/dotty-prod/topics/day2-play-app-x" });
    expect(saved.googleServices).toContain("dotty-prod");
    // Without Expo, the push key waits for it.
    expect(r.file.fcm?.ok).toBe(false);
    expect(r.file.fcm?.note).toContain("Expo");
    // The calls Google documents, with the owner's token.
    const enable = calls.find((c) => c.url.endsWith("services:batchEnable"))!;
    expect((enable.body as { serviceIds: string[] }).serviceIds).toEqual([...STORE_APIS]);
    expect(enable.auth).toBe("Bearer ya29.owner");
    const role = calls.find((c) => c.url.includes("cloudresourcemanager") && c.url.endsWith(":setIamPolicy"))!;
    expect(JSON.stringify(role.body)).toContain("roles/firebasecloudmessaging.admin");
    const sub = calls.find((c) => c.method === "PUT" && c.url.includes("/subscriptions/"))!;
    expect(sub.body).toMatchObject({ pushConfig: { pushEndpoint: "https://day2.example/api/store-notify/google/app_x", oidcToken: { serviceAccountEmail: SA } } });
    const pubIam = calls.find((c) => c.url.includes("pubsub") && c.url.endsWith(":setIamPolicy"))!;
    expect(JSON.stringify(pubIam.body)).toContain("google-play-developer-notifications@system.gserviceaccount.com");
    const invite = calls.find((c) => c.url.endsWith("/developers/5551234567/users"))!;
    expect(invite.body).toMatchObject({ email: SA, developerAccountPermissions: ["CAN_VIEW_NON_FINANCIAL_DATA_GLOBAL"] });
    const grant = calls.find((c) => c.url.endsWith("/grants"))!;
    expect(grant.body).toMatchObject({ packageName: "de.dotty.app" });
    // Paid products (wantsRtdn): the money permissions too.
    expect((grant.body as { appLevelPermissions: string[] }).appLevelPermissions).toEqual(["CAN_MANAGE_PUBLIC_APKS", "CAN_MANAGE_TRACK_APKS", "CAN_MANAGE_PUBLIC_LISTING", "CAN_REPLY_TO_REVIEWS", "CAN_MANAGE_ORDERS", "CAN_VIEW_FINANCIAL_DATA"]);
  });

  test("with Expo connected, the FCM V1 key goes to EAS in the same run", async () => {
    const calls: Call[] = [];
    const ex: Call[] = [];
    const f = fakeFetch(GOOGLE_RULES(), calls);
    const expoFetch = fakeFetch(
      [
        { match: /api\.expo\.dev/, json: { data: { googleServiceAccountKey: { createGoogleServiceAccountKey: { id: "gsa1" } }, app: { byFullName: { androidAppCredentials: [] } }, androidAppCredentials: { createAndroidAppCredentials: { id: "ac1" } } } } },
      ],
      ex,
    );
    const api = createExpoApi(EXPO_TOKEN, expoFetch);
    const r = await runGoogleSetup(emptyConnect().google, setupInput({ expo: { api, accountId: "acc1", projectId: "proj-1", projectFullName: "@pablo/dotty" } }), setupDeps(f, {}));
    expect(r.file.fcm?.ok).toBe(true);
    const bodies = ex.map((c) => JSON.stringify(c.body));
    expect(bodies.some((b) => b.includes("createGoogleServiceAccountKey") && b.includes(SA))).toBe(true);
    expect(bodies.some((b) => b.includes("createAndroidAppCredentials") && b.includes("googleServiceAccountKeyForFcmV1Id"))).toBe(true);
    expect(ex.every((c) => c.auth === `Bearer ${EXPO_TOKEN}`)).toBe(true);
  });

  test("an organization that forbids keys stops with exactly what to change", async () => {
    const r = await runGoogleSetup(emptyConnect().google, setupInput(), setupDeps(fakeFetch(GOOGLE_RULES({ keyBlocked: true }), []), {}));
    expect(r.ok).toBe(false);
    expect(r.file.problem).toContain("iam.disableServiceAccountKeyCreation");
  });

  test("when Google won't let the owner invite users, the guided step stays", async () => {
    const r = await runGoogleSetup(emptyConnect().google, setupInput(), setupDeps(fakeFetch(GOOGLE_RULES({ inviteDenied: true }), []), {}));
    expect(r.ok).toBe(true);
    expect(r.file.invite?.ok).toBe(false);
    expect(r.file.invite?.note).toContain("by hand");
  });

  test("a new project when the owner has none", async () => {
    const calls: Call[] = [];
    const r = await runGoogleSetup(emptyConnect().google, setupInput({ projectId: null }), setupDeps(fakeFetch(GOOGLE_RULES(), calls), {}));
    expect(r.file.projectId).toMatch(/^dotty-day2-/);
    expect(calls.some((c) => c.method === "POST" && /cloudresourcemanager.*\/v1\/projects$/.test(c.url))).toBe(true);
  });
});

describe("Apple: server notification URL by API", () => {
  test("PATCH /v1/apps/{id} with the production and sandbox URLs, version 2", async () => {
    const calls: Call[] = [];
    const f = fakeFetch([{ method: "GET", match: /\/v1\/apps\?/, json: { data: [{ id: "6450000000", attributes: { bundleId: "de.dotty.app" } }] } }, { method: "PATCH", match: /\/v1\/apps\/6450000000$/, json: { data: {} } }], calls);
    const r = await setNotificationsUrl({ issuerId: "69a6de70-0000-47e3-e053-5b8c7c11a4d1", keyId: "ABCD123456", privateKey: ec }, "de.dotty.app", "https://day2.example/api/store-notify/apple/app_x", f);
    expect(r.ok).toBe(true);
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ data: { type: "apps", id: "6450000000", attributes: { subscriptionStatusUrl: "https://day2.example/api/store-notify/apple/app_x", subscriptionStatusUrlVersion: "V2", subscriptionStatusUrlForSandbox: "https://day2.example/api/store-notify/apple/app_x", subscriptionStatusUrlVersionForSandbox: "V2" } } });
  });

  test("a key without App Manager says so", async () => {
    const f = fakeFetch([{ method: "GET", match: /\/v1\/apps\?/, json: { data: [{ id: "1", attributes: { bundleId: "b" } }] } }, { method: "PATCH", match: /\/v1\/apps\/1$/, status: 403, json: { errors: [{ detail: "forbidden" }] } }], []);
    const r = await setNotificationsUrl({ issuerId: "69a6de70-0000-47e3-e053-5b8c7c11a4d1", keyId: "ABCD123456", privateKey: ec }, "b", "https://x/y", f);
    expect(r).toEqual({ ok: false, why: "The App Store Connect key can't change the app. It needs the App Manager or Admin role." });
  });
});

describe("the hub shows only what applies", () => {
  const base = (over: Partial<HubInput> = {}): HubInput => ({
    appId: "app_x",
    appName: "Dotty",
    mobile: true,
    ids: { bundleId: "de.dotty.app", packageName: "de.dotty.app" },
    publicUrl: "https://day2.example",
    file: emptyConnect(),
    running: null,
    googleAvailable: true,
    release: { expo: null, asc: null, play: null },
    money: { paidProducts: false, iap: null, rtdn: null, notificationsOk: false, paidAppsConfirmed: false },
    numbers: { vendor: null, bucket: null, analyticsRequested: false },
    expoProjectInRepo: null,
    meta: { wanted: false, page: null },
    ...over,
  });
  const ids = (v: ReturnType<typeof hubView>) => v.connections.flatMap((c) => c.steps.map((s) => s.id));

  test("no paid products: no In-App Purchase key, agreement, notifications or Pub/Sub", () => {
    const v = hubView(base());
    expect(v.connections.map((c) => c.id)).toEqual(["google", "expo", "apple"]);
    expect(ids(v)).not.toContain("apple_iap_key");
    expect(ids(v)).not.toContain("apple_paid_apps");
    expect(ids(v)).not.toContain("play_notifications");
    expect(v.connections.every((c) => c.state === "needs_you")).toBe(true);
  });

  test("paid products add the Money steps; iOS-only apps have no Google card", () => {
    const v = hubView(base({ ids: { bundleId: "de.dotty.app", packageName: null }, money: { paidProducts: true, iap: null, rtdn: null, notificationsOk: false, paidAppsConfirmed: false } }));
    expect(v.connections.map((c) => c.id)).toEqual(["expo", "apple"]);
    expect(ids(v)).toEqual(expect.arrayContaining(["apple_paid_apps", "apple_iap_key", "apple_notifications"]));
    expect(v.connections.find((c) => c.id === "apple")!.unlocks).toContain("Money");
  });

  test("connected, checking, broken", () => {
    const file = emptyConnect();
    file.google.invite = { ok: true, at: "", note: "Invited." };
    const v = hubView(base({ file, release: { expo: "Expo token …cdef", asc: null, play: `${SA} · set up by day2` } }));
    const play = v.connections.find((c) => c.id === "google")!.steps.find((s) => s.id === "play_access")!;
    expect(play.state).toBe("checking");
    expect(play.copy).toEqual([{ label: "Service account email", value: SA }]);
    expect(play.permissions.length).toBeGreaterThan(3);
    file.google.access = { ok: false, at: "", note: "The service account can't release yet." };
    file.google.invite = null;
    expect(hubView(base({ file, release: { expo: null, asc: null, play: SA } })).connections[0]!.state).toBe("broken");
  });

  test("web apps have no store connections", () => {
    expect(hubView(base({ mobile: false })).applies).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Through the real router (local mode)
// ---------------------------------------------------------------------------

const ROOT = mkdtempSync(join(tmpdir(), "day2-api-connect-"));
const REPO = join(ROOT, "dotty");
const saved: Record<string, string | undefined> = {};
let appId = "";
const realFetch = globalThis.fetch;

async function call(method: string, path: string, body?: unknown) {
  const res = await handleRequest(new Request(`http://localhost:4700${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" }));
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as Record<string, any>, text, location: res.headers.get("location") };
}

beforeAll(async () => {
  for (const k of ["DAY2_APPS_REGISTRY_PATH", "DAY2_DATA_DIR", "DAY2_BACKLOG_TICK_MINUTES", "DAY2_PUBLIC_URL", "DAY2_GOOGLE_OAUTH_CLIENT_ID", "DAY2_GOOGLE_OAUTH_CLIENT_SECRET", "DAY2_CONSOLE_URL"]) saved[k] = process.env[k];
  process.env.DAY2_APPS_REGISTRY_PATH = join(ROOT, "apps.json");
  process.env.DAY2_DATA_DIR = ROOT;
  process.env.DAY2_PUBLIC_URL = "https://day2.example";
  process.env.DAY2_CONSOLE_URL = "https://day2.example";
  process.env.DAY2_GOOGLE_OAUTH_CLIENT_ID = "cid.apps.googleusercontent.com";
  process.env.DAY2_GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
  mkdirSync(REPO, { recursive: true });
  writeFileSync(join(REPO, "package.json"), JSON.stringify({ name: "dotty", dependencies: { expo: "54.0.0", "react-native": "0.81.0" } }));
  writeFileSync(join(REPO, "app.json"), JSON.stringify({ expo: { name: "Dotty", slug: "dotty", ios: { bundleIdentifier: "de.dotty.app" }, android: { package: "de.dotty.app" } } }));
  execSync("git init -q", { cwd: REPO });
  const r = await call("POST", "/api/apps", { name: "Dotty", repoPath: REPO, connectionMethod: "local_path" });
  expect(r.status).toBe(201);
  appId = r.body.app.id;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(ROOT, { recursive: true, force: true });
});

describe("Connect your stores API", () => {
  test("the hub with nothing connected", async () => {
    const r = await call("GET", `/api/apps/${appId}/connect`);
    expect(r.status).toBe(200);
    expect(r.body.applies).toBe(true);
    expect(r.body.connections.map((c: { id: string }) => c.id)).toEqual(["google", "expo", "apple"]);
    expect(r.body.googleAvailable).toBe(true);
  });

  test("Google: consent → back with a session → pick a project → set up; the key is stored, never returned, the token gone", async () => {
    const start = await call("POST", `/api/apps/${appId}/connect/google/start`, {});
    expect(start.status).toBe(200);
    const auth = new URL(start.body.url);
    expect(auth.searchParams.get("redirect_uri")).toBe(`https://day2.example${STORES_CALLBACK_PATH}`);
    const state = auth.searchParams.get("state")!;

    const calls: Call[] = [];
    const idToken = `x.${Buffer.from(JSON.stringify({ email: "pablo@example.com" })).toString("base64url")}.y`;
    globalThis.fetch = fakeFetch(
      [
        { method: "POST", match: /oauth2\.googleapis\.com\/token$/, json: { access_token: "ya29.owner-token", expires_in: 3599, scope: "openid email https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/androidpublisher", id_token: idToken } },
        { method: "POST", match: /oauth2\.googleapis\.com\/revoke$/, json: {} },
        // The service account's check against Play (opening an edit) right after setup.
        { method: "POST", match: /androidpublisher.*\/applications\/de\.dotty\.app\/edits$/, status: 403, json: { error: { message: "The caller does not have permission" } } },
        ...GOOGLE_RULES(),
      ],
      calls,
    );
    const back = await call("GET", `${STORES_CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=4%2F0abc`);
    expect(back.status).toBe(302);
    const loc = new URL(back.location!);
    expect(loc.pathname).toBe(`/apps/${appId}/connect`);
    const sid = loc.searchParams.get("google")!;
    expect(sid).toMatch(/^gcs_/);
    // The token is encrypted at rest.
    const sessions = readFileSync(join(ROOT, ".day2-connect-google-sessions.json"), "utf-8");
    expect(sessions).not.toContain("ya29.owner-token");

    const projects = await call("GET", `/api/apps/${appId}/connect/google/session/${sid}`);
    expect(projects.status).toBe(200);
    expect(projects.body.email).toBe("pablo@example.com");
    expect(projects.body.projects.map((p: { projectId: string }) => p.projectId)).toEqual(["other-1", "dotty-prod"]);

    const run = await call("POST", `/api/apps/${appId}/connect/google/session/${sid}/setup`, { projectId: "dotty-prod", playConsoleUrl: "https://play.google.com/console/u/0/developers/5551234567/app-list" });
    expect(run.status).toBe(202);
    let hub = run.body;
    for (let i = 0; i < 100 && JSON.stringify(hub).includes('"checking"'); i++) {
      await Bun.sleep(20);
      hub = (await call("GET", `/api/apps/${appId}/connect`)).body;
    }
    const google = hub.connections.find((c: { id: string }) => c.id === "google");
    expect(google.steps.find((s: { id: string }) => s.id === "google_signin").state).toBe("done");
    expect(google.steps.find((s: { id: string }) => s.id === "play_bucket").state).toBe("done");
    const access = google.steps.find((s: { id: string }) => s.id === "play_access");
    expect(access.state).toBe("checking");
    expect(access.copy[0].value).toBe(SA);
    // Releases sees the same Play service account (no second store).
    const rel = await call("GET", `/api/apps/${appId}/mobile-releases`);
    expect(rel.body.accounts.play.label).toContain(SA);
    // No secret ever leaves the API.
    expect(JSON.stringify(hub)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(rel.body)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(hub)).not.toContain("ya29");
    // The owner's token was revoked and the session is gone.
    expect(calls.some((c) => c.url.endsWith("/revoke"))).toBe(true);
    expect((await call("GET", `/api/apps/${appId}/connect/google/session/${sid}`)).status).toBe(410);
    // A ticket brings google-services.json into the app.
    expect(existsSync(join(REPO, CONNECT_FILENAME))).toBe(true);
    expect(JSON.parse(readFileSync(join(REPO, CONNECT_FILENAME), "utf-8")).google.googleServicesTicket).toBeTruthy();
  });

  test("Check: the Play invite applied", async () => {
    globalThis.fetch = fakeFetch(
      [
        { method: "POST", match: /oauth2\.googleapis\.com\/token$/, json: { access_token: "ya29.sa", expires_in: 3599 } },
        { method: "POST", match: /androidpublisher.*\/edits$/, json: { id: "e1" } },
        { method: "DELETE", match: /androidpublisher.*\/edits\/e1$/, json: {} },
      ],
      [],
    );
    const r = await call("POST", `/api/apps/${appId}/connect/google/check`);
    expect(r.status).toBe(200);
    expect(r.body.connections[0].steps.find((s: { id: string }) => s.id === "play_access").state).toBe("done");
  });

  test("Expo: a robot token is checked, then the EAS project found (and a ticket links it in app.json)", async () => {
    const bad = await call("PUT", `/api/apps/${appId}/connect/expo`, { token: "short" });
    expect(bad.status).toBe(400);
    globalThis.fetch = fakeFetch(
      [
        { method: "POST", match: /api\.expo\.dev\/graphql/, json: { data: { meActor: { __typename: "Robot", id: "r1", firstName: "day2", accounts: [{ id: "acc1", name: "pablo" }] }, app: { byFullName: { id: "eas-proj-1", fullName: "@pablo/dotty" } } } } },
      ],
      [],
    );
    const r = await call("PUT", `/api/apps/${appId}/connect/expo`, { token: EXPO_TOKEN });
    expect(r.status).toBe(200);
    const expo = r.body.connections.find((c: { id: string }) => c.id === "expo");
    expect(expo.state).toBe("connected");
    expect(expo.steps[1].note).toContain("eas-proj-1");
    expect(JSON.stringify(r.body)).not.toContain(EXPO_TOKEN);
  });

  test("Apple: Key ID from the file name; a wrong key gets Apple's precise reason", async () => {
    globalThis.fetch = fakeFetch([{ method: "GET", match: /api\.appstoreconnect\.apple\.com\/v1\/apps/, status: 401, json: {} }], []);
    const r = await call("PUT", `/api/apps/${appId}/connect/apple/key`, { issuerId: "69a6de70-0000-47e3-e053-5b8c7c11a4d1", fileName: "AuthKey_ABCD123456.p8", privateKey: ec });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("issuer id");
    globalThis.fetch = fakeFetch([{ method: "GET", match: /api\.appstoreconnect\.apple\.com\/v1\/apps/, json: { data: [{ id: "645", attributes: { name: "Dotty", bundleId: "de.dotty.app" } }] } }], []);
    const ok = await call("PUT", `/api/apps/${appId}/connect/apple/key`, { issuerId: "69a6de70-0000-47e3-e053-5b8c7c11a4d1", fileName: "AuthKey_ABCD123456.p8", privateKey: ec });
    expect(ok.status).toBe(200);
    const apple = ok.body.connections.find((c: { id: string }) => c.id === "apple");
    expect(apple.steps.find((s: { id: string }) => s.id === "apple_key").state).toBe("done");
    expect(apple.steps.find((s: { id: string }) => s.id === "apple_membership").state).toBe("done");
    expect(JSON.stringify(ok.body)).not.toContain("PRIVATE KEY");
  });

  test("Apple: the vendor number is checked with Apple before it's kept", async () => {
    globalThis.fetch = fakeFetch([{ method: "GET", match: /salesReports/, status: 403, json: { errors: [{ detail: "vendor number is not valid" }] } }], []);
    const bad = await call("PUT", `/api/apps/${appId}/connect/apple/vendor`, { vendorNumber: "85012345" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("85012345");
    globalThis.fetch = fakeFetch([{ method: "GET", match: /salesReports/, status: 404, json: {} }], []);
    const ok = await call("PUT", `/api/apps/${appId}/connect/apple/vendor`, { vendorNumber: "85012345" });
    expect(ok.status).toBe(200);
    const numbers = await call("GET", `/api/apps/${appId}/numbers`);
    expect(numbers.status).toBe(200);
  });

  test("Apple: App Analytics needs an Admin key once — a one-time key isn't kept", async () => {
    globalThis.fetch = fakeFetch(
      [
        { method: "GET", match: /\/v1\/apps\?filter/, json: { data: [{ id: "645", type: "apps", attributes: { bundleId: "de.dotty.app" } }] } },
        { method: "GET", match: /analyticsReportRequests/, json: { data: [] } },
        { method: "POST", match: /\/v1\/analyticsReportRequests$/, status: 403, json: { errors: [{ detail: "forbidden" }] } },
      ],
      [],
    );
    const r = await call("POST", `/api/apps/${appId}/connect/apple/analytics`, {});
    expect(r.status).toBe(200);
    const step = r.body.connections.find((c: { id: string }) => c.id === "apple").steps.find((s: { id: string }) => s.id === "apple_analytics");
    expect(step.state).toBe("todo");
    expect(step.note).toContain("Admin");
  });

  test("operator: what the server needs for Google", async () => {
    const r = await call("GET", "/api/platform/connect");
    expect(r.status).toBe(200);
    expect(r.body.google.ready).toBe(true);
    expect(r.body.google.redirectUri).toBe(`https://day2.example${STORES_CALLBACK_PATH}`);
    expect(JSON.stringify(r.body)).not.toContain("csecret");
  });

  test("Growth: Meta counts as connected with a Meta ad connection (not only DAY2_META_AD_ACCOUNT_ID)", async () => {
    const before = await call("GET", `/api/apps/${appId}/growth/autopilot`);
    expect(before.status).toBe(200);
    expect(before.body.paidAds.metaConnected).toBe(false);
    await adConnections().save({ scope: "day2", platform: "meta", adAccountId: "act_1", accountName: "day2", currency: "USD", tokens: { accessToken: "t" }, connectedBy: null });
    const after = await call("GET", `/api/apps/${appId}/growth/autopilot`);
    expect(after.body.paidAds.metaConnected).toBe(true);
    await adConnections().remove("day2", "meta");
  });

  test("Meta: the Page picked after Facebook sign-in is the one ads run under", async () => {
    process.env.META_APP_ID = "metaapp";
    process.env.META_APP_SECRET = "metasecret";
    try {
      const store = adConnections();
      const p = await store.startPending({ state: "st-meta", scope: { appId }, platform: "meta", purpose: "identity", appId, pending: null, createdBy: null });
      await store.setPendingTokens(p.id, { accessToken: "EAAB" });
      globalThis.fetch = fakeFetch([{ method: "GET", match: /graph\.facebook\.com\/.+\/me\/accounts/, json: { data: [{ id: "1234567890", name: "Dotty", tasks: ["ADVERTISE"], instagram_business_account: { id: "17841", username: "dotty" } }] } }], []);
      const list = await call("GET", `/api/apps/${appId}/growth/ads/connect/pending/${p.id}`);
      expect(list.status).toBe(200);
      expect(list.body.identities.map((i: { ref: string }) => i.ref)).toEqual(["1234567890", "1234567890:17841"]);
      const r = await call("POST", `/api/apps/${appId}/growth/ads/connect/pending/${p.id}`, { identityRef: "1234567890:17841" });
      expect(r.status).toBe(200);
      const hub = await call("GET", `/api/apps/${appId}/connect`);
      const meta = hub.body.connections.find((c: { id: string }) => c.id === "meta");
      expect(meta.steps[0].state).toBe("done");
      expect(meta.steps[0].note).toContain("1234567890");
      const ops = await call("GET", "/api/platform/apps");
      expect(ops.body.apps.find((a: { id: string }) => a.id === appId).metaPageId).toBe("1234567890");
    } finally {
      delete process.env.META_APP_ID;
      delete process.env.META_APP_SECRET;
    }
  });

  test("a session belongs to its app", async () => {
    const r = await call("GET", `/api/apps/${appId}/connect/google/session/gcs_nope`);
    expect(r.status).toBe(410);
  });
});

// ---------------------------------------------------------------------------
// Security review fixes
// ---------------------------------------------------------------------------

const PEM = rsa.trim();

describe("review: no key material or tokens in notes", () => {
  test("scrub removes PEM blocks, private_key / private_key_id values, Google tokens and long opaque strings", () => {
    const echo = `Variable "$googleServiceAccountKeyInput" got invalid value {"jsonKey":{"type":"service_account","private_key_id":"0a1b2c3d4e5f60718293a4b5c6d7e8f901234567","private_key":${JSON.stringify(PEM)},"client_email":"x@y.iam.gserviceaccount.com"}}; token=abc ${["ya29", "a0AfH6SMBx_secretvalue"].join(".")}`;
    const out = scrub(echo);
    expect(out).not.toContain("PRIVATE KEY");
    expect(out).not.toContain("0a1b2c3d4e5f60718293a4b5c6d7e8f901234567");
    expect(out).not.toContain("ya29.a0");
    expect(out).not.toContain("MII");
    expect(scrub("Topic projects/dotty-prod/topics/day2-play-app-x pushes to day2.")).toBe("Topic projects/dotty-prod/topics/day2-play-app-x pushes to day2.");
    expect(scrub(`Key ${"A1".repeat(30)} leaked`)).toBe("Key [redacted] leaked");
  });

  test("an Expo error that echoes the key never reaches the note: a fixed message and a safe code", async () => {
    const leaky = { errors: [{ message: `Variable "$jsonKey" got invalid value ${JSON.stringify(keyJson)}`, extensions: { errorCode: "GRAPHQL_VALIDATION_FAILED" } }] };
    const api = createExpoApi(EXPO_TOKEN, fakeFetch([{ match: /api\.expo\.dev/, json: leaky }], []));
    let err: unknown;
    try {
      await api.setFcmV1Key({ accountId: "a", projectFullName: "@p/d", projectId: "p", packageName: "de.dotty.app", jsonKey: keyJson });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExpoApiError);
    expect((err as Error).message).toBe("EAS didn't take the push key");
    expect((err as ExpoApiError).code).toBe("graphql_validation_failed");
    expect(scrub(fcmProblem(err))).toContain("error code: graphql_validation_failed");
    expect(fcmProblem(err)).not.toContain("PRIVATE");
    // In a full setup run, too.
    const r = await runGoogleSetup(emptyConnect().google, setupInput({ expo: { api, accountId: "acc1", projectId: "proj-1", projectFullName: "@pablo/dotty" } }), setupDeps(fakeFetch(GOOGLE_RULES(), []), {}));
    expect(JSON.stringify(r.file)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(r.file)).not.toContain("k1\"");
    expect(r.file.fcm?.note).toContain("graphql_validation_failed");
  });

  test("POST /connect/fcm with a leaky Expo error: the hub and day2-connect.json stay clean", async () => {
    globalThis.fetch = fakeFetch(
      [
        { method: "POST", match: /api\.expo\.dev\/graphql/, json: { data: { meActor: { __typename: "Robot", id: "r1", firstName: "day2", accounts: [{ id: "acc1", name: "pablo" }] }, app: { byFullName: { id: "eas-proj-1", fullName: "@pablo/dotty", androidAppCredentials: [] } } }, errors: [{ message: `bad input ${JSON.stringify(keyJson)}` }] } },
      ],
      [],
    );
    const r = await call("POST", `/api/apps/${appId}/connect/fcm`);
    expect(r.text).not.toContain("PRIVATE KEY");
    expect(readFileSync(join(REPO, CONNECT_FILENAME), "utf-8")).not.toContain("PRIVATE KEY");
    expect(readFileSync(join(REPO, CONNECT_FILENAME), "utf-8")).not.toContain("private_key_id");
  });
});

describe("review: the Google sign-in", () => {
  test("PKCE S256 and a single-use state: a replayed callback is refused; a replaced token is returned for revoking", async () => {
    const start = await call("POST", `/api/apps/${appId}/connect/google/start`, {});
    const u = new URL(start.body.url);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    const state = u.searchParams.get("state")!;
    const sess = Object.values(JSON.parse(readFileSync(join(ROOT, ".day2-connect-google-sessions.json"), "utf-8")) as Array<{ id: string; state: string }>).find((x) => x.state === state)!;
    const verifier = (await googleSessions().get(sess.id))!.verifier;
    expect(u.searchParams.get("code_challenge")).toBe(pkceChallenge(verifier));
    const calls: Call[] = [];
    globalThis.fetch = fakeFetch([{ method: "POST", match: /oauth2\.googleapis\.com\/token$/, json: { access_token: "ya29.first", expires_in: 3599, scope: "https://www.googleapis.com/auth/cloud-platform" } }, { method: "POST", match: /revoke$/, json: {} }], calls);
    const first = await call("GET", `${STORES_CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=c1`);
    expect(new URL(first.location!).searchParams.get("google")).toBe(sess.id);
    expect((calls.find((c) => c.url.endsWith("/token"))!.body as Record<string, string>).code_verifier).toBe(verifier);
    const replay = await call("GET", `${STORES_CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=c2`);
    expect(new URL(replay.location!).searchParams.get("googleError")).toContain("already used");
    expect(calls.filter((c) => c.url.endsWith("/token")).length).toBe(1);
    // The store hands back what a new token replaces.
    expect((await googleSessions().setToken(sess.id, { accessToken: "ya29.second", expiresAt: Date.now() + 1000, email: null }))?.accessToken).toBe("ya29.first");
    await call("DELETE", `/api/apps/${appId}/connect/google/session/${sess.id}`);
    expect(calls.some((c) => c.url.endsWith("/revoke") && JSON.stringify(c.body).includes("ya29.second"))).toBe(true);
    expect(await googleSessions().get(sess.id)).toBeNull();
  });

  test("a failed exchange and a failed project list both end the session (and revoke the token)", async () => {
    const calls: Call[] = [];
    // Exchange fails → session gone.
    let start = await call("POST", `/api/apps/${appId}/connect/google/start`, {});
    let state = new URL(start.body.url).searchParams.get("state")!;
    globalThis.fetch = fakeFetch([{ method: "POST", match: /\/token$/, status: 400, json: { error: "invalid_grant" } }], calls);
    const bad = await call("GET", `${STORES_CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=x`);
    expect(new URL(bad.location!).searchParams.get("googleError")).toBeTruthy();
    const left = () => Object.keys(JSON.parse(readFileSync(join(ROOT, ".day2-connect-google-sessions.json"), "utf-8"))).length;
    expect(left()).toBe(0);
    // Consent given, then listing projects fails → revoked and gone.
    start = await call("POST", `/api/apps/${appId}/connect/google/start`, {});
    state = new URL(start.body.url).searchParams.get("state")!;
    globalThis.fetch = fakeFetch(
      [
        { method: "POST", match: /\/token$/, json: { access_token: "ya29.listfail", expires_in: 3599, scope: "https://www.googleapis.com/auth/cloud-platform" } },
        { method: "POST", match: /revoke$/, json: {} },
        { method: "GET", match: /cloudresourcemanager/, status: 403, json: { error: { message: "denied" } } },
      ],
      calls,
    );
    const ok = await call("GET", `${STORES_CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=y`);
    const sid = new URL(ok.location!).searchParams.get("google")!;
    expect((await call("GET", `/api/apps/${appId}/connect/google/session/${sid}`)).status).toBe(502);
    expect(calls.some((c) => c.url.endsWith("/revoke") && JSON.stringify(c.body).includes("ya29.listfail"))).toBe(true);
    expect(left()).toBe(0);
  });

  test("abandoned sign-ins: purged after an hour and their tokens revoked", async () => {
    const store = fileGoogleSessions(join(ROOT, ".day2-connect-google-sessions.json"));
    const s = await store.start({ accountId: "local", appId, createdBy: null });
    await store.setToken(s.id, { accessToken: "ya29.abandoned", expiresAt: Date.now() + 3_600_000, email: null });
    const calls: Call[] = [];
    globalThis.fetch = fakeFetch([{ method: "POST", match: /revoke$/, json: {} }], calls);
    expect(await purgeGoogleSessions(Date.now())).toBe(0);
    expect(await purgeGoogleSessions(Date.now() + 3_700_000)).toBe(1);
    expect(calls.some((c) => JSON.stringify(c.body).includes("ya29.abandoned"))).toBe(true);
    expect(await store.get(s.id)).toBeNull();
  });

  test("two setups at once: one runs, the other gets 409", async () => {
    const start = await call("POST", `/api/apps/${appId}/connect/google/start`, {});
    const state = new URL(start.body.url).searchParams.get("state")!;
    globalThis.fetch = fakeFetch(
      [
        { method: "POST", match: /oauth2\.googleapis\.com\/token$/, json: { access_token: "ya29.race", expires_in: 3599, scope: "https://www.googleapis.com/auth/cloud-platform" } },
        { method: "POST", match: /revoke$/, json: {} },
        { method: "POST", match: /androidpublisher.*\/edits$/, status: 403, json: { error: { message: "no" } } },
        ...GOOGLE_RULES(),
      ],
      [],
    );
    const back = await call("GET", `${STORES_CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=z`);
    const sid = new URL(back.location!).searchParams.get("google")!;
    const [a, b] = await Promise.all([call("POST", `/api/apps/${appId}/connect/google/session/${sid}/setup`, { projectId: "dotty-prod" }), call("POST", `/api/apps/${appId}/connect/google/session/${sid}/setup`, { projectId: "dotty-prod" })]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    for (let i = 0; i < 200 && connectRunning(appId); i++) await Bun.sleep(10);
    expect(connectRunning(appId)).toBeNull();
  });

  test("a refused setup (bad input) frees the lock", async () => {
    const store = fileGoogleSessions(join(ROOT, ".day2-connect-google-sessions.json"));
    const s = await store.start({ accountId: "local", appId, createdBy: null });
    await store.setToken(s.id, { accessToken: "ya29.x", expiresAt: Date.now() + 3_600_000, email: null });
    const r = await call("POST", `/api/apps/${appId}/connect/google/session/${s.id}/setup`, { projectId: "NOT VALID" });
    expect(r.status).toBe(400);
    expect(connectRunning(appId)).toBeNull();
    await store.end(s.id);
  });
});

describe("review: day2's state files never reach the customer's repo", () => {
  test("isDay2StateFile", () => {
    expect(isDay2StateFile("day2-connect.json")).toBe(true);
    expect(isDay2StateFile("day2-autopilot-log.jsonl")).toBe(true);
    expect(isDay2StateFile("src/day2.ts")).toBe(false);
    expect(isDay2StateFile("lib/day2-connect.json")).toBe(false);
  });

  test("the checkout's .git/info/exclude lists them: git add -A skips them (registration and every save do this)", () => {
    // The app registered in beforeAll already got them.
    expect(readFileSync(join(REPO, ".git", "info", "exclude"), "utf-8")).toContain("/day2-*.json");
    const dir = mkdtempSync(join(tmpdir(), "day2-exclude-"));
    execSync("git init -q", { cwd: dir });
    writeFileSync(join(dir, "day2-connect.json"), "{}");
    writeFileSync(join(dir, "day2-money.json"), "{}");
    writeFileSync(join(dir, "app.ts"), "x");
    expect(excludeDay2State(dir)).toBe(true);
    expect(excludeDay2State(dir)).toBe(true);
    expect(readFileSync(join(dir, ".git", "info", "exclude"), "utf-8").match(/\/day2-\*\.json$/gm)?.length).toBe(1);
    execSync("git add -A", { cwd: dir });
    expect(execSync("git diff --cached --name-only", { cwd: dir }).toString().trim()).toBe("app.ts");
    rmSync(dir, { recursive: true, force: true });
  });

  test("commitAll leaves them out even without the exclude file (a fresh clone)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-commit-"));
    execSync("git init -q && git -c user.name=t -c user.email=t@x commit -q --allow-empty -m init", { cwd: dir });
    writeFileSync(join(dir, "day2-backlog.json"), "{}");
    writeFileSync(join(dir, "day2-autopilot-log.jsonl"), "{}");
    writeFileSync(join(dir, "fix.ts"), "x");
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "t";
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "t@x";
    try {
      await commitAll(dir, "fix");
    } finally {
      for (const k of ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]) delete process.env[k];
    }
    expect(execSync("git show --name-only --format= HEAD", { cwd: dir }).toString().trim()).toBe("fix.ts");
    expect(COMMIT_EXCLUDES.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("review: the Play invite asks for the least", () => {
  test("money permissions only with paid products", () => {
    const free = playPermissions({ paidProducts: false });
    expect(free.account).toEqual(["CAN_VIEW_NON_FINANCIAL_DATA_GLOBAL"]);
    expect(free.app).toEqual(["CAN_MANAGE_PUBLIC_APKS", "CAN_MANAGE_TRACK_APKS", "CAN_MANAGE_PUBLIC_LISTING", "CAN_REPLY_TO_REVIEWS"]);
    expect(free.names).toHaveLength(5);
    expect(playPermissions({ paidProducts: true }).app).toContain("CAN_MANAGE_ORDERS");
  });

  test("a free app's invite has no order or financial permissions", async () => {
    const calls: Call[] = [];
    await runGoogleSetup(emptyConnect().google, setupInput({ wantsRtdn: false }), setupDeps(fakeFetch(GOOGLE_RULES(), calls), {}));
    const grant = calls.find((c) => c.url.endsWith("/grants"))!;
    expect(JSON.stringify(grant.body)).not.toContain("ORDERS");
    expect(JSON.stringify(grant.body)).not.toContain("FINANCIAL");
  });
});
