import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { assertZipEntriesAreContained, handleRequest } from "./api-server";

/**
 * This file only existed as untested code until now — importing it used to
 * start a real `Bun.serve()` as a side effect (fixed: see the
 * `import.meta.main` guard in api-server.ts). These tests call
 * `handleRequest` directly (a plain `Request -> Response` function, no port
 * binding) and avoid any route that would mutate the real, local
 * `.day2-apps.json` — this suite must be safe to run against a developer's
 * actual machine state, not just CI.
 */

describe("handleRequest — router mechanics", () => {
  test("OPTIONS preflight returns 204 with CORS headers scoped to the console's origin, not a wildcard", async () => {
    const res = await handleRequest(new Request("http://localhost:4700/api/apps", { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    const origin = res.headers.get("access-control-allow-origin");
    expect(origin).not.toBe("*");
    expect(origin).toBe("http://localhost:3000");
  });

  test("every response carries the scoped CORS header, including error responses", async () => {
    const res = await handleRequest(new Request("http://localhost:4700/api/not-a-real-route"));
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });

  test("unknown route returns a 404 with a JSON error body", async () => {
    const res = await handleRequest(new Request("http://localhost:4700/api/not-a-real-route"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/No route for/);
  });

  test("a real route with the wrong HTTP method falls through to 404, not a method-not-allowed crash", async () => {
    const res = await handleRequest(new Request("http://localhost:4700/api/apps", { method: "PATCH" }));
    expect(res.status).toBe(404);
  });

  test("GET /api/apps returns real registry data with the expected shape (read-only, doesn't assert content)", async () => {
    const res = await handleRequest(new Request("http://localhost:4700/api/apps"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.apps)).toBe(true);
    expect(typeof body.summary).toBe("string");
  });

  test("GET /api/operator returns a non-empty operator name", async () => {
    const res = await handleRequest(new Request("http://localhost:4700/api/operator"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.name).toBe("string");
    expect(body.name.length).toBeGreaterThan(0);
  });

  test("POST /api/apps/:id/ask 404s for an unknown app before any agent call", async () => {
    const res = await handleRequest(
      new Request("http://localhost:4700/api/apps/definitely-not-a-real-id/ask", {
        method: "POST",
        body: JSON.stringify({ question: "What shipped?" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("a route needing a real app ID 404s cleanly for an ID that doesn't exist, without touching the registry", async () => {
    const res = await handleRequest(new Request("http://localhost:4700/api/apps/definitely-not-a-real-id/releases"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/No app registered/);
  });
});

describe("assertZipEntriesAreContained — zip-slip hardening", () => {
  function tempDirs() {
    const workDir = mkdtempSync(join(tmpdir(), "day2-zip-test-"));
    const destDir = join(workDir, "dest");
    return { workDir, destDir };
  }

  test("rejects a zip entry that traverses outside the destination directory", async () => {
    const { workDir, destDir } = tempDirs();
    const zipPath = join(workDir, "evil.zip");
    writeFileSync(
      join(workDir, "make_evil.py"),
      "import zipfile\n" +
        `with zipfile.ZipFile(${JSON.stringify(zipPath)}, "w") as z:\n` +
        '    z.writestr("../../escaped.txt", "pwned")\n',
    );
    await $`python3 ${join(workDir, "make_evil.py")}`.quiet();

    await expect(assertZipEntriesAreContained(zipPath, destDir)).rejects.toThrow(/would extract outside/);
  });

  test("rejects a zip entry with an absolute path", async () => {
    const { workDir, destDir } = tempDirs();
    const zipPath = join(workDir, "evil-absolute.zip");
    writeFileSync(
      join(workDir, "make_evil_abs.py"),
      "import zipfile\n" +
        `with zipfile.ZipFile(${JSON.stringify(zipPath)}, "w") as z:\n` +
        '    zi = zipfile.ZipInfo("/tmp/escaped-absolute.txt")\n' +
        '    z.writestr(zi, "pwned")\n',
    );
    await $`python3 ${join(workDir, "make_evil_abs.py")}`.quiet();

    await expect(assertZipEntriesAreContained(zipPath, destDir)).rejects.toThrow(/absolute path/);
  });

  test("accepts a benign zip whose entries all land inside the destination directory", async () => {
    const { workDir, destDir } = tempDirs();
    const zipPath = join(workDir, "good.zip");
    writeFileSync(
      join(workDir, "make_good.py"),
      "import zipfile\n" +
        `with zipfile.ZipFile(${JSON.stringify(zipPath)}, "w") as z:\n` +
        '    z.writestr("src/index.ts", "console.log(1)")\n' +
        '    z.writestr("package.json", "{}")\n',
    );
    await $`python3 ${join(workDir, "make_good.py")}`.quiet();

    await expect(assertZipEntriesAreContained(zipPath, destDir)).resolves.toBeUndefined();
  });
});
