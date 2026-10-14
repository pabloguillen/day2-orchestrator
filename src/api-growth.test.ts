import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "./api-server";
import { OPTIMIZATIONS_FILENAME } from "./growth-optimizer";

/**
 * The growth endpoints that make day2's edge concrete, through the real
 * router in local mode: growth built into the app (loops → tickets),
 * experiments from ad to product, market research and connected tools.
 * No agent calls and no network.
 */

const ROOT = mkdtempSync(join(tmpdir(), "day2-api-growth-"));
const REPO = join(ROOT, "app");
const saved: Record<string, string | undefined> = {};
let appId = "";

async function call(method: string, path: string, body?: unknown) {
  const res = await handleRequest(
    new Request(`http://localhost:4700${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  for (const k of ["DAY2_APPS_REGISTRY_PATH", "DAY2_DATA_DIR", "DAY2_BACKLOG_TICK_MINUTES"]) saved[k] = process.env[k];
  process.env.DAY2_APPS_REGISTRY_PATH = join(ROOT, "apps.json");
  process.env.DAY2_DATA_DIR = ROOT;
  mkdirSync(join(REPO, "src"), { recursive: true });
  writeFileSync(join(REPO, "index.html"), '<meta property="og:title" content="Buddy">');
  writeFileSync(join(REPO, "src/App.tsx"), "export const App = () => null");
  execSync("git init -q", { cwd: REPO });
  const r = await call("POST", "/api/apps", { name: "buddy", repoPath: REPO, connectionMethod: "local_path" });
  expect(r.status).toBe(201);
  appId = r.body.app.id;
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(ROOT, { recursive: true, force: true });
});

describe("growth built into the app", () => {
  test("audit → build a missing one as a ticket (once)", async () => {
    const audit = await call("GET", `/api/apps/${appId}/growth/loops`);
    const byId = Object.fromEntries((audit.body.loops as Array<{ id: string }>).map((l) => [l.id, l]));
    expect(byId.share_preview).toMatchObject({ status: "present", evidence: "index.html" });
    expect(byId.referral).toMatchObject({ status: "missing", ticket: null });

    const built = await call("POST", `/api/apps/${appId}/growth/loops/referral/build`);
    expect(built.status).toBe(201);
    expect(built.body.ticket).toMatchObject({ type: "feature", state: "todo", source: { kind: "day2_proposal", key: "loop:referral" } });
    const again = await call("POST", `/api/apps/${appId}/growth/loops/referral/build`);
    expect(again.body.ticket.id).toBe(built.body.ticket.id);

    const backlog = await call("GET", `/api/apps/${appId}/backlog`);
    expect(backlog.body.tickets.filter((t: { source: { key?: string } }) => t.source.key === "loop:referral")).toHaveLength(1);
    expect((await call("POST", `/api/apps/${appId}/growth/loops/nope/build`)).status).toBe(404);
  });
});

describe("growth features made as good as the leading apps'", () => {
  test("the comparison shows per feature; a gap becomes a ticket (once)", async () => {
    writeFileSync(
      join(REPO, OPTIMIZATIONS_FILENAME),
      JSON.stringify({
        benchmarks: [
          {
            id: "bm-1",
            at: "2026-10-10T00:00:00Z",
            category: "bill-splitting apps",
            leaders: ["Splitwise"],
            loops: ["share_preview"],
            credits: 120,
            practices: [
              { id: "share_preview-balance", loopId: "share_preview", practice: "Preview shows the balance.", status: "missing", current: "Generic.", change: "Per-group preview.", impact: "high", leaders: [{ app: "Splitwise", example: "x", source: "https://example.com/s" }] },
              { id: "share_preview-image", loopId: "share_preview", practice: "1200×630 image.", status: "matches", current: "", change: "", impact: "low", leaders: [{ app: "Splitwise", example: "y", source: "https://example.com/s" }] },
            ],
          },
        ],
        improvements: [],
      }),
    );
    const audit = await call("GET", `/api/apps/${appId}/growth/loops`);
    expect(audit.body.benchmark).toMatchObject({ category: "bill-splitting apps", leaders: ["Splitwise"] });
    const byId = Object.fromEntries((audit.body.loops as Array<{ id: string; optimization: unknown }>).map((l) => [l.id, l]));
    expect(byId.share_preview?.optimization).toMatchObject({ matches: [{ practice: "1200×630 image." }], gaps: [{ id: "share_preview-balance", impact: "high" }], improvements: [] });
    expect(byId.referral?.optimization).toBeNull();

    const r = await call("POST", `/api/apps/${appId}/growth/loops/improve/share_preview-balance`);
    expect(r.status).toBe(201);
    expect(r.body.ticket).toMatchObject({ type: "improvement", source: { key: "loop:share_preview:opt:share_preview-balance" } });
    const again = await call("POST", `/api/apps/${appId}/growth/loops/improve/share_preview-balance`);
    expect(again.body.ticket.id).toBe(r.body.ticket.id);
    const sp = (again.body.loops as Array<{ id: string; optimization: { gaps: unknown[]; improvements: Array<{ ticket: { id: string } }> } }>).find((l) => l.id === "share_preview")!;
    expect(sp.optimization.gaps).toEqual([]);
    expect(sp.optimization.improvements).toHaveLength(1);
    expect((await call("POST", `/api/apps/${appId}/growth/loops/improve/share_preview-image`)).status).toBe(404);
  });
});

describe("experiments from ad to product", () => {
  test("create → the page becomes a ticket; stop", async () => {
    expect((await call("POST", `/api/apps/${appId}/growth/bets`, { title: "Fast" })).status).toBe(400);
    const r = await call("POST", `/api/apps/${appId}/growth/bets`, { title: "Split bills fast", angle: "Lead with speed", channel: "Reddit post", metric: "signup" });
    expect(r.status).toBe(201);
    const bet = r.body.bets[0];
    expect(bet).toMatchObject({ id: "B-1", status: "building", landingPath: "/go/split-bills-fast", link: null, ticket: { state: "todo" } });
    expect(bet.verdict.state).toBe("no_data");

    // With the app's address, the tracked link appears.
    await call("PATCH", `/api/apps/${appId}`, { appBaseUrl: "https://buddy.example" });
    const list = await call("GET", `/api/apps/${appId}/growth/bets`);
    expect(list.body.bets[0].link).toBe("https://buddy.example/go/split-bills-fast?d2=B-1");

    const stopped = await call("POST", `/api/apps/${appId}/growth/bets/B-1/stop`);
    expect(stopped.body.bets[0].status).toBe("stopped");
    expect((await call("POST", `/api/apps/${appId}/growth/bets/B-9/stop`)).status).toBe(404);
  });
});

describe("market research and connected tools", () => {
  test("research needs a scanned app; lists runs and whether Foreplay is connected", async () => {
    const r = await call("POST", `/api/apps/${appId}/growth/research`);
    expect(r.status).toBe(409);
    const g = await call("GET", `/api/apps/${appId}/growth/research`);
    expect(g.body).toEqual({ runs: [], researchToolConnected: false });
  });

  test("customers see the tools day2 runs; only the operator connects them (locally: the one operator)", async () => {
    const c = await call("GET", "/api/connectors");
    expect(c.body.tools.map((x: { id: string }) => x.id)).toEqual(["foreplay", "runway", "meta_ads"]);
    expect(c.body.tools[0]).toMatchObject({ active: false, uses: ["competitor_research"] });
    expect((await call("GET", "/api/platform/tools")).body.tools).toHaveLength(3);
    expect((await call("POST", "/api/platform/tools/nope/connect")).status).toBe(404);
  });
});
