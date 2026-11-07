import { randomBytes } from "node:crypto";
import type { AdAccountChoice, IdentityChoice, Purpose } from "./connect/types";
import type { ConnectionStore, Scope } from "./connections";
import type { PlatformIdentityStore } from "./identities";
import { adapterFor, CONNECTS, platformInfo } from "./registry";
import type { PlatformDeps, PlatformId } from "./types";

/**
 * Connecting a platform in one click, end to end:
 *
 *   start  → the platform's own sign-in page (OAuth)
 *   finish → back at day2: tokens kept (encrypted) with the half-done connection
 *   choose → the person picks the ad account (and/or the page/profile ads
 *            show as); day2 checks it can spend, grants itself page access
 *            where the platform's API allows, and saves the connection.
 *
 * Who: day2's operator for day2's own accounts (scope "day2"); an app's
 * owners/admins for the app's own account or its page (scope = the app).
 */

export type FlowDeps = { store: ConnectionStore; identities: PlatformIdentityStore; env?: Record<string, string | undefined>; platformDeps?: PlatformDeps };

const env = (d: FlowDeps) => d.env ?? process.env;

export async function startConnect(d: FlowDeps, o: { platform: PlatformId; scope: Scope; purpose: Purpose; appId: string | null; by: string | null; callbackUrl: string }): Promise<{ url: string }> {
  const c = CONNECTS[o.platform];
  const app = c.appCredentials(env(d));
  if (!app) throw new Error(`${platformInfo(o.platform).name} can't be connected on this server yet: day2's ${platformInfo(o.platform).name} app keys (${c.appEnv.join(", ")}) aren't set.`);
  const state = randomBytes(24).toString("base64url");
  const pending = await d.store.startPending({ state, scope: o.scope, platform: o.platform, purpose: o.purpose, appId: o.appId, pending: null, createdBy: o.by });
  // OAuth 1.0a (X) comes back without `state`: the callback carries the pending id instead.
  const redirectUri = o.platform === "x" ? `${o.callbackUrl}?p=${pending.id}` : o.callbackUrl;
  const r = await c.authorizeUrl(app, { state, redirectUri, purpose: o.purpose }, d.platformDeps);
  if (r.pending) await d.store.setPendingData(pending.id, r.pending);
  return { url: r.url };
}

/** The platform sent the person back. Returns the pending id and where to send the person in the console. */
export async function finishConnect(d: FlowDeps, o: { platform: PlatformId; query: Record<string, string>; callbackUrl: string }): Promise<{ pendingId: string; scope: Scope; appId: string | null; purpose: Purpose }> {
  const p = o.query.state ? await d.store.pendingByState(o.query.state) : o.query.p ? await d.store.pending(o.query.p) : null;
  if (!p || p.platform !== o.platform) throw new Error("That sign-in expired — start connecting again.");
  if (o.query.error) throw new Error(`${platformInfo(o.platform).name} said: ${o.query.error_description ?? o.query.error}`);
  const c = CONNECTS[o.platform];
  const app = c.appCredentials(env(d))!;
  const redirectUri = o.platform === "x" ? `${o.callbackUrl}?p=${p.id}` : o.callbackUrl;
  const tokens = await c.exchange(app, { query: o.query, redirectUri, ...(p.pending ? { pending: p.pending } : {}) }, d.platformDeps);
  await d.store.setPendingTokens(p.id, tokens);
  return { pendingId: p.id, scope: p.scope, appId: p.appId, purpose: p.purpose };
}

export type Choices = { platform: PlatformId; purpose: Purpose; scope: "day2" | "app"; accounts: AdAccountChoice[]; identities: IdentityChoice[] };

/** What the person can pick after signing in. */
export async function choices(d: FlowDeps, pendingId: string, appId: string | null): Promise<Choices> {
  const p = await d.store.pending(pendingId);
  if (!p?.tokens || (appId !== null && p.appId !== appId)) throw new Error("That connection expired — start connecting again.");
  const c = CONNECTS[p.platform];
  const app = c.appCredentials(env(d))!;
  const accounts = p.purpose === "account" ? await c.listAdAccounts(app, p.tokens, d.platformDeps) : [];
  const wantsIdentity = platformInfo(p.platform).identity === "app_account" && p.scope !== "day2";
  const identities = wantsIdentity && c.listIdentities ? await c.listIdentities(app, p.tokens, d.platformDeps) : [];
  return { platform: p.platform, purpose: p.purpose, scope: p.scope === "day2" ? "day2" : "app", accounts, identities };
}

/** Saves the chosen ad account. Keeps the half-done connection when a page still has to be picked with the same sign-in. */
export async function chooseAccount(d: FlowDeps, pendingId: string, appId: string | null, adAccountId: string, by: string | null): Promise<{ accountName: string; currency: string; nextIdentity: boolean }> {
  const p = await d.store.pending(pendingId);
  if (!p?.tokens || p.purpose !== "account" || (appId !== null && p.appId !== appId)) throw new Error("That connection expired — start connecting again.");
  const c = CONNECTS[p.platform];
  const app = c.appCredentials(env(d))!;
  const pick = (await c.listAdAccounts(app, p.tokens, d.platformDeps)).find((a) => a.id === adAccountId);
  if (!pick) throw new Error("That ad account isn't available to this sign-in.");
  if (!pick.canSpend) throw new Error(`That ad account can't run ads right now${pick.problem ? `: ${pick.problem}` : ""}.`);
  const conn = await d.store.save({ scope: p.scope, platform: p.platform, adAccountId: pick.id, accountName: pick.name, currency: pick.currency, tokens: p.tokens, connectedBy: by });
  // A last check from the adapter itself (wrong token, unsettled billing…).
  const adapter = adapterFor(conn, d.store, env(d), d.platformDeps);
  if (adapter) {
    const info = await adapter.accountInfo().catch((err: Error) => ({ canSpend: false, problem: err.message }) as { canSpend: boolean; problem?: string });
    if (!info.canSpend) {
      await d.store.remove(p.scope, p.platform);
      throw new Error(`Connected, but the ad account can't run ads yet${info.problem ? `: ${info.problem}` : ""}. Fix it on ${platformInfo(p.platform).name} and connect again.`);
    }
  }
  const nextIdentity = p.scope !== "day2" && platformInfo(p.platform).identity === "app_account" && Boolean(c.listIdentities);
  if (!nextIdentity) await d.store.endPending(p.id);
  return { accountName: pick.name, currency: pick.currency, nextIdentity };
}

/**
 * Saves the page/profile the app's ads show as. With the app's own ad
 * account it's theirs to use; with day2's account, day2 grants itself access
 * where the platform allows (or says what the owner has to approve).
 */
export async function chooseIdentity(d: FlowDeps, pendingId: string, appId: string, ref: string, by: string | null): Promise<{ status: "ready" | "pending"; todo: string | null; name: string }> {
  const p = await d.store.pending(pendingId);
  if (!p?.tokens || p.appId !== appId) throw new Error("That connection expired — start connecting again.");
  const c = CONNECTS[p.platform];
  const app = c.appCredentials(env(d))!;
  const pick = (c.listIdentities ? await c.listIdentities(app, p.tokens, d.platformDeps) : []).find((i) => i.ref === ref);
  if (!pick) throw new Error("That page isn't available to this sign-in.");
  const own = await d.store.get({ appId }, p.platform);
  const day2 = own ? null : await d.store.get("day2", p.platform);
  let status: "ready" | "pending" = "ready";
  let todo: string | null = null;
  if (day2 && c.grantIdentity) {
    const g = await c.grantIdentity(app, p.tokens, ref, { tokens: day2.tokens, adAccountId: day2.adAccountId }, d.platformDeps);
    status = g.status;
    todo = g.todo ?? null;
  }
  const account = own ?? day2;
  if (status === "ready" && account) {
    const adapter = adapterFor(account, d.store, env(d), d.platformDeps);
    const check = adapter?.checkIdentity ? await adapter.checkIdentity({ platform: p.platform, ref, displayName: pick.name }).catch((err: Error) => ({ ok: false as const, problem: err.message })) : { ok: true as const };
    if (!check.ok) {
      status = "pending";
      todo = check.problem;
    }
  }
  await d.identities.set({ appId, platform: p.platform, ref, displayName: pick.name, setBy: by, status, todo });
  await d.store.endPending(p.id);
  return { status, todo, name: pick.name };
}

/** Rechecks identities waiting on an approval (called on each ad pass). Returns the platforms that became ready. */
export async function recheckIdentities(d: FlowDeps, appId: string): Promise<PlatformId[]> {
  const ready: PlatformId[] = [];
  for (const i of await d.identities.forApp(appId)) {
    if (i.status !== "pending") continue;
    const account = (await d.store.get({ appId }, i.platform)) ?? (await d.store.get("day2", i.platform));
    const adapter = account ? adapterFor(account, d.store, env(d), d.platformDeps) : null;
    if (!adapter?.checkIdentity) continue;
    const r = await adapter.checkIdentity({ platform: i.platform, ref: i.ref, displayName: i.displayName }).catch(() => ({ ok: false as const, problem: i.todo ?? "" }));
    if (r.ok) {
      await d.identities.setStatus(appId, i.platform, "ready", null);
      ready.push(i.platform);
    }
  }
  return ready;
}
