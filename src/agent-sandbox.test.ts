import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { DENIED_ENV_VARS, DENIED_READ_PATHS, sandboxConfig } from "./agent-sandbox";

describe("sandboxConfig", () => {
  test("denies exactly the orchestrator's own secrets, in deny mode", () => {
    const config = sandboxConfig();
    const deniedNames = config.credentials.envVars.map((v) => v.name);
    expect(deniedNames).toEqual(DENIED_ENV_VARS);
    for (const entry of config.credentials.envVars) {
      expect(entry.mode).toBe("deny");
    }
  });

  test("denies read access to every credential-store path", () => {
    const config = sandboxConfig();
    expect(config.filesystem.denyRead).toEqual(DENIED_READ_PATHS);
  });

  test("denies the deploy credentials release.ts's wrangler calls rely on, not just Sentry/Anthropic", () => {
    // Regression: the sandbox was built to stop a hostile bug report from
    // exfiltrating this process's secrets, but the original pass only
    // covered the two sources it was built against (Sentry, Anthropic) —
    // missing CLOUDFLARE_API_TOKEN/~/.wrangler, which release.ts's `wrangler`
    // calls need in this exact same environment and are just as reachable.
    const config = sandboxConfig();
    expect(config.credentials.envVars.map((v) => v.name)).toContain("CLOUDFLARE_API_TOKEN");
    expect(config.filesystem.denyRead).toContain(`${homedir()}/.wrangler`);
  });

  test("fails loud rather than silently unsandboxed on an unsupported host", () => {
    const config = sandboxConfig();
    expect(config.enabled).toBe(true);
    expect(config.failIfUnavailable).toBe(true);
  });

  test("returns a fresh object each call — one caller can't mutate what another gets", () => {
    const a = sandboxConfig();
    const b = sandboxConfig();
    expect(a).not.toBe(b);
    expect(a.credentials).not.toBe(b.credentials);
    a.credentials.envVars.push({ name: "SOMETHING_ELSE", mode: "deny" });
    expect(b.credentials.envVars).toHaveLength(DENIED_ENV_VARS.length);
  });
});
