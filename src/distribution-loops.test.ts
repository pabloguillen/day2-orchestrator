import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTicket, emptyBacklog } from "./backlog";
import { auditLoops, loopTicket, LOOPS } from "./distribution-loops";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "day2-loops-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const byId = (checks: ReturnType<typeof auditLoops>) => Object.fromEntries(checks.map((c) => [c.id, c]));

describe("growth built into the app", () => {
  test("a bare web app: everything missing, the mobile-only check doesn't apply", () => {
    const root = repo({ "package.json": '{"dependencies":{"react":"19"}}', "src/App.tsx": "export const App = () => <h1>Hi</h1>" });
    const c = byId(auditLoops(root, emptyBacklog()));
    for (const id of ["share_preview", "share_action", "referral", "seo_pages", "sitemap", "ai_findability"]) expect(c[id]!.status).toBe("missing");
    expect(c.review_prompt!.status).toBe("not_applicable");
  });

  test("finds real evidence and names the file", () => {
    const root = repo({
      "package.json": '{"dependencies":{"expo":"53"}}',
      "index.html": '<meta property="og:title" content="Buddy">',
      "src/share.ts": "await navigator.share({ url })",
      "src/invite.tsx": "const inviteLink = `${origin}/join/${code}`",
      "src/routes/guides/index.tsx": "export default function Guides() {}",
      "public/sitemap.xml": "<urlset/>",
      "public/llms.txt": "# Buddy",
      "src/review.ts": "StoreReview.requestReview()",
    });
    const c = byId(auditLoops(root, emptyBacklog()));
    expect(c.share_preview).toMatchObject({ status: "present", evidence: "index.html" });
    expect(c.share_action).toMatchObject({ status: "present", evidence: "src/share.ts" });
    expect(c.referral).toMatchObject({ status: "present", evidence: "src/invite.tsx" });
    expect(c.seo_pages!.status).toBe("present");
    expect(c.sitemap).toMatchObject({ status: "present", evidence: "public/sitemap.xml" });
    expect(c.ai_findability).toMatchObject({ status: "present", evidence: "public/llms.txt" });
    expect(c.review_prompt).toMatchObject({ status: "present", evidence: "src/review.ts" });
  });

  test("ignores dependencies, build output and tests", () => {
    const root = repo({
      "node_modules/x/index.js": "navigator.share({})",
      "dist/index.html": '<meta property="og:title">',
      "src/share.test.ts": "navigator.share({})",
    });
    const c = byId(auditLoops(root, emptyBacklog()));
    expect(c.share_action!.status).toBe("missing");
    expect(c.share_preview!.status).toBe("missing");
  });

  test("a missing loop becomes a day2 ticket, and the audit links it", () => {
    const root = repo({ "src/App.tsx": "" });
    const input = loopTicket("referral");
    expect(input).toMatchObject({ type: "feature", source: { kind: "day2_proposal", key: "loop:referral" }, priority: 2 });
    expect(input.doneWhen!.length).toBeGreaterThan(0);
    const { backlog, ticket } = createTicket(emptyBacklog(), input, new Date());
    expect(byId(auditLoops(root, backlog)).referral!.ticket).toEqual({ id: ticket.id, state: "todo" });
    // Every loop has a buildable ticket.
    for (const l of LOOPS) expect(loopTicket(l.id).title.length).toBeGreaterThan(10);
  });
});
