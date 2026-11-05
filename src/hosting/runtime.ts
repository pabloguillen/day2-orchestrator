import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import { work } from "../backlog-cli";
import { createTicket, rankBacklog, withBacklog, type NewTicketInput } from "../backlog";
import { backlogFile } from "../backlog-work";
import { ensureLocalSecretsKey } from "../ads/connections";
import { dataDir } from "../day2-paths";
import { db } from "../db";
import { bunRunner } from "../mobile-release/eas";
import { gitEnv, releaseCredentials, runAsTenant, serverMode, type Tenant } from "../tenant";
import { hostingPass, type PassDeps, type PullRequest } from "./operations";
import { operatorConfig } from "./operator";
import type { HostingDeps } from "./provision";
import { dbHostingSecrets, dbHostingStore, fileHostingSecrets, fileHostingStore, type HostingSecrets, type HostingStore } from "./store";
import { supabaseApi } from "./supabase";

/**
 * Hosting's stores and real dependencies for the mode day2 runs in, and the
 * pass over every app on the backlog timer (api-server.ts).
 */

export function hostingStore(): HostingStore {
  return serverMode() === "accounts" ? dbHostingStore(db()) : fileHostingStore(join(dataDir(), "hosting"));
}

export function hostingSecrets(): HostingSecrets {
  if (serverMode() === "accounts") return dbHostingSecrets(db());
  ensureLocalSecretsKey(join(dataDir(), ".day2-secrets-key"));
  return fileHostingSecrets(join(dataDir(), "hosting"));
}

/** Creates a ticket once per source key; an open (or done) one with the same key is returned instead. */
export function ticketMaker(app: AppEntry) {
  return (input: NewTicketInput) =>
    withBacklog(backlogFile(app), (b) => {
      const have = b.tickets.find((t) => t.source.key === input.source.key && t.state !== "parked");
      if (have) return { backlog: b, result: { id: have.id, state: have.state } };
      const now = new Date();
      const r = createTicket(b, input, now);
      return { backlog: rankBacklog(r.backlog, now).backlog, result: { id: r.ticket.id, state: r.ticket.state } };
    });
}

export function hostingDeps(tenant: Tenant | null, app: AppEntry): HostingDeps {
  return {
    store: hostingStore(),
    secrets: hostingSecrets(),
    operator: operatorConfig(),
    api: (token) => supabaseApi(token),
    ticket: ticketMaker(app),
    run: bunRunner,
    expoToken: async () => (await releaseCredentials().get(app.id, "expo"))?.value.token ?? null,
    ...(tenant ? { credits: tenant.credits } : {}),
  };
}

/** Open pull requests that change supabase/, each with its supabase/ folder at the PR's head. */
export async function openBackendPrs(app: AppEntry): Promise<PullRequest[]> {
  const env = (await gitEnv()) as Record<string, string>;
  const r = await $`gh pr list --state open --json number,headRefOid,files --limit 30`.cwd(app.repoPath).env(env).quiet().nothrow();
  if (r.exitCode !== 0) return [];
  const prs = JSON.parse(r.stdout.toString() || "[]") as Array<{ number: number; headRefOid: string; files?: Array<{ path: string }> }>;
  const out: PullRequest[] = [];
  for (const pr of prs) {
    const touches = (pr.files ?? []).some((f) => f.path.startsWith("supabase/"));
    if (!touches) {
      out.push({ number: pr.number, dir: app.repoPath, touchesBackend: false, done: async () => undefined });
      continue;
    }
    const dir = mkdtempSync(join(tmpdir(), `day2-pr-${pr.number}-`));
    await $`git -C ${app.repoPath} fetch origin ${`pull/${pr.number}/head`}`.env(env).quiet().nothrow();
    const tar = await $`git -C ${app.repoPath} archive ${pr.headRefOid} supabase | tar -x -C ${dir}`.quiet().nothrow();
    if (tar.exitCode !== 0) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    out.push({ number: pr.number, dir, touchesBackend: true, done: async () => rmSync(dir, { recursive: true, force: true }) });
  }
  return out;
}

/** Every app with hosting: hourly health, daily usage and the rest (operations.ts). One app's failure never stops the rest. */
export async function hostingAll(): Promise<void> {
  if (!operatorConfig()) return;
  for (const { tenant, app } of await work()) {
    await runAsTenant(tenant, async () => {
      try {
        const deps: PassDeps = { ...hostingDeps(tenant, app), pullRequests: () => openBackendPrs(app) };
        if (!(await deps.store.state(app.id)).enabled) return;
        const r = await hostingPass(app, deps);
        if (r.skipped.length) console.warn(`[day2-hosting] ${app.name}: ${r.skipped.join("; ")}`);
      } catch (err) {
        console.error(`[day2-hosting] ${app.name}: ${(err as Error).message}`);
      }
    });
  }
}
