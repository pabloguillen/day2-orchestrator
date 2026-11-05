import type { AppEntry } from "../apps-registry";
import { log, tokenFor, type HostingDeps, HostingError } from "./provision";
import { SupabaseError } from "./supabase";
import type { HostEnv } from "./types";

/**
 * "Move to my own Supabase organization" — no lock-in.
 *
 * Supabase's Management API has project claim tokens (OpenAPI spec,
 * November 2026): day2 makes a claim token for the project with its own
 * token (POST /v1/projects/{ref}/claim-token); the owner's token previews
 * the move (GET /v1/organizations/{slug}/project-claim/{token}: valid,
 * warnings, errors, plans) and claims it (POST …/project-claim/{token}).
 * Not run against real organizations yet. If Supabase refuses the claim
 * token, the guided way is Supabase's dashboard: Project settings → General →
 * "Transfer project" by someone who is a member of both organizations.
 *
 * Either way the owner gives day2 an access token of their own, and day2
 * goes on managing the project with it (stored encrypted). From then on the
 * owner's organization pays Supabase directly and day2 stops charging
 * hosting credits.
 */

/** When the claim doesn't work: Supabase's dashboard transfer needs someone who owns both organizations. */
export const GUIDED_STEPS = [
  "Invite day2's operator to your Supabase organization as an Owner, for the move only (day2 support tells you which email).",
  "day2's operator moves the project in Supabase's dashboard: Project settings → General → Transfer project → your organization.",
  "Make an access token in your Supabase account (Account → Access tokens) and paste it here with your organization's slug, so day2 goes on looking after the project.",
  "Remove the operator from your organization again.",
];

const nowOf = (d: HostingDeps) => (d.now ? d.now() : new Date());

export type TakeoverPreview = { ok: true; projects: Array<{ env: HostEnv; ref: string; name: string; warnings: string[]; errors: string[]; targetPlan: string | null }> } | { ok: false; guided: boolean; error: string };

function parseInput(input: unknown): { token: string; orgSlug: string } {
  const o = (input ?? {}) as Record<string, unknown>;
  const token = typeof o.token === "string" ? o.token.trim() : "";
  const orgSlug = typeof o.orgSlug === "string" ? o.orgSlug.trim() : "";
  if (!/^sbp_[A-Za-z0-9]{20,}$/.test(token)) throw new HostingError("That doesn't look like a Supabase access token (supabase.com → Account → Access tokens; it starts with sbp_).", "failed");
  if (!/^[a-z0-9-]{3,64}$/.test(orgSlug)) throw new HostingError("The organization's slug is in its dashboard address: supabase.com/dashboard/org/<slug>.", "failed");
  return { token, orgSlug };
}

/** Step 1: check the owner's token and organization, make claim tokens, show what the move means. */
export async function previewTakeover(app: AppEntry, input: unknown, deps: HostingDeps): Promise<TakeoverPreview> {
  const { token, orgSlug } = parseInput(input);
  const state = await deps.store.state(app.id);
  const envs = (["production", "staging"] as HostEnv[]).filter((e) => state.projects[e] && state.projects[e]!.managedBy === "day2");
  if (!envs.length) throw new HostingError(state.projects.production ? "The project is already in your organization." : "There's no hosted backend to move yet.", "not_enabled");
  const owner = deps.api(token);
  try {
    await owner.organization(orgSlug);
  } catch (err) {
    return { ok: false, guided: false, error: err instanceof SupabaseError && (err.status === 401 || err.status === 403 || err.status === 404) ? `That token can't see the organization "${orgSlug}".` : (err as Error).message };
  }
  const day2 = deps.api(await tokenFor(app.id, state.projects.production, deps));
  const claims: Record<string, string> = {};
  const projects: Extract<TakeoverPreview, { ok: true }>["projects"] = [];
  for (const env of envs) {
    const p = state.projects[env]!;
    let claim: string;
    try {
      claim = (await day2.createClaimToken(p.ref)).token;
    } catch (err) {
      return { ok: false, guided: true, error: `Supabase didn't make a claim token (${(err as Error).message}). Move it in Supabase's dashboard instead (below).` };
    }
    claims[env] = claim;
    const pv = await owner.claimPreview(orgSlug, claim);
    projects.push({ env, ref: p.ref, name: pv.project.name, warnings: pv.preview.warnings.map((w) => w.message), errors: [...pv.preview.errors.map((e) => e.message), ...(pv.preview.valid ? [] : pv.preview.errors.length ? [] : ["Supabase says this move isn't possible right now."])], targetPlan: pv.preview.target_subscription_plan });
  }
  // The owner's token and the claim tokens wait (encrypted) for the owner's OK.
  await deps.secrets.set(app.id, "owner_token", { token, orgSlug, claims }, `Supabase token for ${orgSlug}`);
  await deps.store.update(app.id, (s) => {
    s.takeover = { state: "ready", orgSlug, at: nowOf(deps).toISOString(), by: null, error: null, warnings: projects.flatMap((p) => [...p.warnings, ...p.errors]) };
  });
  return { ok: true, projects };
}

/** Step 2: the owner said yes. Claims each project into their organization and switches day2 to their token. */
export async function confirmTakeover(app: AppEntry, by: string | null, deps: HostingDeps): Promise<{ moved: HostEnv[] }> {
  const saved = await deps.secrets.get<{ token: string; orgSlug: string; claims?: Record<string, string> }>(app.id, "owner_token");
  const state = await deps.store.state(app.id);
  if (!saved?.claims || state.takeover.state !== "ready") throw new HostingError("Check the move first (your token and organization).", "failed");
  const owner = deps.api(saved.token);
  const moved: HostEnv[] = [];
  const now = nowOf(deps);
  try {
    for (const [env, claim] of Object.entries(saved.claims) as Array<[HostEnv, string]>) {
      const p = state.projects[env];
      if (!p) continue;
      await owner.claim(saved.orgSlug, claim);
      const after = await owner.project(p.ref);
      if (after.organization_slug !== saved.orgSlug) throw new HostingError(`Supabase accepted the claim, but ${p.name} still shows another organization.`);
      moved.push(env);
    }
  } catch (err) {
    await deps.store.update(app.id, (s) => {
      for (const env of moved) Object.assign(s.projects[env]!, { managedBy: "owner", orgSlug: saved.orgSlug });
      s.takeover = { ...s.takeover, state: "failed", error: (err as Error).message.slice(0, 300) };
    });
    throw err instanceof HostingError ? err : new HostingError((err as Error).message);
  }
  await deps.secrets.set(app.id, "owner_token", { token: saved.token, orgSlug: saved.orgSlug }, `Supabase token for ${saved.orgSlug}`);
  await deps.store.update(app.id, (s) => {
    for (const env of moved) Object.assign(s.projects[env]!, { managedBy: "owner", orgSlug: saved.orgSlug });
    s.takeover = { state: "moved", orgSlug: saved.orgSlug, at: now.toISOString(), by, error: null, warnings: [] };
    log(s, now, `Moved the backend to your Supabase organization "${saved.orgSlug}". day2 keeps looking after it with your token; Supabase bills your organization from now on.`);
  });
  return { moved };
}

/**
 * The guided way: the owner moved the project in Supabase's dashboard and
 * gives day2 their token; day2 checks the project is really in their org.
 */
export async function adoptMovedProject(app: AppEntry, input: unknown, by: string | null, deps: HostingDeps): Promise<void> {
  const { token, orgSlug } = parseInput(input);
  const state = await deps.store.state(app.id);
  const p = state.projects.production;
  if (!p) throw new HostingError("There's no hosted backend yet.", "not_enabled");
  const after = await deps.api(token).project(p.ref);
  if (after.organization_slug !== orgSlug) throw new HostingError(`The project ${p.name} isn't in "${orgSlug}" yet — move it in Supabase's dashboard first (Project settings → General → Transfer project).`, "failed");
  const now = nowOf(deps);
  await deps.secrets.set(app.id, "owner_token", { token, orgSlug }, `Supabase token for ${orgSlug}`);
  await deps.store.update(app.id, (s) => {
    Object.assign(s.projects.production!, { managedBy: "owner", orgSlug });
    s.takeover = { state: "moved", orgSlug, at: now.toISOString(), by, error: null, warnings: [] };
    log(s, now, `The backend is in your Supabase organization "${orgSlug}" now; day2 keeps looking after it with your token.`);
  });
}

/** Changes the owner's token later (e.g. after they revoked the old one). */
export async function replaceOwnerToken(app: AppEntry, input: unknown, deps: HostingDeps): Promise<void> {
  const { token, orgSlug } = parseInput(input);
  const state = await deps.store.state(app.id);
  if (state.takeover.state !== "moved" || !state.projects.production) throw new HostingError("The backend is still in day2's organization.", "failed");
  await deps.api(token).project(state.projects.production.ref);
  await deps.secrets.set(app.id, "owner_token", { token, orgSlug }, `Supabase token for ${orgSlug}`);
}
