import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lint } from "./fake-supabase";
import { applyMigrations, ensureHosting, hostedBackendTicket, hostingPlanFrom } from "./index";
import { BACKEND_KEY } from "./tickets";
import { makeKit, makeRepo, PLAN } from "./test-kit";

const prevKey = process.env.DAY2_SECRETS_KEY;
beforeAll(() => {
  process.env.DAY2_SECRETS_KEY = randomBytes(32).toString("base64");
});
afterAll(() => {
  if (prevKey === undefined) delete process.env.DAY2_SECRETS_KEY;
  else process.env.DAY2_SECRETS_KEY = prevKey;
});

const all = (dir: string): string => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name), "utf-8")).join("\n");

describe("ensureHosting (Create's entry point)", () => {
  test("sets up production from nothing: project in the audience's region, keys, sign-in, storage, migrations, functions, advisors, app config, ticket", async () => {
    const k = makeKit();
    const r = await ensureHosting(k.app, PLAN, { deps: k.deps });
    expect(r.url).toBe(`https://${r.projectRef}.supabase.co`);
    expect(r.publishableKey).toBe(`sb_publishable_${r.projectRef}`);

    const create = k.fake.calls.find((c) => c.op === "createProject")!;
    expect(create.token).toBe(k.deps.operator!.token);
    expect(create.args[0]).toMatchObject({ name: "habit-loop-apph", organization_slug: "day2-apps", region: "eu-central-1", desired_instance_size: "micro", db_pass: "[set]" });

    const s = await k.deps.store.state(k.app.id);
    expect(s.done.production).toEqual(["project", "healthy", "keys", "auth", "storage", "migrations", "functions", "advisors", "app_config", "ticket"]);
    expect(s.projects.production!.status).toBe("ACTIVE_HEALTHY");
    expect(s.branching).toBe("available");

    // Sign-in: deep link redirects, German templates, day2's SMTP, Apple waits for the owner.
    const authCfg = k.fake.auth.get(r.projectRef)!;
    expect(authCfg.site_url).toBe("habitloop://");
    expect(authCfg.uri_allow_list).toBe("habitloop://**");
    expect(authCfg.mailer_subjects_magic_link).toBe("Dein Anmeldelink für Habit Loop");
    expect(authCfg.smtp_host).toBe("smtp.example.com");
    expect(authCfg.external_apple_enabled).toBe(false);
    expect(s.auth.apple.state).toBe("needs_setup");
    expect(s.auth.smtp).toBe("day2");

    // Storage and the migration (with its history row), through the SQL endpoint.
    expect(k.fake.sql.some((q) => q.query.includes("INSERT INTO storage.buckets") && q.query.includes("'photos'"))).toBe(true);
    expect([...k.fake.migrations.get(r.projectRef)!]).toEqual(["20261101120000"]);
    expect(s.migrations).toMatchObject([{ env: "production", version: "20261101120000", name: "habits", ok: true, via: "api" }]);

    // Functions with the shared folder; the missing secret is pointed out.
    const deploy = k.fake.calls.find((c) => c.op === "deployFunction")!;
    expect(deploy.args[1]).toBe("hello");
    expect(deploy.args[2]).toEqual(["hello/index.ts", "_shared/cors.ts"]);
    expect(s.problem?.text).toContain("OPENAI_KEY");

    // App config: eas.json in the repo (every profile) and EAS environment variables.
    const eas = JSON.parse(readFileSync(join(k.repo, "eas.json"), "utf-8"));
    expect(eas.build.production.env).toEqual({ EXPO_PUBLIC_SUPABASE_URL: r.url, EXPO_PUBLIC_SUPABASE_KEY: r.publishableKey });
    expect(eas.build.preview.env.EXPO_PUBLIC_SUPABASE_KEY).toBe(r.publishableKey);
    expect(eas.build.production.autoIncrement).toBe(true);
    const envSet = k.runs.filter((x) => x.cmd.includes("env:set"));
    expect(envSet).toHaveLength(4);
    expect(envSet[0]!.cmd).toEqual(["npx", "--yes", "eas-cli@27.2.0", "env:set", "--name", "EXPO_PUBLIC_SUPABASE_URL", "--value", r.url, "--environment", "production", "--visibility", "plaintext", "--scope", "project", "--non-interactive"]);
    expect(envSet.every((x) => !x.cmd.join(" ").includes("expo_token") && x.env.EXPO_TOKEN === "expo_token_secret_value_1234567890")).toBe(true);
    expect(s.appConfig).toMatchObject({ easJson: "written", easEnv: "set" });

    // The build agent's ticket.
    const t = k.tickets.find((x) => x.source.key === BACKEND_KEY)!;
    expect(t.description).toContain("src/backend/supabase.ts");
    expect(t.description).toContain("enable row level security");
    expect(t.description).toContain("No secret or service key in the app");
    expect(t.description).toContain("-- day2:contract");
    expect(t.description).toContain("export type Database");
    expect(t.description).toContain("expo-apple-authentication");
    expect(s.backendTicket).toBe(t.id);
  });

  test("secrets are encrypted and never in the state; the second call reuses the project", async () => {
    const k = makeKit();
    const r = await ensureHosting(k.app, PLAN, { deps: k.deps });
    const files = all(join(k.data, "hosting"));
    expect(files).not.toContain("TOPSECRET");
    expect(files).not.toContain("smtp://");
    const state = JSON.stringify(await k.deps.store.state(k.app.id));
    expect(state).not.toContain("sb_secret_");
    expect(state).not.toContain("password");
    expect((await k.deps.secrets.get<{ key: string }>(k.app.id, "secret_key:production"))!.key).toBe(`sb_secret_${r.projectRef}_TOPSECRET`);
    expect((await k.deps.secrets.get<{ password: string }>(k.app.id, "db_password:production"))!.password.length).toBeGreaterThan(20);
    expect(readFileSync(join(k.repo, "eas.json"), "utf-8")).not.toContain("sb_secret_");

    const again = await ensureHosting(k.app, { ...PLAN, region: "us-east-1" }, { deps: k.deps });
    expect(again.projectRef).toBe(r.projectRef);
    expect(k.fake.calls.filter((c) => c.op === "createProject")).toHaveLength(1);
    expect((await k.deps.store.state(k.app.id)).plan!.region).toBe("eu-central-1");
  });

  test("a project still starting keeps its place; the next call carries on", async () => {
    const k = makeKit();
    k.deps.waitMs = 0;
    await expect(ensureHosting(k.app, PLAN, { deps: k.deps })).rejects.toThrow("still starting");
    const s = await k.deps.store.state(k.app.id);
    expect(s.done.production).toEqual(["project"]);
    expect(s.problem).toBeNull();
    k.deps.waitMs = 60_000;
    await ensureHosting(k.app, PLAN, { deps: k.deps });
    expect(k.fake.calls.filter((c) => c.op === "createProject")).toHaveLength(1);
  });

  test("a crash right after creating the project: the next run adopts it instead of making another", async () => {
    const k = makeKit();
    const store = k.deps.store;
    let failOnce = true;
    // The first save after createProject is lost (as if day2 stopped right then).
    k.deps.store = { state: (id) => store.state(id), update: async (id, fn) => {
      const copy = structuredClone(await store.state(id));
      const peek = fn(copy) ?? copy;
      if (failOnce && peek.projects.production && !(await store.state(id)).projects.production) {
        failOnce = false;
        throw new Error("day2 stopped");
      }
      return store.update(id, fn);
    } };
    await expect(ensureHosting(k.app, PLAN, { deps: k.deps })).rejects.toThrow("day2 stopped");
    const r = await ensureHosting(k.app, PLAN, { deps: k.deps });
    expect(k.fake.calls.filter((c) => c.op === "createProject")).toHaveLength(1);
    expect(r.projectRef).toBe([...k.fake.projects.keys()][0]!);
  });

  test("refused for apps that already have a backend, and without operator setup", async () => {
    const own = makeKit({ repo: makeRepo({ files: { "package.json": JSON.stringify({ dependencies: { expo: "54", firebase: "11" } }) } }) });
    rmSync(join(own.repo, "src", "backend"), { recursive: true });
    await expect(ensureHosting(own.app, PLAN, { deps: own.deps })).rejects.toThrow("already has a backend (Firebase)");
    const none = makeKit({ operator: null });
    await expect(ensureHosting(none.app, PLAN, { deps: none.deps })).rejects.toThrow("SUPABASE_ACCESS_TOKEN");
  });

  test("advisor findings become tickets; missing RLS is P1 and a security problem", async () => {
    const k = makeKit({ fake: { lints: { security: [lint("rls_disabled_in_public", "notes")], performance: [lint("unindexed_foreign_keys", "habits", "performance", "INFO")] } } });
    await ensureHosting(k.app, PLAN, { deps: k.deps });
    const t = k.tickets.find((x) => x.source.key?.startsWith("hosting:advisor:rls_disabled_in_public"))!;
    expect(t).toMatchObject({ title: "Turn on row level security: notes", priority: 1, type: "bug", signals: { security: true } });
    expect(k.tickets.some((x) => x.source.key?.includes("unindexed"))).toBe(false); // INFO only
    const s = await k.deps.store.state(k.app.id);
    expect(s.findings.find((f) => f.name === "rls_disabled_in_public")!.ticketId).toBe(t.id);
  });

  test("production refuses a table without RLS (P1 ticket) and doesn't run it", async () => {
    const k = makeKit({ repo: makeRepo({ rls: false }) });
    const r = await ensureHosting(k.app, PLAN, { deps: k.deps });
    expect(k.fake.migrations.get(r.projectRef)?.size ?? 0).toBe(0);
    const t = k.tickets.find((x) => x.source.key?.startsWith("hosting:migrations:"))!;
    expect(t.priority).toBe(1);
    expect(t.description).toContain('Table "habits" has no row level security');
    expect((await k.deps.store.state(k.app.id)).problem!.text).toContain("Database changes are waiting");
  });

  test("hostedBackendTicket is created once", async () => {
    const k = makeKit();
    await ensureHosting(k.app, PLAN, { deps: k.deps });
    const a = await hostedBackendTicket(k.app, k.deps);
    const b = await hostedBackendTicket(k.app, k.deps);
    expect(a.id).toBe(b.id);
    expect(k.tickets.filter((x) => x.source.key === BACKEND_KEY)).toHaveLength(1);
  });

  test("applyMigrations: a shared staging project when branching isn't available", async () => {
    const k = makeKit({ fake: { branching: false } });
    await ensureHosting(k.app, PLAN, { deps: k.deps });
    expect((await k.deps.store.state(k.app.id)).branching).toBe("unavailable");
    const r = await applyMigrations(k.app, "staging", { deps: k.deps });
    expect(r).toMatchObject({ env: "staging", pending: [], failed: null });
    const st = (await k.deps.store.state(k.app.id)).projects.staging!;
    expect([...k.fake.migrations.get(st.ref)!]).toEqual(["20261101120000"]);
    expect(st.name).toBe("habit-loop-apph-staging");
    expect(k.fake.auth.get(st.ref)!.uri_allow_list).toBe("habitloop://**,exp://**");

  });

  test("when the SQL endpoint is down, migrations go through `supabase db push` with the password kept out of errors", async () => {
    const opts: { sqlOutage?: boolean } = {};
    const k = makeKit({ fake: opts });
    await ensureHosting(k.app, PLAN, { deps: k.deps });
    writeFileSync(join(k.repo, "supabase/migrations/20261102090000_streaks.sql"), "alter table public.habits add column streak int default 0;\n");
    opts.sqlOutage = true;
    const { migrate } = await import("./provision");
    const r = await migrate(k.app, { env: "production" }, k.deps);
    expect(r).toMatchObject({ applied: ["20261102090000"], via: "cli", failed: null });
    const push = k.runs.find((x) => x.cmd.includes("db"))!;
    expect(push.cmd.slice(0, 5)).toEqual(["npx", "--yes", "supabase@2.122.1", "db", "push"]);
    const url = new URL(push.cmd[6]!);
    expect(url.port).toBe("5432");
    expect(decodeURIComponent(url.password)).toBe((await k.deps.secrets.get<{ password: string }>(k.app.id, "db_password:production"))!.password);
    expect(push.env.SUPABASE_ACCESS_TOKEN).toBeUndefined();
  });
});

describe("hostingPlanFrom (Create's product plan)", () => {
  test("accounts → email, Apple on iOS and Google; photo fields → a private bucket; chat → realtime", () => {
    const p = hostingPlanFrom({
      plan: { accounts: true, data: [{ name: "Habit", fields: ["name", "photo"], where: "server" }, { name: "Chat", fields: ["message"], where: "server" }, { name: "Settings", fields: ["theme"], where: "device" }] },
      ids: { scheme: "habitloop", bundleId: "com.habitloop" },
      platforms: ["ios", "android"],
      language: "de",
      audience: { countries: ["DE"] },
    });
    expect(p).toEqual({ language: "de", audience: { countries: ["DE"] }, auth: { email: true, apple: true, google: true }, buckets: [{ name: "uploads", public: false, maxBytes: 20 * 1024 * 1024 }], realtime: true, scheme: "habitloop", bundleId: "com.habitloop" });
    const q = hostingPlanFrom({ plan: { accounts: false, data: [] }, ids: { scheme: "x", bundleId: "a.b" }, platforms: ["android"] });
    expect(q.auth).toEqual({ email: false, apple: false, google: false });
    expect(q.buckets).toEqual([]);
  });
});
