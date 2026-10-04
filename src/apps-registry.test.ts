import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addApp,
  findApp,
  hasGitRemote,
  loadAppsRegistry,
  removeApp,
  renderAppsSummary,
  saveAppsRegistry,
} from "./apps-registry";
import type { AppsRegistry } from "./apps-registry";

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "day2-apps-registry-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadAppsRegistry", () => {
  test("returns an empty registry when no file exists", () => {
    withTmpDir((dir) => {
      const registry = loadAppsRegistry(join(dir, ".day2-apps.json"));
      expect(registry).toEqual({ apps: [] });
    });
  });

  test("loads and round-trips a real registry file", () => {
    withTmpDir((dir) => {
      const path = join(dir, ".day2-apps.json");
      const registry: AppsRegistry = {
        apps: [
          {
            id: "app_abc123",
            name: "expense-buddy",
            repoPath: "/tmp/expense-buddy",
            connectionMethod: "local_path",
            addedAt: "2026-09-30T00:00:00.000Z",
          },
        ],
      };
      saveAppsRegistry(path, registry);
      expect(loadAppsRegistry(path)).toEqual(registry);
    });
  });

  test("throws on invalid JSON rather than silently overwriting", () => {
    withTmpDir((dir) => {
      const path = join(dir, ".day2-apps.json");
      writeFileSync(path, "not json");
      expect(() => loadAppsRegistry(path)).toThrow();
    });
  });

  test("throws on JSON that doesn't look like a registry", () => {
    withTmpDir((dir) => {
      const path = join(dir, ".day2-apps.json");
      writeFileSync(path, JSON.stringify({ foo: "bar" }));
      expect(() => loadAppsRegistry(path)).toThrow();
    });
  });
});

describe("addApp", () => {
  test("adds a new app with a generated id and timestamp", () => {
    withTmpDir((dir) => {
      const result = addApp(
        { apps: [] },
        { name: "expense-buddy", repoPath: dir, connectionMethod: "local_path" },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.app.id).toMatch(/^app_/);
      expect(result.app.name).toBe("expense-buddy");
      expect(result.app.repoPath).toBe(dir);
      expect(result.registry.apps).toHaveLength(1);
      expect(new Date(result.app.addedAt).toString()).not.toBe("Invalid Date");
    });
  });

  test("carries optional githubRepo/appBaseUrl through", () => {
    withTmpDir((dir) => {
      const result = addApp(
        { apps: [] },
        {
          name: "expense-buddy",
          repoPath: dir,
          connectionMethod: "github",
          githubRepo: "pabloguillen/expense-buddy",
          appBaseUrl: "https://expense-buddy.example.com",
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.app.githubRepo).toBe("pabloguillen/expense-buddy");
      expect(result.app.appBaseUrl).toBe("https://expense-buddy.example.com");
    });
  });

  test("fails closed when repoPath doesn't exist on disk", () => {
    const result = addApp(
      { apps: [] },
      { name: "ghost-app", repoPath: "/definitely/does/not/exist/anywhere", connectionMethod: "local_path" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/doesn't exist/);
  });

  test("fails closed on a repoPath already registered under a different app", () => {
    withTmpDir((dir) => {
      const first = addApp({ apps: [] }, { name: "expense-buddy", repoPath: dir, connectionMethod: "local_path" });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const second = addApp(first.registry, { name: "duplicate-name", repoPath: dir, connectionMethod: "local_path" });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.reason).toMatch(/already registered/);
      expect(second.reason).toContain("expense-buddy");
    });
  });

  describe("pricing-tier enforcement (docs/offering-logic.md — Starter: 1 app, Growth: 5 apps)", () => {
    test("no maxApps configured (the default) allows adding well past any real plan's tier size — unlimited", () => {
      withTmpDir((dir) => {
        const dirs = Array.from({ length: 10 }, (_, i) => `${dir}/app-${i}`);
        for (const d of dirs) mkdirSync(d);
        let registry: AppsRegistry = { apps: [] };
        for (const d of dirs) {
          const result = addApp(registry, { name: d, repoPath: d, connectionMethod: "local_path" });
          expect(result.ok).toBe(true);
          if (result.ok) registry = result.registry;
        }
        expect(registry.apps).toHaveLength(10);
      });
    });

    test("a Starter-tier cap of 1 allows exactly one app and rejects a second", () => {
      withTmpDir((dir) => {
        const dirA = `${dir}/a`;
        const dirB = `${dir}/b`;
        mkdirSync(dirA);
        mkdirSync(dirB);
        const first = addApp({ apps: [] }, { name: "first-app", repoPath: dirA, connectionMethod: "local_path" }, { maxApps: 1 });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const second = addApp(first.registry, { name: "second-app", repoPath: dirB, connectionMethod: "local_path" }, { maxApps: 1 });
        expect(second.ok).toBe(false);
        if (second.ok) return;
        expect(second.reason).toMatch(/allows up to 1 app/);
      });
    });

    test("a Growth-tier cap of 5 allows exactly up to 5 apps and rejects the 6th", () => {
      withTmpDir((dir) => {
        let registry: AppsRegistry = { apps: [] };
        for (let i = 0; i < 5; i++) {
          const d = `${dir}/app-${i}`;
          mkdirSync(d);
          const result = addApp(registry, { name: `app-${i}`, repoPath: d, connectionMethod: "local_path" }, { maxApps: 5 });
          expect(result.ok).toBe(true);
          if (result.ok) registry = result.registry;
        }
        expect(registry.apps).toHaveLength(5);

        const sixthDir = `${dir}/app-5`;
        mkdirSync(sixthDir);
        const sixth = addApp(registry, { name: "app-5", repoPath: sixthDir, connectionMethod: "local_path" }, { maxApps: 5 });
        expect(sixth.ok).toBe(false);
        if (sixth.ok) return;
        expect(sixth.reason).toMatch(/allows up to 5 apps/);
      });
    });

    test("the cap check doesn't mask the repoPath-exists check — that one still fires first", () => {
      const result = addApp(
        { apps: [{ id: "app_1", name: "x", repoPath: "/tmp/x", connectionMethod: "local_path", addedAt: "2026-01-01T00:00:00.000Z" }] },
        { name: "ghost", repoPath: "/definitely/does/not/exist/anywhere", connectionMethod: "local_path" },
        { maxApps: 1 },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/doesn't exist/);
    });
  });
});

describe("removeApp", () => {
  test("removes only the matching app, leaves others and the app's own repo untouched", () => {
    withTmpDir((dir) => {
      const added = addApp({ apps: [] }, { name: "expense-buddy", repoPath: dir, connectionMethod: "local_path" });
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      const next = removeApp(added.registry, added.app.id);
      expect(next.apps).toHaveLength(0);
      expect(existsSync(dir)).toBe(true);
    });
  });

  test("removing an unknown id is a no-op", () => {
    const registry: AppsRegistry = { apps: [] };
    expect(removeApp(registry, "app_nonexistent")).toEqual(registry);
  });
});

describe("findApp", () => {
  test("finds a registered app by id", () => {
    const registry: AppsRegistry = {
      apps: [{ id: "app_x", name: "x", repoPath: "/tmp/x", connectionMethod: "local_path", addedAt: "2026-01-01T00:00:00.000Z" }],
    };
    expect(findApp(registry, "app_x")?.name).toBe("x");
  });

  test("returns undefined for an unknown id", () => {
    expect(findApp({ apps: [] }, "app_missing")).toBeUndefined();
  });
});

describe("renderAppsSummary", () => {
  test("renders a plain-language empty state", () => {
    expect(renderAppsSummary({ apps: [] })).toBe("No apps connected yet.");
  });

  test("renders one line per app with its connection method", () => {
    const registry: AppsRegistry = {
      apps: [
        { id: "app_1", name: "expense-buddy", repoPath: "/tmp/eb", connectionMethod: "github", addedAt: "2026-01-01T00:00:00.000Z" },
      ],
    };
    const summary = renderAppsSummary(registry);
    expect(summary).toContain("expense-buddy");
    expect(summary).toContain("app_1");
    expect(summary).toContain("github");
  });
});

describe("hasGitRemote", () => {
  test("returns false for a path that doesn't exist", () => {
    expect(hasGitRemote("/definitely/does/not/exist/anywhere")).toBe(false);
  });

  test("returns false for a real directory with no git remote configured", () => {
    withTmpDir((dir) => {
      execSync("git init -q", { cwd: dir });
      expect(hasGitRemote(dir)).toBe(false);
    });
  });

  test("returns true for a real directory with a git remote configured", () => {
    withTmpDir((dir) => {
      execSync("git init -q", { cwd: dir });
      execSync("git remote add origin https://github.com/example/example.git", { cwd: dir });
      expect(hasGitRemote(dir)).toBe(true);
    });
  });
});
