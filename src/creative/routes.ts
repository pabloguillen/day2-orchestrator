import type { AppEntry } from "../apps-registry";
import { creditsForCost } from "../credits";
import { hasSecretsKey } from "../secrets";
import type { Tenant } from "../tenant";
import { operatorCreds, TOOLS, toolDef } from "./catalog";
import { creatorKeys, creatorSettingsPath, toolStates } from "./kit";
import { accountInUse } from "./select";
import { defaultSetting, MAX_CAP_CREDITS, settingOf, updateCreatorSettings, type AccountChoice } from "./store";
import { CAPABILITY_LABEL, isToolId, KeyCheckError, type Capability, type ToolCreds, type ToolDeps, type ToolId } from "./types";

/**
 * The Creator tools API (/api/apps/:id/creator-tools/*), registered from
 * api-server.ts. Scoped to an app of the signed-in account (requireApp);
 * every change needs an owner or admin. Keys are checked with one cheap
 * call before they're stored, stored encrypted, and never sent back — not
 * even in part.
 */

type Handler = (req: Request, params: Record<string, string>, t: Tenant) => Promise<Response> | Response;
export type CreatorRouteHelpers = {
  json: (data: unknown, init?: ResponseInit) => Response;
  requireApp: (t: Tenant, id: string) => Promise<AppEntry>;
  requireManager: (t: Tenant) => void;
  actorName: (t: Tenant) => Promise<string | undefined>;
  httpError: (status: number, message: string) => Error;
};

let verifyDeps: ToolDeps = {};
let envOverride: Record<string, string | undefined> | null = null;
/** Tests: a fake fetch for key checks, and a fake operator env. */
export function setCreatorToolTestHooks(h: { deps?: ToolDeps; env?: Record<string, string | undefined> | null }): void {
  if (h.deps) verifyDeps = h.deps;
  if (h.env !== undefined) envOverride = h.env;
}
const env = () => envOverride ?? process.env;

const UNIT: Record<Capability, string> = { presenter_video: "per 30-second video", generated_video: "per clip", image: "per image", voice: "per voiceover", music: "per track" };
const MAX_FIELD = 500;

export async function creatorToolsView(t: Tenant, app: AppEntry) {
  const states = await toolStates(t.accountId, app, { env: env() });
  const ops = operatorCreds(env());
  return {
    unverified: "Creator tools are built from each tool's public API docs and tested against fakes; none has been run against a real account yet.",
    secretsReady: hasSecretsKey(),
    tools: states.map((s) => {
      const def = s.def;
      const acct = accountInUse(s);
      const cap = def.capabilities[0]!;
      let estimate: number | null = null;
      if (ops[def.id]) {
        try {
          estimate = creditsForCost(def.client(ops[def.id]!).estimateUsd(def.sample), "content_generation");
        } catch {
          estimate = null;
        }
      }
      return {
        id: def.id,
        name: def.name,
        oneLine: def.oneLine,
        makes: def.capabilities.map((c) => CAPABILITY_LABEL[c]),
        priceNote: def.priceNote,
        keyUrl: def.keyUrl,
        docsUrl: def.docsUrl,
        fields: def.fields.map((f) => ({ key: f.key, label: f.label, secret: f.secret, optional: Boolean(f.optional), help: f.help ?? null, likeness: f.likeness ?? null })),
        day2: { available: Boolean(ops[def.id]), estimateCredits: estimate, unit: UNIT[cap] },
        own: s.own ? { scope: s.ownScope, connectedBy: s.own.connectedBy, connectedAt: s.own.connectedAt, likeness: { avatar: Boolean(s.own.meta.likeness.avatar), voice: Boolean(s.own.meta.likeness.voice) } } : null,
        setting: s.setting,
        inUse: acct?.kind ?? null,
        billedBy: acct?.kind === "own" ? def.name : acct?.kind === "day2" ? "credits" : null,
        usedCredits: s.usedCredits,
        unverified: def.unverified,
      };
    }),
  };
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = (await req.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function registerCreatorToolRoutes(route: (method: string, pathname: string, handler: Handler) => void, h: CreatorRouteHelpers): void {
  const fail = h.httpError;
  const toolOf = (id: string | undefined): ToolId => {
    if (!isToolId(id)) throw fail(404, "Unknown creator tool.");
    return id;
  };

  route("GET", "/api/apps/:id/creator-tools", async (_req, p, t) => h.json(await creatorToolsView(t, await h.requireApp(t, p.id!))));

  /** Which account a tool uses, whether Posts / Ads may use it, its monthly cap on day2's account. */
  route("PUT", "/api/apps/:id/creator-tools/:tool", async (req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    const tool = toolOf(p.tool);
    const b = await body(req);
    if (b.account === "day2" && !operatorCreds(env())[tool]) throw fail(409, `day2 has no ${toolDef(tool).name} account on this server — connect your own.`);
    if (b.capCredits !== undefined && (typeof b.capCredits !== "number" || !Number.isFinite(b.capCredits) || b.capCredits < 0 || b.capCredits > MAX_CAP_CREDITS)) throw fail(400, `The monthly cap is a number of credits from 0 to ${MAX_CAP_CREDITS}.`);
    updateCreatorSettings(creatorSettingsPath(app), (s) => {
      const cur = settingOf(s, tool);
      const next = { ...cur };
      if ((["auto", "day2", "own", "off"] as const).includes(b.account as AccountChoice)) next.account = b.account as AccountChoice;
      if (typeof b.posts === "boolean") next.posts = b.posts;
      if (typeof b.ads === "boolean") next.ads = b.ads;
      if (typeof b.capCredits === "number") next.capCredits = Math.round(b.capCredits);
      return { ...s, tools: { ...s.tools, [tool]: next } };
    });
    return h.json(await creatorToolsView(t, app));
  });

  /**
   * Connect the owner's own account: the key is checked with one cheap call
   * (no generation), then stored encrypted for this app or the workspace.
   * Fields that pick a person's face or voice need the consent checkbox.
   */
  route("POST", "/api/apps/:id/creator-tools/:tool/key", async (req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    const tool = toolOf(p.tool);
    const def = toolDef(tool);
    if (!hasSecretsKey()) throw fail(409, "This server can't store keys yet (DAY2_SECRETS_KEY isn't set).");
    const b = await body(req);
    const raw = (b.fields && typeof b.fields === "object" ? b.fields : {}) as Record<string, unknown>;
    const creds: ToolCreds = {};
    for (const f of def.fields) {
      const v = typeof raw[f.key] === "string" ? (raw[f.key] as string).trim() : "";
      if (v.length > MAX_FIELD || /\s/.test(v)) throw fail(400, `${f.label} doesn't look right.`);
      if (!v && !f.optional) throw fail(400, `${f.label} is needed.`);
      if (v) creds[f.key] = v;
    }
    const likenessFields = def.fields.filter((f) => f.likeness && creds[f.key]);
    if (likenessFields.length && b.consent !== true) throw fail(400, "Your own avatar or voice needs the consent box: it must be you, or someone who agreed in writing.");
    const scope = b.scope === "workspace" ? "workspace" : "app";
    try {
      await def.verify(creds, verifyDeps);
    } catch (err) {
      throw fail(err instanceof KeyCheckError && err.rejected ? 400 : 502, err instanceof KeyCheckError ? err.message : `Couldn't check the key with ${def.name} right now.`);
    }
    const by = (await h.actorName(t)) ?? null;
    const at = new Date().toISOString();
    const likeness: { avatar?: { by: string | null; at: string }; voice?: { by: string | null; at: string } } = {};
    for (const f of likenessFields) likeness[f.likeness!] = { by, at };
    await creatorKeys().save({ accountId: t.accountId, appId: scope === "app" ? app.id : null, tool, creds, meta: { fields: Object.keys(creds), likeness }, connectedBy: by });
    updateCreatorSettings(creatorSettingsPath(app), (s) => ({ ...s, tools: { ...s.tools, [tool]: { ...settingOf(s, tool), account: "own" } } }));
    return h.json(await creatorToolsView(t, app));
  });

  route("DELETE", "/api/apps/:id/creator-tools/:tool/key", async (req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    const tool = toolOf(p.tool);
    const scope = new URL(req.url).searchParams.get("scope") === "workspace" ? "workspace" : "app";
    await creatorKeys().remove(t.accountId, scope === "app" ? app.id : null, tool);
    updateCreatorSettings(creatorSettingsPath(app), (s) => {
      const cur = settingOf(s, tool);
      return { ...s, tools: { ...s.tools, [tool]: cur.account === "own" ? { ...cur, account: "auto" } : cur } };
    });
    return h.json(await creatorToolsView(t, app));
  });
}

/** For the operator page: which tools day2's own account offers. */
export function creatorToolChecks(e: Record<string, string | undefined> = process.env) {
  const ops = operatorCreds(e);
  return TOOLS.map((d) => ({
    id: `creator_${d.id}`,
    ok: Boolean(ops[d.id]),
    label: `${d.name}, for ${d.capabilities.map((c) => CAPABILITY_LABEL[c].toLowerCase()).join(" and ")} (optional)`,
    detail: ops[d.id] ? "connected" : [...d.env.required, ...(d.env.gate ? [`${d.env.gate.name}=${d.env.gate.value}`] : [])].join(", "),
  }));
}

export { defaultSetting };
