import { describe, expect, test } from "bun:test";
import { childEnv, createEas, EasError, parseJsonOutput, runtimePolicyOf, type Runner } from "./eas";

const TOKEN = "expo_tok_SECRET_0123456789abcdef";
const WD = "/app/managed-repos/buddy";

type Call = { cmd: string[]; cwd: string; env: Record<string, string> };
type Reply = { code?: number; stdout?: string; stderr?: string } | ((c: Call) => { code?: number; stdout?: string; stderr?: string });

/** A scripted runner: answers each call in order; extra calls fail the test. */
function fake(...replies: Reply[]) {
  const calls: Call[] = [];
  const run: Runner = async (cmd, o) => {
    const c = { cmd, cwd: o.cwd, env: o.env };
    calls.push(c);
    const r = replies.shift();
    if (!r) throw new Error(`unexpected call: ${cmd.join(" ")}`);
    const v = typeof r === "function" ? r(c) : r;
    return { code: v.code ?? 0, stdout: v.stdout ?? "", stderr: v.stderr ?? "" };
  };
  return { run, calls };
}

const make = (...replies: Reply[]) => {
  const f = fake(...replies);
  return { eas: createEas({ token: TOKEN }, { run: f.run, bin: "eas" }), calls: f.calls };
};

const json = (v: unknown) => ({ stdout: JSON.stringify(v, null, 2) });

function expectEasEnv(c: Call) {
  expect(c.env.EXPO_TOKEN).toBe(TOKEN);
  expect(c.env.CI).toBe("1");
  expect(c.env.EXPO_NO_TELEMETRY).toBe("1");
  expect(c.env.EAS_NO_VCS).toBeUndefined();
  expect(c.cmd.join(" ")).not.toContain(TOKEN);
  expect(c.cwd).toBe(WD);
}

async function rejection(p: Promise<unknown>): Promise<EasError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(EasError);
    return e as EasError;
  }
  throw new Error("expected a rejection");
}

describe("parseJsonOutput", () => {
  test("plain JSON", () => expect(parseJsonOutput('{"a":1}')).toEqual({ a: 1 }));
  test("leading noise lines, including brackets that aren't JSON", () => {
    const out = '★ eas-cli@28.0.0 is now available.\n[warn] Something {odd}\n[\n  {"id": "b1"}\n]\n';
    expect(parseJsonOutput(out)).toEqual([{ id: "b1" }]);
  });
  test("trailing noise", () => expect(parseJsonOutput('{"hash":"abc"}\nDone in 2s')).toEqual({ hash: "abc" }));
  test("ANSI colours", () => expect(parseJsonOutput('\u001b[33mwarning\u001b[39m\n{"x":true}')).toEqual({ x: true }));
  test("no JSON", () => expect(() => parseJsonOutput("nothing here")).toThrow());
});

describe("environment", () => {
  test("only allowlisted variables reach the child; day2's secrets don't", () => {
    const env = childEnv(TOKEN, { PATH: "/usr/bin", HOME: "/home/bun", DAY2_SECRETS_KEY: "k", GITHUB_TOKEN: "g", HTTPS_PROXY: "http://p" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/bun", HTTPS_PROXY: "http://p", CI: "1", EXPO_NO_TELEMETRY: "1", EXPO_TOKEN: TOKEN });
  });
  test("expo CLI commands don't get the token", () => {
    expect(childEnv(null, { PATH: "/x" }).EXPO_TOKEN).toBeUndefined();
  });
  test("default bin is eas on PATH, else a pinned npx eas-cli", async () => {
    const f = fake(json({ hash: "h" }));
    await createEas({ token: TOKEN }, { run: f.run }).fingerprint(WD, "ios");
    const head = f.calls[0]!.cmd.slice(0, Bun.which("eas") ? 1 : 3);
    expect(head).toEqual(Bun.which("eas") ? ["eas"] : ["npx", "--yes", "eas-cli@27.2.0"]);
  });
});

describe("appConfig", () => {
  test("argv, env and fields", async () => {
    const { eas, calls } = make({
      stdout:
        "Some warning from a config plugin\n" +
        JSON.stringify({ name: "Buddy", version: "1.4.0", runtimeVersion: { policy: "fingerprint" }, updates: { url: "https://u.expo.dev/abc" }, ios: { bundleIdentifier: "com.buddy.app" }, android: { package: "com.buddy.app" } }),
    });
    expect(await eas.appConfig(WD)).toEqual({ version: "1.4.0", bundleId: "com.buddy.app", packageName: "com.buddy.app", runtimePolicy: "fingerprint", hasUpdates: true });
    expect(calls[0]!.cmd).toEqual(["npx", "--no", "expo", "config", "--json", "--type", "public"]);
    expect(calls[0]!.cwd).toBe(WD);
    expect(calls[0]!.env.CI).toBe("1");
    expect(calls[0]!.env.EXPO_TOKEN).toBeUndefined();
  });
  test("fixed string runtime version, platform override, no updates", async () => {
    const { eas } = make(json({ version: "2.0.0", ios: { runtimeVersion: "2.0" } }));
    expect(await eas.appConfig(WD)).toEqual({ version: "2.0.0", bundleId: null, packageName: null, runtimePolicy: "custom", hasUpdates: false });
  });
  test("runtimePolicyOf", () => {
    expect(runtimePolicyOf("1.0.0")).toBe("custom");
    expect(runtimePolicyOf({ policy: "appVersion" })).toBe("appVersion");
    expect(runtimePolicyOf(undefined)).toBeNull();
  });
});

test("runtimeVersion", async () => {
  const { eas, calls } = make(json({ runtimeVersion: "1.4.0", fingerprintSources: null }), json({}));
  expect(await eas.runtimeVersion(WD, "android")).toBe("1.4.0");
  expect(calls[0]!.cmd).toEqual(["npx", "--no", "expo-updates", "runtimeversion:resolve", "--platform", "android"]);
  expect(await eas.runtimeVersion(WD, "ios")).toBeNull();
});

test("fingerprint", async () => {
  const f = fake(json({ hash: "9f8e7d", sources: [] }));
  const eas = createEas({ token: TOKEN }, { run: f.run, bin: "eas", environment: "preview" });
  expect(await eas.fingerprint(WD, "ios")).toBe("9f8e7d");
  expect(f.calls[0]!.cmd).toEqual(["eas", "fingerprint:generate", "--platform", "ios", "--environment", "preview", "--json", "--non-interactive"]);
  expectEasEnv(f.calls[0]!);
});

describe("latestStoreBuild", () => {
  const build = { id: "b1", status: "FINISHED", platform: "IOS", appVersion: "1.4.0", appBuildVersion: "42", runtime: { version: "rv1" }, fingerprint: { hash: "fp" }, gitCommitHash: "abc123", buildProfile: "production", distribution: "STORE" };
  test("argv and mapping", async () => {
    const { eas, calls } = make(json([build]));
    expect(await eas.latestStoreBuild(WD, { platform: "ios", profile: "production" })).toEqual({ id: "b1", runtimeVersion: "rv1", appVersion: "1.4.0", buildNumber: "42", gitCommit: "abc123" });
    expect(calls[0]!.cmd).toEqual(["eas", "build:list", "--platform", "ios", "--status", "finished", "--distribution", "store", "--build-profile", "production", "--limit", "1", "--json", "--non-interactive"]);
    expectEasEnv(calls[0]!);
  });
  test("non-store builds don't count; none → null", async () => {
    const { eas } = make(json([{ ...build, distribution: "INTERNAL" }]), json([]));
    expect(await eas.latestStoreBuild(WD, { platform: "ios", profile: "production" })).toBeNull();
    expect(await eas.latestStoreBuild(WD, { platform: "android", profile: "production" })).toBeNull();
  });
  test("missing (null-stripped) fields", async () => {
    const { eas } = make(json([{ id: "b2", distribution: "STORE" }]));
    expect(await eas.latestStoreBuild(WD, { platform: "android", profile: "production" })).toEqual({ id: "b2", runtimeVersion: null, appVersion: null, buildNumber: null, gitCommit: null });
  });
});

describe("publishUpdate", () => {
  const out = [
    { id: "u-ios", group: "g1", branch: "production", platform: "ios", runtimeVersion: "rv1" },
    { id: "u-and", group: "g1", branch: "production", platform: "android", runtimeVersion: "rv1" },
  ];
  test("a partial rollout", async () => {
    const { eas, calls } = make(json(out));
    expect(await eas.publishUpdate(WD, { branch: "production", message: "Fix login", percent: 10 })).toEqual({ groupId: "g1", updateIds: { ios: "u-ios", android: "u-and" }, runtimeVersion: "rv1" });
    expect(calls[0]!.cmd).toEqual(["eas", "update", "--branch", "production", "--message", "Fix login", "--platform", "all", "--environment", "production", "--json", "--non-interactive", "--rollout-percentage", "10"]);
    expectEasEnv(calls[0]!);
  });
  test("everyone: no rollout flag", async () => {
    const { eas, calls } = make(json(out));
    await eas.publishUpdate(WD, { branch: "production", message: "m", percent: 100 });
    expect(calls[0]!.cmd).not.toContain("--rollout-percentage");
  });
  test("another rollout active → clear error, no forced retry", async () => {
    const { eas, calls } = make({ code: 1, stderr: "A rollout is in progress for runtime version rv1:\nError: Cannot start a rollout while another rollout is in progress. Only one rollout ..." });
    const e = await rejection(eas.publishUpdate(WD, { branch: "production", message: "m", percent: 5 }));
    expect(e.kind).toBe("rollout_active");
    expect(e.message).toContain('already rolling out on branch "production"');
    expect(calls).toHaveLength(1);
  });
  test("invalid percent", async () => {
    const { eas, calls } = make();
    await rejection(eas.publishUpdate(WD, { branch: "b", message: "m", percent: 0 }));
    await rejection(eas.publishUpdate(WD, { branch: "b", message: "m", percent: 12.5 }));
    expect(calls).toHaveLength(0);
  });
});

describe("setRollout", () => {
  test("argv", async () => {
    const { eas, calls } = make(json([]));
    await eas.setRollout(WD, { branch: "production", groupId: "g1", percent: 50 });
    expect(calls[0]!.cmd).toEqual(["eas", "update:edit", "g1", "--rollout-percentage", "50", "--non-interactive", "--json"]);
    expectEasEnv(calls[0]!);
  });
  test("finishing an update that's no longer a rollout is a no-op", async () => {
    const { eas } = make({ code: 1, stderr: "Error: Cannot edit rollout percentage on update group that is not a rollout." });
    await eas.setRollout(WD, { branch: "production", groupId: "g1", percent: 100 });
  });
  test("lowering fails readably", async () => {
    const { eas } = make({ code: 1, stderr: "Error: Rollout percentage must be greater than previous rollout percentage (50)" });
    const e = await rejection(eas.setRollout(WD, { branch: "production", groupId: "g1", percent: 20 }));
    expect(e.message).toContain("`eas update:edit` failed (exit 1)");
    expect(e.message).toContain("greater than previous rollout percentage (50)");
  });
});

describe("revert", () => {
  test("reverts the rollout", async () => {
    const { eas, calls } = make({ stdout: "Reverted" });
    await eas.revert(WD, { branch: "production", groupId: "g1" });
    expect(calls[0]!.cmd).toEqual(["eas", "update:revert-update-rollout", "--group", "g1", "--non-interactive", "--message", "Rolled back by day2"]);
    expectEasEnv(calls[0]!);
    expect(calls).toHaveLength(1);
  });
  test("not in a rollout any more → update:rollback", async () => {
    const { eas, calls } = make({ code: 1, stderr: 'Error: The update group with ID "g1" is not a rollout update group.' }, { stdout: "ok" });
    await eas.revert(WD, { branch: "production", groupId: "g1" });
    expect(calls[1]!.cmd).toEqual(["eas", "update:rollback", "g1", "--non-interactive", "--message", "Rolled back by day2"]);
    expectEasEnv(calls[1]!);
  });
  test("rollback refused because a newer update exists", async () => {
    const { eas } = make(
      { code: 1, stderr: 'The update group with ID "g1" is not a rollout update group.' },
      { code: 1, stderr: 'Error: Update group "g1" is not the latest update on branch "production" for runtime version "rv1" (the latest is "g2"). Only the latest update can be rolled back.' },
    );
    const e = await rejection(eas.revert(WD, { branch: "production", groupId: "g1" }));
    expect(e.kind).toBe("not_latest");
    expect(e.message).toContain("a newer update was published");
  });
  test("other failures don't fall back", async () => {
    const { eas, calls } = make({ code: 1, stderr: "Error: network down" });
    await rejection(eas.revert(WD, { branch: "production", groupId: "g1" }));
    expect(calls).toHaveLength(1);
  });
});

describe("build", () => {
  test("argv and id", async () => {
    const { eas, calls } = make(json([{ id: "build-1", status: "NEW", platform: "IOS" }]));
    expect(await eas.build(WD, { platform: "ios", profile: "production", message: "day2 release 1.4.0" })).toEqual({ id: "build-1" });
    expect(calls[0]!.cmd).toEqual(["eas", "build", "--platform", "ios", "--profile", "production", "--non-interactive", "--no-wait", "--json", "--message", "day2 release 1.4.0"]);
    expectEasEnv(calls[0]!);
  });
  test("missing credentials in plain words", async () => {
    const { eas } = make({ code: 1, stderr: "Distribution Certificate is not validated for non-interactive builds.\nError: Credentials are not set up. Run this command again in interactive mode." });
    const e = await rejection(eas.build(WD, { platform: "ios", profile: "production", message: "m" }));
    expect(e.kind).toBe("credentials");
    expect(e.message).toContain("Run eas build once on your computer so EAS stores the signing credentials");
  });
});

describe("build_status", () => {
  const cases: Array<[string, string]> = [
    ["NEW", "queued"],
    ["IN_QUEUE", "queued"],
    ["IN_PROGRESS", "in_progress"],
    ["PENDING_CANCEL", "in_progress"],
    ["FINISHED", "finished"],
    ["ERRORED", "errored"],
    ["CANCELED", "canceled"],
  ];
  test("status mapping, in the checkout that started the build", async () => {
    const { eas, calls } = make(json([{ id: "b1" }]), ...cases.map(([s]) => json({ id: "b1", status: s, appVersion: "1.4.0", appBuildVersion: "42" })));
    await eas.build(WD, { platform: "android", profile: "production", message: "m" });
    for (const [, want] of cases) expect((await eas.build_status("b1")).status).toBe(want as never);
    expect(calls[1]!.cmd).toEqual(["eas", "build:view", "b1", "--json"]);
    expectEasEnv(calls[1]!);
  });
  test("fields and error", async () => {
    const { eas } = make(json([{ id: "b1" }]), json({ id: "b1", status: "ERRORED", appVersion: "1.4.0", appBuildVersion: "42", error: { errorCode: "X", message: "Gradle failed" } }));
    await eas.build(WD, { platform: "android", profile: "production", message: "m" });
    expect(await eas.build_status("b1")).toEqual({ status: "errored", buildNumber: "42", appVersion: "1.4.0", error: "Gradle failed" });
  });
  test("no checkout known (after a restart) → EAS GraphQL API", async () => {
    const seen: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const fetchFake = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ data: { builds: { byId: { id: "b9", status: "IN_PROGRESS", appVersion: "1.4.0", appBuildVersion: null } } } }));
    }) as unknown as typeof fetch;
    const f = fake();
    const eas = createEas({ token: TOKEN }, { run: f.run, bin: "eas", fetch: fetchFake });
    expect(await eas.build_status("b9")).toEqual({ status: "in_progress", buildNumber: null, appVersion: "1.4.0", error: null });
    expect(seen[0]!.url).toBe("https://api.expo.dev/graphql");
    expect(seen[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect((seen[0]!.body as { variables: unknown }).variables).toEqual({ buildId: "b9" });
    expect(f.calls).toHaveLength(0);
  });
});

describe("submit", () => {
  const url = "https://expo.dev/accounts/buddy/projects/buddy/submissions/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
  test("argv (no --json) and the id from the printed URL", async () => {
    const { eas, calls } = make({ stdout: `✔ Scheduled iOS submission\n\nSubmission details: \u001b[2m\u001b[4m${url}\u001b[24m\u001b[22m\n` });
    expect(await eas.submit(WD, { platform: "ios", buildId: "b1", profile: "production" })).toEqual({ id: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b" });
    expect(calls[0]!.cmd).toEqual(["eas", "submit", "--platform", "ios", "--id", "b1", "--profile", "production", "--non-interactive", "--no-wait"]);
    expect(calls[0]!.cmd).not.toContain("--json");
    expectEasEnv(calls[0]!);
  });
  test("no URL in the output → submit:list", async () => {
    const { eas, calls } = make({ stdout: "Scheduled" }, json([{ id: "s-latest", status: "IN_QUEUE", platform: "ANDROID" }]));
    expect(await eas.submit(WD, { platform: "android", buildId: "b1", profile: "production" })).toEqual({ id: "s-latest" });
    expect(calls[1]!.cmd).toEqual(["eas", "submit:list", "--platform", "android", "--limit", "1", "--json", "--non-interactive"]);
  });
  test("missing upload credentials", async () => {
    const { eas } = make({ code: 1, stderr: "Error: Google Service Account Keys cannot be set up in --non-interactive mode." });
    const e = await rejection(eas.submit(WD, { platform: "android", buildId: "b1", profile: "production" }));
    expect(e.kind).toBe("credentials");
    expect(e.message).toContain("Run eas submit once on your computer");
  });
});

describe("submit_status", () => {
  const cases: Array<[string, string]> = [
    ["AWAITING_BUILD", "in_queue"],
    ["IN_QUEUE", "in_queue"],
    ["IN_PROGRESS", "in_progress"],
    ["FINISHED", "finished"],
    ["ERRORED", "errored"],
    ["CANCELED", "canceled"],
  ];
  test("mapping and argv", async () => {
    const { eas, calls } = make({ stdout: "/submissions/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b" }, ...cases.map(([s]) => json({ id: "x", status: s })), json({ status: "ERRORED", error: { message: "Invalid binary" } }));
    const { id } = await eas.submit(WD, { platform: "ios", buildId: "b1", profile: "production" });
    for (const [, want] of cases) expect((await eas.submit_status(id)).status).toBe(want as never);
    expect(await eas.submit_status(id)).toEqual({ status: "errored", error: "Invalid binary" });
    expect(calls[1]!.cmd).toEqual(["eas", "submit:view", id, "--json"]);
  });
});

describe("errors", () => {
  test("readable, last stderr lines, token redacted", async () => {
    const stderr = [...Array.from({ length: 30 }, (_, i) => `log line ${i}`), `Error: request failed with token ${TOKEN}`, "    at somewhere"].join("\n");
    const { eas } = make({ code: 1, stdout: `debug ${TOKEN}`, stderr });
    const e = await rejection(eas.fingerprint(WD, "ios"));
    expect(e.message).toContain("`eas fingerprint:generate` failed (exit 1)");
    expect(e.message).toContain("Error: request failed with token [redacted]");
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).not.toContain("log line 0\n");
  });
  test("spawn failure is redacted too", async () => {
    const run: Runner = async () => {
      throw new Error(`spawn failed EXPO_TOKEN=${TOKEN}`);
    };
    const e = await rejection(createEas({ token: TOKEN }, { run, bin: "eas" }).fingerprint(WD, "ios"));
    expect(e.message).not.toContain(TOKEN);
  });
  test("no JSON on success", async () => {
    const { eas } = make({ stdout: "Fingerprint generated" });
    const e = await rejection(eas.fingerprint(WD, "android"));
    expect(e.kind).toBe("bad_output");
  });
  test("the token is never put on a command line", async () => {
    const { eas, calls } = make();
    await rejection(eas.publishUpdate(WD, { branch: "b", message: `oops ${TOKEN}`, percent: 100 }));
    expect(calls).toHaveLength(0);
  });
});
