import { supabaseApi, SupabaseError, type SupabaseDeps } from "./supabase";
import { REGIONS, type InstanceSize, type Region, INSTANCE_SIZES } from "./types";

/**
 * day2's own Supabase organization (the operator sets it up once,
 * docs/hosting.md "Operator setup"):
 *
 *   SUPABASE_ACCESS_TOKEN   a personal access token of a member of day2's
 *                           organization (supabase.com → Account → Access tokens)
 *   DAY2_SUPABASE_ORG_ID    the organization's slug (in the dashboard URL:
 *                           supabase.com/dashboard/org/<slug>)
 *   DAY2_HOSTING_SMTP_URL   optional: smtp://user:pass@host:587 — day2's email
 *                           sender for apps' sign-in emails (Supabase's own
 *                           sender only reaches the organization's team)
 *   DAY2_HOSTING_SMTP_FROM  the From address for it, e.g. no-reply@mail.day2.app
 *   DAY2_HOSTING_DEFAULT_REGION  when an app's audience says nothing (eu-central-1)
 *   DAY2_HOSTING_INSTANCE_SIZE   compute for new projects (micro)
 *   DAY2_FEATURE_HOSTING    off hides hosting (default on when the token is set)
 */

export type OperatorConfig = {
  token: string;
  orgSlug: string;
  smtp: { url: string; from: string } | null;
  defaultRegion: Region;
  instanceSize: InstanceSize;
};

export function operatorConfig(env: Record<string, string | undefined> = process.env): OperatorConfig | null {
  const token = env.SUPABASE_ACCESS_TOKEN?.trim();
  const orgSlug = env.DAY2_SUPABASE_ORG_ID?.trim();
  if (!token || !orgSlug) return null;
  const region = env.DAY2_HOSTING_DEFAULT_REGION?.trim() as Region | undefined;
  const size = env.DAY2_HOSTING_INSTANCE_SIZE?.trim() as InstanceSize | undefined;
  const smtpUrl = env.DAY2_HOSTING_SMTP_URL?.trim();
  const from = env.DAY2_HOSTING_SMTP_FROM?.trim();
  return {
    token,
    orgSlug,
    smtp: smtpUrl && from ? { url: smtpUrl, from } : null,
    defaultRegion: region && (REGIONS as readonly string[]).includes(region) ? region : "eu-central-1",
    instanceSize: size && (INSTANCE_SIZES as readonly string[]).includes(size) ? size : "micro",
  };
}

export function hostingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.DAY2_FEATURE_HOSTING === "off") return false;
  return true;
}

export type ConnectionCheck =
  | { ok: true; orgName: string; plan: string; branching: boolean; warnings: string[] }
  | { ok: false; error: string };

/**
 * The connection test: the token can read the organization, and the plan
 * keeps projects running (free projects pause after a week without use and
 * have no backups or branching).
 */
export async function checkOperator(cfg: OperatorConfig | null, deps: SupabaseDeps = {}): Promise<ConnectionCheck> {
  if (!cfg) return { ok: false, error: "Set SUPABASE_ACCESS_TOKEN and DAY2_SUPABASE_ORG_ID in day2's .env (docs/hosting.md)." };
  const api = supabaseApi(cfg.token, deps);
  try {
    const org = await api.organization(cfg.orgSlug);
    const plan = org.plan ?? "unknown";
    const warnings: string[] = [];
    if (plan === "free") warnings.push("The organization is on the Free plan: projects pause after a week without use, there are no daily backups and no branching. Upgrade it to Pro before hosting real apps.");
    if (!cfg.smtp) warnings.push("No email sender for apps (DAY2_HOSTING_SMTP_URL): Supabase's own sender only reaches your organization's team, at most 2 emails an hour. Email sign-in won't work for real users until one is set (or the owner adds theirs).");
    const branching = await hasBranching(api, cfg.orgSlug, plan);
    return { ok: true, orgName: org.name, plan, branching, warnings };
  } catch (err) {
    if (err instanceof SupabaseError && err.status === 401) return { ok: false, error: "Supabase didn't accept the access token (SUPABASE_ACCESS_TOKEN) — make a new one under Account → Access tokens." };
    if (err instanceof SupabaseError && (err.status === 403 || err.status === 404)) return { ok: false, error: `The token can't see the organization "${cfg.orgSlug}" (DAY2_SUPABASE_ORG_ID is the slug from the dashboard URL, and the token's user must be a member).` };
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Branching (a preview database per pull request) is a paid-plan feature.
 * The entitlements endpoint is asked first; its feature key isn't documented,
 * so any key mentioning "branch" counts. Without an answer: paid plan = yes.
 */
export async function hasBranching(api: ReturnType<typeof supabaseApi>, slug: string, plan: string): Promise<boolean> {
  try {
    const e = await api.entitlements(slug);
    const b = e.entitlements.find((x) => /branch/i.test(x.feature.key));
    if (b) return b.hasAccess;
  } catch {
    /* fall through */
  }
  return plan !== "free" && plan !== "unknown";
}

if (import.meta.main) {
  const r = await checkOperator(operatorConfig());
  if (r.ok) {
    console.log(`[day2-hosting] Connected to "${r.orgName}" (plan: ${r.plan}, branching: ${r.branching ? "yes" : "no"}).`);
    for (const w of r.warnings) console.warn(`[day2-hosting] ${w}`);
  } else {
    console.error(`[day2-hosting] ${r.error}`);
    process.exit(1);
  }
}
