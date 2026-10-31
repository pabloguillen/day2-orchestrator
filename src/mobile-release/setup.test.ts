import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "../db/test-db";
import { dbFieldStore, fileFieldStore, releaseMatches, type FieldStore } from "../field-store";
import type { Batch } from "../../packages/sensors/src/types";
import { dbReleaseCredentials, fileReleaseCredentials, parseCredential, type ReleaseCredentialStore } from "./credentials";
import { installCommand, withVersion } from "./git-workdir";
import { readiness, setupTicket } from "./setup";

/** Setting an app up for releases: what's missing in the code, credentials, release health data. */

const root = mkdtempSync(join(tmpdir(), "day2-release-setup-"));
const prevKey = process.env.DAY2_SECRETS_KEY;
process.env.DAY2_SECRETS_KEY ??= randomBytes(32).toString("base64");
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (prevKey === undefined) delete process.env.DAY2_SECRETS_KEY;
});

describe("what the code needs", () => {
  test("a fresh Expo app: everything listed, in one ticket", () => {
    const repo = join(root, "fresh");
    mkdirSync(repo);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { expo: "55.0.0", "react-native": "0.82.0" } }));
    writeFileSync(join(repo, "app.json"), JSON.stringify({ expo: { name: "Buddy", version: "1.4.0", extra: { eas: { projectId: "p-123" } } } }));
    const r = readiness(repo, null);
    expect(r.projectId).toBe("p-123");
    expect(r.code).toHaveLength(5);
    const t = setupTicket(r);
    expect(t.description).toContain("https://u.expo.dev/p-123");
    expect(t.description).toContain("releaseTag(Application.nativeApplicationVersion");
  });
  test("a set-up app reporting its release: nothing to do", () => {
    const repo = join(root, "ready");
    mkdirSync(repo);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { expo: "55.0.0", "expo-updates": "1", "expo-application": "1" } }));
    writeFileSync(join(repo, "app.json"), JSON.stringify({ expo: { version: "1.4.0", runtimeVersion: { policy: "fingerprint" }, updates: { url: "https://u.expo.dev/p-1" } } }));
    writeFileSync(join(repo, "eas.json"), JSON.stringify({ cli: { appVersionSource: "remote" }, build: { production: { autoIncrement: true, channel: "production" } }, submit: { production: { android: { track: "internal" } } } }));
    expect(readiness(repo, "1.4.0(23)@3f2a9c1e").code).toEqual([]);
    expect(readiness(repo, "1.4.0")).toMatchObject({ code: [], reportsRelease: false });
  });
  test("the version bump edits only the version; not when it's computed", () => {
    expect(withVersion(JSON.stringify({ expo: { name: "B", version: "1.4.0" } }), "app.json", "1.4.1")).toBe(`${JSON.stringify({ expo: { name: "B", version: "1.4.1" } }, null, 2)}\n`);
    expect(withVersion('export default { name: "B", version: "1.4.0", ios: {} }', "app.config.ts", "1.4.1")).toBe('export default { name: "B", version: "1.4.1", ios: {} }');
    expect(withVersion("export default { version: pkg.version }", "app.config.js", "1.4.1")).toBeNull();
  });
  test("installs with the app's own package manager", () => {
    const repo = join(root, "pm");
    mkdirSync(repo);
    expect(installCommand(repo)[0]).toBe("npm");
    writeFileSync(join(repo, "yarn.lock"), "");
    expect(installCommand(repo).join(" ")).toContain("yarn@1 install --frozen-lockfile");
  });
});

describe("credentials", () => {
  test("pasted keys are checked, with plain-language errors", () => {
    expect(() => parseCredential("expo", { token: "short" })).toThrow("Expo access token");
    expect(parseCredential("expo", { token: "x".repeat(40) }).label).toBe("Expo token …xxxx");
    expect(() => parseCredential("asc", { issuerId: "nope", keyId: "ABCDE12345", privateKey: "" })).toThrow("issuer id");
    const asc = parseCredential("asc", { issuerId: "69a6de8f-1111-47e3-e053-5b8c7c11a4d1", keyId: "ABCDE12345", privateKey: "-----BEGIN PRIVATE KEY-----\nMIG\n-----END PRIVATE KEY-----" });
    expect(asc.label).toBe("App Store Connect key ABCDE12345");
    expect(() => parseCredential("play", { json: "{}" })).toThrow("service account");
    const play = parseCredential("play", { json: JSON.stringify({ type: "service_account", client_email: "day2@buddy.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----", project_id: "buddy" }) });
    expect(play.label).toBe("day2@buddy.iam.gserviceaccount.com");
  });

  const suite = (name: string, make: () => Promise<{ store: ReleaseCredentialStore; appId: string; path?: string; done: () => Promise<void> }>) =>
    test(`${name}: stored encrypted, listed without secrets`, async () => {
      const c = await make();
      await c.store.set(c.appId, "expo", { token: "secret-token-1234567890" }, "Expo token …7890", "Pablo");
      expect((await c.store.get(c.appId, "expo"))!.value.token).toBe("secret-token-1234567890");
      expect(JSON.stringify(await c.store.list(c.appId))).not.toContain("secret-token");
      if (c.path) expect(require("node:fs").readFileSync(c.path, "utf-8")).not.toContain("secret-token");
      await c.store.remove(c.appId, "expo");
      expect(await c.store.get(c.appId, "expo")).toBeNull();
      await c.done();
    });
  suite("files", async () => ({ store: fileReleaseCredentials(join(root, "creds.json")), appId: "app_r", path: join(root, "creds.json"), done: async () => {} }));
  if (process.env.DAY2_TEST_DATABASE_URL)
    suite("Postgres", async () => {
      const t = await createTestDatabase();
      const [acc] = (await t.sql`INSERT INTO accounts (name) VALUES ('A') RETURNING id`) as Array<{ id: string }>;
      await t.sql`INSERT INTO apps (id, account_id, name, repo_path, connection_method) VALUES ('app_r', ${acc!.id}, 'buddy', '/tmp/x', 'github')`;
      return { store: dbReleaseCredentials(t.sql), appId: "app_r", done: () => t.drop() };
    });
});

describe("release health from the field", () => {
  test("keys: an update on any build, a build with or without updates, exact", () => {
    expect(releaseMatches("@3f2a9c1e", "1.4.0(23)@3f2a9c1e")).toBe(true);
    expect(releaseMatches("@3f2a9c1e", "1.4.1(24)@3f2a9c1e")).toBe(true);
    expect(releaseMatches("1.4.0(23)*", "1.4.0(23)@3f2a9c1e")).toBe(true);
    expect(releaseMatches("1.4.0(23)*", "1.4.0(23)")).toBe(true);
    expect(releaseMatches("1.4.0(23)*", "1.4.0(24)")).toBe(false);
    expect(releaseMatches("1.4.0(23)", "1.4.0(23)@3f2a9c1e")).toBe(false);
  });

  const batch = (device: string, release: string, crash: boolean): Batch => ({
    v: 1,
    release,
    device: { id: device, platform: "ios" },
    passes: {},
    failures: crash ? [{ contract: "builtin:stability.crash", at: "2026-10-31T10:05:00Z", route: "/", expected: {}, actual: "boom", evidence: { requests: [], errors: [] }, steps: [] }] : [],
    events: [],
  });
  const suite = (name: string, make: () => Promise<{ store: FieldStore; appId: string; done: () => Promise<void> }>) =>
    test(`${name}: launches and crashes per release`, async () => {
      const c = await make();
      const now = new Date("2026-10-31T10:10:00Z");
      for (let i = 0; i < 10; i++) await c.store.record(c.appId, batch(`dev-new-${i}xx`, "1.4.0(23)@3f2a9c1e", i < 3), now);
      for (let i = 0; i < 20; i++) await c.store.record(c.appId, batch(`dev-old-${i}xx`, "1.4.0(23)", i < 1), now);
      await c.store.record(c.appId, batch("dev-new-0xx", "1.4.0(23)@3f2a9c1e", false), now); // same launch again
      const h = await c.store.releaseHealth(c.appId, ["@3f2a9c1e", "1.4.0(23)*"], new Date("2026-10-31T00:00:00Z"));
      expect(h).toEqual([
        { release: "@3f2a9c1e", devices: 10, crashed: 3, failing: {} },
        { release: "1.4.0(23)*", devices: 30, crashed: 4, failing: {} },
      ]);
      await c.done();
    });
  suite("files", async () => ({ store: fileFieldStore(join(root, "field")), appId: "app_f", done: async () => {} }));
  if (process.env.DAY2_TEST_DATABASE_URL)
    suite("Postgres", async () => {
      const t = await createTestDatabase();
      const [acc] = (await t.sql`INSERT INTO accounts (name) VALUES ('A') RETURNING id`) as Array<{ id: string }>;
      await t.sql`INSERT INTO apps (id, account_id, name, repo_path, connection_method) VALUES ('app_d', ${acc!.id}, 'buddy', '/tmp/x', 'github')`;
      return { store: dbFieldStore(t.sql), appId: "app_d", done: () => t.drop() };
    });
});
