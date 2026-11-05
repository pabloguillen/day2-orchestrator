import type { AppEntry } from "../apps-registry";
import { appliedVersions, applyPending, readMigrations } from "./migrations";
import { apiFor, ensureEnv, HostingError, log, migrate, resumeEnv, typesAfter, type HostingDeps } from "./provision";
import type { Preview } from "./types";

/**
 * Environments:
 *  - production: one Supabase project per app;
 *  - pull requests: a preview database per PR through Supabase branching
 *    when day2's organization has it (paid plans), else one shared
 *    "staging" project per app;
 *  - releases: production migrations are applied just before the
 *    over-the-air update or store build that needs them, and only after
 *    they passed on a preview or staging.
 */

const nowOf = (d: HostingDeps) => (d.now ? d.now() : new Date());
const sleepOf = (d: HostingDeps) => d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
/** pr 0 is day2's own check before a release. */
export const RELEASE_CHECK_PR = 0;

/**
 * The PR's migrations on a database of their own (or staging). `dir` is a
 * checkout of the PR's head. Waits for a new branch up to `waitMs`; if it's
 * still starting, the preview stays "pending" and the next pass carries on.
 */
export async function previewForPr(app: AppEntry, pr: number, dir: string, deps: HostingDeps): Promise<Preview | null> {
  const state = await deps.store.state(app.id);
  const prod = state.projects.production;
  if (!state.enabled || !prod) return null;
  const now = nowOf(deps);
  if (state.branching !== "available") {
    if (state.projects.staging?.pausedAt) await resumeEnv(app, "staging", deps);
    await ensureEnv(app, "staging", deps);
    const r = await migrate(app, { env: "staging" }, deps, dir);
    const preview: Preview = { pr, branchId: "staging", ref: (await deps.store.state(app.id)).projects.staging!.ref, status: "ACTIVE_HEALTHY", createdAt: now.toISOString(), migrations: r.failed ? "failed" : "passed", ...(r.failed ? { error: r.failed.error } : {}) };
    await savePreview(app, preview, deps);
    if (!r.failed && r.applied.length) await typesAfter(app, "staging", r.applied.at(-1)!, deps).catch(() => null);
    return preview;
  }
  const { api } = await apiFor(app, "production", deps);
  let preview = state.previews.find((p) => p.pr === pr && p.branchId !== "staging");
  if (!preview) {
    const b = await api.createBranch(prod.ref, { branch_name: pr === RELEASE_CHECK_PR ? "day2-release-check" : `pr-${pr}`, persistent: false });
    preview = { pr, branchId: b.id, ref: b.project_ref, status: b.preview_project_status ?? "COMING_UP", createdAt: now.toISOString(), migrations: "pending" };
    await savePreview(app, preview, deps);
    await deps.store.update(app.id, (s) => log(s, now, pr === RELEASE_CHECK_PR ? "Made a preview database to check the next release's database changes." : `Made a preview database for pull request #${pr}.`));
  }
  const deadline = Date.now() + (deps.waitMs ?? 10 * 60_000);
  for (;;) {
    const b = await api.branch(preview.branchId);
    preview.status = b.status;
    if (b.ref) preview.ref = b.ref;
    if (b.status === "ACTIVE_HEALTHY") break;
    if (b.status === "INIT_FAILED") {
      preview.migrations = "failed";
      preview.error = "Supabase couldn't start the preview database.";
      await savePreview(app, preview, deps);
      return preview;
    }
    if (Date.now() >= deadline) {
      await savePreview(app, preview, deps);
      return preview;
    }
    await sleepOf(deps)(10_000);
  }
  const files = readMigrations(dir);
  const applied = await appliedVersions(api, preview.ref);
  const r = await applyPending(api, preview.ref, files.filter((m) => !applied.has(m.version)));
  preview.migrations = r.failed ? "failed" : "passed";
  if (r.failed) preview.error = r.failed.error;
  await savePreview(app, preview, deps);
  await deps.store.update(app.id, (s) => {
    for (const a of r.applied) s.migrations.push({ env: `pr-${pr}`, version: a.version, name: a.name, at: now.toISOString(), via: "api", ok: true });
    if (r.failed) s.migrations.push({ env: `pr-${pr}`, version: r.failed.version, name: r.failed.name, at: now.toISOString(), via: "api", ok: false, error: r.failed.error });
  });
  return preview;
}

async function savePreview(app: AppEntry, p: Preview, deps: HostingDeps): Promise<void> {
  await deps.store.update(app.id, (s) => {
    s.previews = [...s.previews.filter((x) => !(x.pr === p.pr && x.branchId === p.branchId)), { ...p }];
  });
}

/** Removes preview databases of pull requests that are closed or merged. */
export async function closePreviews(app: AppEntry, openPrs: number[], deps: HostingDeps): Promise<number[]> {
  const state = await deps.store.state(app.id);
  const gone = state.previews.filter((p) => p.branchId !== "staging" && p.pr !== RELEASE_CHECK_PR && !openPrs.includes(p.pr));
  if (!gone.length) return [];
  const { api } = await apiFor(app, "production", deps);
  const removed: number[] = [];
  for (const p of gone) {
    try {
      await api.deleteBranch(p.branchId);
      removed.push(p.pr);
    } catch {
      /* next pass */
    }
  }
  await deps.store.update(app.id, (s) => {
    s.previews = s.previews.filter((p) => !removed.includes(p.pr) || p.branchId === "staging");
  });
  return removed;
}

export type GateResult = { ok: true; applied: string[] } | { ok: false; why: string };

/**
 * Before a release ships (mobile-release ReleaseDeps.beforeShip): the
 * release's pending migrations must pass on a preview or staging first,
 * then go to production. `dir` is the release's checkout.
 */
export async function releaseMigrations(app: AppEntry, dir: string, deps: HostingDeps): Promise<GateResult> {
  const state = await deps.store.state(app.id);
  if (!state.enabled || !state.projects.production || !(state.done.production ?? []).includes("migrations")) return { ok: true, applied: [] };
  const { api, project } = await apiFor(app, "production", deps);
  const applied = await appliedVersions(api, project!.ref);
  const pending = readMigrations(dir).filter((m) => !applied.has(m.version));
  if (!pending.length) return { ok: true, applied: [] };
  const checked = (v: string) => state.migrations.some((m) => m.version === v && m.ok && m.env !== "production");
  if (!pending.every((m) => checked(m.version))) {
    const p = await previewForPr(app, RELEASE_CHECK_PR, dir, deps);
    if (!p || p.migrations === "pending") return { ok: false, why: "the database changes are being checked on a preview database first" };
    if (p.migrations === "failed") return { ok: false, why: `a database change failed on the preview database: ${p.error ?? "see the Hosting page"}` };
  }
  try {
    const r = await migrate(app, { env: "production" }, deps, dir);
    if (r.blocked.length) return { ok: false, why: `database changes need fixing first: ${r.blocked[0]}` };
    if (r.failed) return { ok: false, why: `a database change failed on production: ${r.failed.error.slice(0, 200)}` };
    return { ok: true, applied: r.applied };
  } catch (err) {
    if (err instanceof HostingError) return { ok: false, why: err.message };
    throw err;
  }
}
