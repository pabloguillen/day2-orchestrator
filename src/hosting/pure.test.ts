import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { appleClientSecret, authPatch, emailTemplates, parseApple, parseGoogle, redirects, smtpFromUrl, testApple, testGoogle } from "./auth";
import { easJsonWithEnv } from "./app-config";
import { eligibility } from "./eligibility";
import { neededSecrets, readFunctions, verifyJwtSettings } from "./functions";
import { checkMigrations, contractSteps, databaseUrl, migrationSql, readMigrations, rlsGaps, type MigrationFile } from "./migrations";
import { regionFor } from "./region";
import { storageSql } from "./storage";
import { makeRepo, PLAN } from "./test-kit";
import { checkOperator } from "./operator";
import { SupabaseError } from "./supabase";

const P8 = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = P8.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const mf = (file: string, sql: string): MigrationFile => ({ version: file.split("_")[0]!, name: file.replace(/^\d+_|\.sql$/g, ""), file, sql });

describe("region", () => {
  test("from the audience: German → Frankfurt, US → Virginia, ties go to the EU, locales when no country", () => {
    expect(regionFor({ countries: ["DE", "AT", "CH"] }, "us-east-1")).toBe("eu-central-1");
    expect(regionFor({ countries: ["US"] }, "eu-central-1")).toBe("us-east-1");
    expect(regionFor({ countries: ["US", "FR"] }, "us-east-1")).toBe("eu-west-3");
    expect(regionFor({ locales: ["ja-JP"] }, "eu-central-1")).toBe("ap-northeast-1");
    expect(regionFor({ locales: ["de"] }, "us-east-1")).toBe("eu-central-1");
    expect(regionFor(undefined, "eu-central-1")).toBe("eu-central-1");
  });
});

describe("migrations", () => {
  test("reads supabase/migrations in order with version and name", () => {
    const repo = makeRepo();
    expect(readMigrations(repo).map((m) => [m.version, m.name])).toEqual([["20261101120000", "habits"]]);
    rmSync(repo, { recursive: true, force: true });
  });

  test("RLS: every public table needs it somewhere in the migrations", () => {
    const files = [mf("1_a.sql", 'create table public.a (id int);\ncreate table if not exists "b" (id int);\ncreate table private.c (id int);'), mf("2_b.sql", "alter table public.a enable row level security;")];
    expect(rlsGaps(files)).toEqual([{ table: "b", file: "1_a.sql" }]);
    expect(rlsGaps([...files, mf("3_c.sql", "drop table b;")])).toEqual([]);
  });

  test("contract steps need the mark; adding nullable columns doesn't", () => {
    expect(contractSteps("alter table t add column x text;")).toEqual([]);
    expect(contractSteps("alter table t add column x text not null default '';")).toEqual([]);
    expect(contractSteps("alter table t drop column x;")).toEqual(["drops a column"]);
    expect(contractSteps("alter table t rename column x to y;")).toEqual(["renames a table or column"]);
    expect(contractSteps("alter table t alter column x type bigint;")).toEqual(["changes a column's type"]);
    expect(contractSteps("alter table t add column x text not null;")).toEqual(["adds a required column without a default"]);
    const all = [mf("1_a.sql", "create table public.a (id int); alter table public.a enable row level security;")];
    const drop = mf("2_drop.sql", "alter table public.a drop column old;");
    expect(checkMigrations([...all, drop], [drop])).toMatchObject([{ kind: "contract", file: "2_drop.sql" }]);
    const marked = mf("2_drop.sql", "-- day2:contract\nalter table public.a drop column old;");
    expect(checkMigrations([...all, marked], [marked])).toEqual([]);
  });

  test("one transaction with its history row; dollar quotes survive $ in the SQL", () => {
    const sql = migrationSql(mf("20261101_x.sql", "create function f() returns int as $$ select 1 $$ language sql"));
    expect(sql.startsWith("BEGIN;\ncreate function f()")).toBe(true);
    expect(sql).toContain("$$ language sql;\nINSERT INTO supabase_migrations.schema_migrations (version, name, statements) VALUES ($d2_");
    expect(sql.endsWith("COMMIT;")).toBe(true);
  });

  test("the CLI's database URL: session port, password filled in", () => {
    const u = new URL(databaseUrl("postgresql://postgres.abc:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres", "p@ss/word"));
    expect(u.port).toBe("5432");
    expect(decodeURIComponent(u.password)).toBe("p@ss/word");
  });
});

describe("sign-in", () => {
  test("redirects use the deep link scheme; staging also allows Expo Go", () => {
    expect(redirects({ scheme: "habitloop" }, "production")).toEqual({ siteUrl: "habitloop://", redirectUrls: ["habitloop://**"] });
    expect(redirects({ scheme: "habitloop" }, "staging", "https://habitloop.app/").redirectUrls).toEqual(["habitloop://**", "https://habitloop.app/**", "exp://**"]);
  });

  test("templates in German or English, with the code", () => {
    const de = emailTemplates("Habit Loop", "de-AT");
    expect(de.lang).toBe("de");
    expect(de.templates.recovery.subject).toBe("Passwort für Habit Loop zurücksetzen");
    expect(de.templates.magic_link.body).toContain("{{ .Token }}");
    expect(emailTemplates("X", "fr").lang).toBe("en");
  });

  test("auth patch: providers only with the owner's details; SMTP raises the email rate", () => {
    const google = { webClientId: "123-abc.apps.googleusercontent.com", webClientSecret: "GOCSPX-secret", iosClientId: "123-ios.apps.googleusercontent.com", androidClientId: null };
    const p = authPatch({ appName: "Habit Loop", plan: { ...PLAN, auth: { email: true, apple: true, google: true } }, env: "production", smtp: smtpFromUrl("smtp://u:p%40ss@smtp.x.com:2525", "no-reply@x.com"), apple: { clientIds: ["com.habitloop.signin", "com.habitloop"], secret: "jwt" }, google });
    expect(p).toMatchObject({ external_apple_enabled: true, external_apple_client_id: "com.habitloop.signin,com.habitloop", external_apple_secret: "jwt", external_google_enabled: true, external_google_client_id: google.webClientId, external_google_additional_client_ids: google.iosClientId, smtp_port: "2525", smtp_pass: "p@ss", rate_limit_email_sent: 30, external_email_enabled: true });
    const none = authPatch({ appName: "Habit Loop", plan: PLAN, env: "production", smtp: null, apple: null, google: null });
    expect(none.external_apple_enabled).toBe(false);
    expect(none.smtp_host).toBeUndefined();
  });

  test("Apple's client secret is an ES256 JWT Apple can verify", () => {
    const a = parseApple({ teamId: "ABCDE12345", keyId: "KEY1234567", privateKey: pem, servicesId: "com.habitloop.signin" });
    const { jwt, expiresAt } = appleClientSecret(a, "com.habitloop.signin", new Date("2026-11-03T00:00:00Z"));
    const [h, b, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY1234567", typ: "JWT" });
    expect(JSON.parse(Buffer.from(b!, "base64url").toString())).toMatchObject({ iss: "ABCDE12345", aud: "https://appleid.apple.com", sub: "com.habitloop.signin" });
    expect(verify("sha256", Buffer.from(`${h}.${b}`), { key: createPublicKey(pem), dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url"))).toBe(true);
    expect(expiresAt).toBe("2027-05-02T00:00:00.000Z");
  });

  test("plain-language errors for what the owner pastes", () => {
    expect(() => parseApple({ teamId: "x" })).toThrow("Team ID");
    expect(() => parseApple({ teamId: "ABCDE12345", keyId: "KEY1234567", privateKey: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----" })).toThrow("can't be read");
    expect(() => parseGoogle({ webClientId: "nope" })).toThrow("googleusercontent.com");
  });

  test("connection tests: invalid_grant means the details are right, invalid_client wrong", async () => {
    const a = parseApple({ teamId: "ABCDE12345", keyId: "KEY1234567", privateKey: pem });
    const answer = (error: string) => (async () => new Response(JSON.stringify({ error }), { status: 400 })) as unknown as typeof fetch;
    expect(await testApple(a, "com.habitloop", answer("invalid_grant"))).toEqual({ ok: true });
    expect(await testApple(a, "com.habitloop", answer("invalid_client"))).toMatchObject({ ok: false, error: expect.stringContaining("Apple didn't accept") });
    const g = parseGoogle({ webClientId: "123-abc.apps.googleusercontent.com", webClientSecret: "GOCSPX-abcdefgh" });
    expect(await testGoogle(g, answer("invalid_grant"))).toEqual({ ok: true });
    expect(await testGoogle(g, answer("invalid_client"))).toMatchObject({ ok: false });
  });
});

describe("storage", () => {
  test("buckets and own-folder policies; public buckets readable by anyone", () => {
    const sql = storageSql([{ name: "photos", public: false, maxBytes: 1000, mimeTypes: ["image/*"] }, { name: "avatars", public: true }]);
    expect(sql).toContain("VALUES ('photos', 'photos', false, 1000, ARRAY['image/*'])");
    expect(sql).toContain(`CREATE POLICY "day2 photos read" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'photos' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);`);
    expect(sql).toContain(`CREATE POLICY "day2 avatars read" ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = 'avatars');`);
    expect(sql).toContain(`DROP POLICY IF EXISTS "day2 avatars upload" ON storage.objects;`);
    expect(() => storageSql([{ name: "Bad Name", public: false }])).toThrow("lowercase");
  });
});

describe("app config and eligibility", () => {
  test("eas.json gets the public values in every profile, staging for non-production", () => {
    const out = JSON.parse(easJsonWithEnv(JSON.stringify({ build: { production: { channel: "production" }, preview: {} } }), { url: "https://p.supabase.co", key: "pk" }, { url: "https://s.supabase.co", key: "sk" })!);
    expect(out.build.production).toEqual({ channel: "production", env: { EXPO_PUBLIC_SUPABASE_URL: "https://p.supabase.co", EXPO_PUBLIC_SUPABASE_KEY: "pk" } });
    expect(out.build.preview.env.EXPO_PUBLIC_SUPABASE_URL).toBe("https://s.supabase.co");
    expect(easJsonWithEnv(JSON.stringify(out), { url: "https://p.supabase.co", key: "pk" }, { url: "https://s.supabase.co", key: "sk" })).toBeNull();
  });

  test("Create apps and apps without a backend only", () => {
    const repo = makeRepo();
    expect(eligibility(repo)).toEqual({ eligible: true, why: "create" });
    rmSync(join(repo, "src", "backend"), { recursive: true });
    expect(eligibility(repo)).toEqual({ eligible: true, why: "no_backend" });
    const own = makeRepo({ files: { ".env.example": "EXPO_PUBLIC_API_URL=https://api.example.com\n" } });
    rmSync(join(own, "src", "backend"), { recursive: true });
    expect(eligibility(own)).toEqual({ eligible: false, why: "own_backend", backend: "its own server" });
    const web = makeRepo({ files: { "package.json": '{"dependencies":{"next":"15"}}' } });
    expect(eligibility(web)).toEqual({ eligible: false, why: "not_expo" });
  });

  test("functions: sources with _shared, verify_jwt from config.toml, secret names", () => {
    const repo = makeRepo({ files: { "supabase/config.toml": "[functions.hello]\nverify_jwt = false\n[db]\nverify_jwt = true\n" } });
    expect(readFunctions(repo)).toMatchObject([{ slug: "hello", entrypoint: "hello/index.ts", verifyJwt: false }]);
    expect(verifyJwtSettings(repo)).toEqual({ hello: false });
    expect(neededSecrets(repo)).toEqual(["OPENAI_KEY"]);
  });
});

describe("operator connection test", () => {
  test("plain errors for a wrong token or organization", async () => {
    const cfg = { token: "sbp_x", orgSlug: "day2", smtp: null, defaultRegion: "eu-central-1" as const, instanceSize: "micro" as const };
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await checkOperator(cfg, { fetch: reply(401, { message: "Unauthorized" }) })).toMatchObject({ ok: false, error: expect.stringContaining("didn't accept the access token") });
    expect(await checkOperator(cfg, { fetch: reply(404, { message: "nope" }) })).toMatchObject({ ok: false, error: expect.stringContaining('can\'t see the organization "day2"') });
    const r = await checkOperator(cfg, { fetch: reply(200, { id: "1", name: "day2 apps", plan: "free", entitlements: [] }) });
    expect(r).toMatchObject({ ok: true, orgName: "day2 apps", plan: "free", branching: false });
    if (r.ok) expect(r.warnings.join(" ")).toContain("Free plan");
    expect(await checkOperator(null)).toMatchObject({ ok: false });
    expect(new SupabaseError(1, "x").status).toBe(1);
  });
});
