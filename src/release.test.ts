import { describe, expect, test, afterEach, mock } from "bun:test";
import { evaluateGuardrail, fetchCanaryErrorCount } from "./release";

describe("evaluateGuardrail", () => {
  test("zero errors against the default zero-tolerance threshold promotes", () => {
    const result = evaluateGuardrail(0);
    expect(result.decision).toBe("promote");
  });

  test("a single error against the default zero-tolerance threshold rolls back", () => {
    const result = evaluateGuardrail(1);
    expect(result.decision).toBe("rollback");
    expect(result.reason).toContain("1 canary-tagged error");
  });

  test("errors at or below a raised threshold promote", () => {
    expect(evaluateGuardrail(0, 5).decision).toBe("promote");
    expect(evaluateGuardrail(5, 5).decision).toBe("promote");
  });

  test("errors above a raised threshold roll back", () => {
    expect(evaluateGuardrail(6, 5).decision).toBe("rollback");
  });

  test("reason strings always mention the observed count and threshold", () => {
    const promoted = evaluateGuardrail(2, 5);
    expect(promoted.reason).toContain("2");
    expect(promoted.reason).toContain("5");
    const rolledBack = evaluateGuardrail(9, 5);
    expect(rolledBack.reason).toContain("9");
    expect(rolledBack.reason).toContain("5");
  });
});

describe("fetchCanaryErrorCount", () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.SENTRY_AUTH_TOKEN;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.SENTRY_AUTH_TOKEN = originalToken;
  });

  test("sums event counts across matching issues", async () => {
    process.env.SENTRY_AUTH_TOKEN = "test-token";
    globalThis.fetch = mock(async (url: string) => {
      expect(String(url)).toContain("release%3Aabc123");
      return new Response(JSON.stringify([{ count: "3" }, { count: "2" }]), { status: 200 });
    }) as unknown as typeof fetch;

    const count = await fetchCanaryErrorCount("org", "project", "abc123");
    expect(count).toBe(5);
  });

  test("returns 0 when no issues match", async () => {
    process.env.SENTRY_AUTH_TOKEN = "test-token";
    globalThis.fetch = mock(async () => new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch;

    const count = await fetchCanaryErrorCount("org", "project", "no-errors-sha");
    expect(count).toBe(0);
  });

  test("throws on a non-ok Sentry response rather than silently treating it as clean", async () => {
    process.env.SENTRY_AUTH_TOKEN = "test-token";
    globalThis.fetch = mock(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    await expect(fetchCanaryErrorCount("org", "project", "sha")).rejects.toThrow(/Sentry API error 500/);
  });

  test("throws without a Sentry token rather than silently skipping the guardrail", async () => {
    process.env.SENTRY_AUTH_TOKEN = "";
    await expect(fetchCanaryErrorCount("org", "project", "sha")).rejects.toThrow(/SENTRY_AUTH_TOKEN/);
  });
});
