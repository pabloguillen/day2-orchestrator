import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import type { NewTicketInput, TicketState } from "../backlog";
import { fakeSupabase } from "./fake-supabase";
import type { Runner } from "./migrations";
import type { OperatorConfig } from "./operator";
import type { HostingDeps } from "./provision";
import { fileHostingSecrets, fileHostingStore } from "./store";
import type { HostingPlan } from "./types";

/** Tests only: an Expo app repo with Create's backend adapter, migrations and one edge function. */
export function makeRepo(o: { rls?: boolean; files?: Record<string, string> } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "day2-hosting-"));
  const w = (p: string, s: string) => {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), s);
  };
  w("package.json", JSON.stringify({ dependencies: { expo: "54.0.0", "react-native": "0.81.0" } }));
  w("app.json", JSON.stringify({ expo: { name: "Habit Loop", scheme: "habitloop", ios: { bundleIdentifier: "com.habitloop" }, android: { package: "com.habitloop" }, extra: { eas: { projectId: "p-1" } } } }));
  w("eas.json", JSON.stringify({ cli: { appVersionSource: "remote" }, build: { production: { autoIncrement: true, channel: "production" }, preview: { distribution: "internal" } } }));
  w("src/backend/index.ts", "export interface Backend {}\n");
  w(
    "supabase/migrations/20261101120000_habits.sql",
    `create table public.habits (id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid(), name text not null);\n${o.rls === false ? "" : "alter table public.habits enable row level security;\ncreate policy \"own\" on public.habits for all using ((select auth.uid()) = user_id);\n"}`,
  );
  w("supabase/functions/hello/index.ts", "Deno.serve(() => new Response('hi'))\n");
  w("supabase/functions/_shared/cors.ts", "export const cors = {}\n");
  w("supabase/functions/.env.example", "OPENAI_KEY=\nSUPABASE_URL=\n");
  for (const [p, s] of Object.entries(o.files ?? {})) w(p, s);
  return root;
}

export const PLAN: HostingPlan = { language: "de", audience: { countries: ["DE", "AT"] }, auth: { email: true, apple: true, google: false }, buckets: [{ name: "photos", public: false }], realtime: false, scheme: "habitloop", bundleId: "com.habitloop" };

export const OPERATOR: OperatorConfig = { token: "sbp_day2operatortoken0000000000000000", orgSlug: "day2-apps", smtp: { url: "smtp://mailer:pw@smtp.example.com:587", from: "no-reply@mail.day2.app" }, defaultRegion: "eu-central-1", instanceSize: "micro" };

export type Kit = ReturnType<typeof makeKit>;

export function makeKit(o: { fake?: Parameters<typeof fakeSupabase>[0]; operator?: OperatorConfig | null; repo?: string; now?: Date; expoToken?: string | null } = {}) {
  const repo = o.repo ?? makeRepo();
  const data = mkdtempSync(join(tmpdir(), "day2-hosting-data-"));
  const app: AppEntry = { id: "app_h", name: "Habit Loop", repoPath: repo, connectionMethod: "local_path", addedAt: "2026-10-01T00:00:00Z" };
  const fake = fakeSupabase(o.fake);
  const tickets: Array<NewTicketInput & { id: string; state: TicketState }> = [];
  const runs: Array<{ cmd: string[]; env: Record<string, string> }> = [];
  let now = o.now ?? new Date("2026-11-03T10:00:00Z");
  const run: Runner = async (cmd, opts) => {
    runs.push({ cmd, env: opts.env });
    return { code: 0, stdout: "", stderr: "" };
  };
  const deps: HostingDeps = {
    store: fileHostingStore(join(data, "hosting")),
    secrets: fileHostingSecrets(join(data, "hosting")),
    operator: o.operator === undefined ? OPERATOR : o.operator,
    api: fake.api,
    ticket: async (input) => {
      const have = tickets.find((t) => t.source.key === input.source.key);
      if (have) return { id: have.id, state: have.state };
      const t = { ...input, id: `D2-${tickets.length + 1}`, state: "todo" as TicketState };
      tickets.push(t);
      return { id: t.id, state: t.state };
    },
    run,
    expoToken: async () => (o.expoToken === undefined ? "expo_token_secret_value_1234567890" : o.expoToken),
    credits: { dir: join(data, "credits") },
    now: () => now,
    sleep: async () => undefined,
    waitMs: 60_000,
  };
  return { repo, data, app, fake, tickets, runs, deps, setNow: (d: Date) => (now = d) };
}
