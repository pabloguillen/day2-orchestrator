import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createTestDatabase } from "../db/test-db";
import { dbGoogleSessions } from "./state";

/** The owner's Google token in Postgres: encrypted, bound to the row, gone after setup or an hour. */

let t: { url: string; sql: SQL; drop: () => Promise<void> };
const savedKey = process.env.DAY2_SECRETS_KEY;
beforeAll(async () => {
  process.env.DAY2_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
  t = await createTestDatabase();
  const [acc] = (await t.sql`INSERT INTO accounts (name) VALUES ('A') RETURNING id`) as Array<{ id: string }>;
  await t.sql`INSERT INTO apps (id, account_id, name, repo_path, connection_method) VALUES ('dotty', ${acc!.id}, 'Dotty', '/tmp/dotty', 'github')`;
});
afterAll(async () => {
  if (savedKey === undefined) delete process.env.DAY2_SECRETS_KEY;
  else process.env.DAY2_SECRETS_KEY = savedKey;
  await t?.drop();
});

test("start → single-use state → token (replacement returned) → end; expired rows purged with their tokens", async () => {
  const s = dbGoogleSessions(t.sql);
  const started = await s.start({ accountId: "acc", appId: "dotty", createdBy: "Pablo" });
  expect(started.verifier.length).toBeGreaterThan(40);
  expect((await s.consumeState(started.state))?.id).toBe(started.id);
  // A second callback with the same state is refused.
  expect(await s.consumeState(started.state)).toBeNull();
  expect(await s.setToken(started.id, { accessToken: "ya29.secret", expiresAt: Date.now() + 3_600_000, email: "p@example.com" })).toBeNull();
  const [row] = (await t.sql`SELECT secret FROM connect_google_sessions WHERE id = ${started.id}`) as Array<{ secret: string }>;
  expect(row!.secret).not.toContain("ya29");
  expect(row!.secret).not.toContain(started.verifier);
  const got = await s.get(started.id);
  expect(got?.token?.accessToken).toBe("ya29.secret");
  expect(got?.verifier).toBe(started.verifier);
  expect((await s.setToken(started.id, { accessToken: "ya29.new", expiresAt: Date.now() + 3_600_000, email: null }))?.accessToken).toBe("ya29.secret");
  expect((await s.end(started.id))?.accessToken).toBe("ya29.new");
  expect(await s.get(started.id)).toBeNull();

  const old = await s.start({ accountId: "acc", appId: "dotty", createdBy: null });
  await s.setToken(old.id, { accessToken: "ya29.old", expiresAt: Date.now(), email: null });
  await t.sql`UPDATE connect_google_sessions SET created_at = now() - interval '2 hours' WHERE id = ${old.id}`;
  expect(await s.get(old.id)).toBeNull();
  expect(await s.consumeState(old.state)).toBeNull();
  expect((await s.takeExpired()).map((x) => x.accessToken)).toEqual(["ya29.old"]);
  expect((await t.sql`SELECT count(*)::int AS n FROM connect_google_sessions`)[0].n).toBe(0);
});
