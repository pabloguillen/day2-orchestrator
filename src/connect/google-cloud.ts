import { redact } from "../ads/http";
import { GoogleError, type GoogleClient } from "../money/google-play";

/**
 * The Google Cloud calls "Sign in with Google" needs, made with the owner's
 * short-lived access token (connect/google-oauth.ts). Each one is the
 * documented REST call; none has run against a real account yet (see
 * docs/connect.md, "Not verified"):
 *  - Resource Manager v1: projects.list / projects.create / get+setIamPolicy
 *    https://cloud.google.com/resource-manager/reference/rest/v1/projects
 *  - Service Usage v1: services.batchEnable
 *    https://cloud.google.com/service-usage/docs/reference/rest/v1/services/batchEnable
 *  - IAM v1: serviceAccounts.create, serviceAccounts.keys.create
 *    https://cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts
 *  - Firebase Management v1beta1: projects.addFirebase, androidApps.create, androidApps.getConfig
 *    https://firebase.google.com/docs/reference/firebase-management/rest
 *  - Play Developer API v3: users.create, grants.create (inviting the service account)
 *    https://developers.google.com/android-publisher/api-ref/rest/v3/users
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type CloudDeps = { fetch?: FetchLike; sleep?: (ms: number) => Promise<void>; pollEveryMs?: number; maxPolls?: number };

const CRM = "https://cloudresourcemanager.googleapis.com/v1";
const USAGE = "https://serviceusage.googleapis.com/v1";
const IAM = "https://iam.googleapis.com/v1";
const FIREBASE = "https://firebase.googleapis.com/v1beta1";
const PLAY = "https://androidpublisher.googleapis.com/androidpublisher/v3";

/** The APIs day2 turns on in the app's project. */
export const STORE_APIS = [
  "iam.googleapis.com",
  "androidpublisher.googleapis.com",
  "playdeveloperreporting.googleapis.com",
  "pubsub.googleapis.com",
  "firebase.googleapis.com",
  "fcm.googleapis.com",
] as const;

/**
 * The Play Console permissions day2's service account asks for — the least
 * each feature needs, and the money ones only when the app sells something:
 *
 * | Permission (Play Console name) | API enum | For |
 * |---|---|---|
 * | View app information and download bulk reports (account) | CAN_VIEW_NON_FINANCIAL_DATA_GLOBAL | Numbers: installs bucket, vitals |
 * | Release to production, exclude devices, and use Play App Signing | CAN_MANAGE_PUBLIC_APKS | Releases: staged rollouts |
 * | Release apps to testing tracks | CAN_MANAGE_TRACK_APKS | Releases: EAS Submit to internal testing |
 * | Manage store presence | CAN_MANAGE_PUBLIC_LISTING | Store: listing, graphics, setup |
 * | Reply to reviews | CAN_REPLY_TO_REVIEWS | Store: review replies |
 * | Manage orders and subscriptions (paid products only) | CAN_MANAGE_ORDERS | Money: purchases, acknowledgements, refunds |
 * | View financial data (paid products only) | CAN_VIEW_FINANCIAL_DATA | Money: voided purchases |
 *
 * The bulk-reports permission exists only account-wide in Play Console.
 */
export type PlayPermissions = { account: string[]; app: string[]; names: string[] };

export function playPermissions(o: { paidProducts: boolean }): PlayPermissions {
  const base: Array<[string, string]> = [
    ["CAN_MANAGE_PUBLIC_APKS", "Release to production, exclude devices, and use Play App Signing"],
    ["CAN_MANAGE_TRACK_APKS", "Release apps to testing tracks"],
    ["CAN_MANAGE_PUBLIC_LISTING", "Manage store presence"],
    ["CAN_REPLY_TO_REVIEWS", "Reply to reviews"],
  ];
  const money: Array<[string, string]> = [
    ["CAN_MANAGE_ORDERS", "Manage orders and subscriptions"],
    ["CAN_VIEW_FINANCIAL_DATA", "View financial data, orders, and cancellation survey responses"],
  ];
  const app = o.paidProducts ? [...base, ...money] : base;
  return {
    account: ["CAN_VIEW_NON_FINANCIAL_DATA_GLOBAL"],
    app: app.map(([e]) => e),
    names: ["View app information and download bulk reports (read-only) — account permission", ...app.map(([, n]) => n)],
  };
}

/** Google's own error reason, for plain-language mapping. */
export function errorReason(err: unknown): string {
  return err instanceof GoogleError ? err.message : (err as Error)?.message ?? String(err);
}

/** A JSON client over an access token, shaped like money/google-play.ts's GoogleClient (so setupPubSub reuses it). */
export function tokenClient(accessToken: string, deps: CloudDeps = {}): GoogleClient {
  const doFetch = deps.fetch ?? fetch;
  return {
    async call<T>(url: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
      const u = new URL(url);
      for (const [k, v] of Object.entries(init.query ?? {})) u.searchParams.set(k, v);
      let res: Response;
      try {
        res = await doFetch(u.toString(), {
          method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
          headers: { authorization: `Bearer ${accessToken}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
      } catch (err) {
        throw new GoogleError(`couldn't reach Google (${redact((err as Error).message)})`, undefined, true);
      }
      const text = await res.text();
      if (!res.ok) {
        let msg = text.slice(0, 300);
        try {
          msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
        } catch {
          /* not JSON */
        }
        throw new GoogleError(`${res.status} ${redact(msg)}`, res.status, res.status === 429 || res.status >= 500);
      }
      return (text ? JSON.parse(text) : undefined) as T;
    },
  };
}

type Operation = { name?: string; done?: boolean; error?: { message?: string; code?: number }; response?: Record<string, unknown> };

export type CloudProject = { projectId: string; name: string };
export type ServiceAccountKeyJson = { type: "service_account"; project_id: string; private_key_id: string; private_key: string; client_email: string; [k: string]: unknown };

const is = (status: number) => (err: unknown) => err instanceof GoogleError && err.status === status;

export function createCloud(accessToken: string, deps: CloudDeps = {}) {
  const c = tokenClient(accessToken, deps);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const every = deps.pollEveryMs ?? 2000;
  const maxPolls = deps.maxPolls ?? 60;

  async function wait(base: string, op: Operation): Promise<Operation> {
    let cur = op;
    for (let i = 0; !cur.done && cur.name && i < maxPolls; i++) {
      await sleep(every);
      cur = await c.call<Operation>(`${base}/${cur.name}`);
    }
    if (!cur.done && cur.name) throw new GoogleError(`still working on it (${cur.name}) — try again in a minute`, 504, true);
    if (cur.error) throw new GoogleError(`${cur.error.code ?? ""} ${redact(cur.error.message ?? "the operation failed")}`.trim(), cur.error.code ?? 400);
    return cur;
  }

  return {
    async listProjects(): Promise<CloudProject[]> {
      const out: CloudProject[] = [];
      let pageToken = "";
      for (let i = 0; i < 5; i++) {
        const r = await c.call<{ projects?: Array<{ projectId: string; name?: string; lifecycleState?: string }>; nextPageToken?: string }>(`${CRM}/projects`, { query: { filter: "lifecycleState:ACTIVE", pageSize: "200", ...(pageToken ? { pageToken } : {}) } });
        for (const p of r?.projects ?? []) out.push({ projectId: p.projectId, name: p.name ?? p.projectId });
        if (!r?.nextPageToken) break;
        pageToken = r.nextPageToken;
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },

    async createProject(projectId: string, name: string): Promise<CloudProject> {
      const op = await c.call<Operation>(`${CRM}/projects`, { method: "POST", body: { projectId, name } });
      await wait(CRM, op);
      return { projectId, name };
    },

    async enableApis(projectId: string, services: readonly string[] = STORE_APIS): Promise<void> {
      const op = await c.call<Operation>(`${USAGE}/projects/${encodeURIComponent(projectId)}/services:batchEnable`, { method: "POST", body: { serviceIds: services } });
      await wait(USAGE, op);
    },

    /** Creates the service account, or returns the one already there. */
    async serviceAccount(projectId: string, accountId: string, displayName: string): Promise<string> {
      const email = `${accountId}@${projectId}.iam.gserviceaccount.com`;
      try {
        const r = await c.call<{ email: string }>(`${IAM}/projects/${encodeURIComponent(projectId)}/serviceAccounts`, { method: "POST", body: { accountId, serviceAccount: { displayName, description: "day2 releases, store, numbers, money and push for this app" } } });
        return r.email ?? email;
      } catch (err) {
        if (is(409)(err)) return email;
        throw err;
      }
    },

    /** A new JSON key for the service account. Organizations may forbid this (iam.disableServiceAccountKeyCreation). */
    async createKey(projectId: string, email: string): Promise<ServiceAccountKeyJson> {
      const r = await c.call<{ privateKeyData?: string }>(`${IAM}/projects/${encodeURIComponent(projectId)}/serviceAccounts/${encodeURIComponent(email)}/keys`, {
        method: "POST",
        body: { privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE", keyAlgorithm: "KEY_ALG_RSA_2048" },
      });
      if (!r?.privateKeyData) throw new GoogleError("the new key came back empty", 502, true);
      return JSON.parse(Buffer.from(r.privateKeyData, "base64").toString("utf-8")) as ServiceAccountKeyJson;
    },

    /** Adds `member` to `role` on the project (no-op when it's there). */
    async grantProjectRole(projectId: string, role: string, member: string): Promise<void> {
      const base = `${CRM}/projects/${encodeURIComponent(projectId)}`;
      const policy = await c.call<{ bindings?: Array<{ role: string; members: string[] }>; etag?: string; version?: number }>(`${base}:getIamPolicy`, { method: "POST", body: {} });
      const bindings = policy?.bindings ?? [];
      const b = bindings.find((x) => x.role === role);
      if (b?.members.includes(member)) return;
      const next = b ? bindings.map((x) => (x === b ? { ...x, members: [...x.members, member] } : x)) : [...bindings, { role, members: [member] }];
      await c.call(`${base}:setIamPolicy`, { method: "POST", body: { policy: { ...policy, bindings: next } } });
    },

    /** Turns the project into a Firebase project (needed for FCM), unless it already is. */
    async addFirebase(projectId: string): Promise<void> {
      try {
        await c.call(`${FIREBASE}/projects/${encodeURIComponent(projectId)}`);
        return;
      } catch (err) {
        if (!is(404)(err) && !is(403)(err)) throw err;
      }
      try {
        const op = await c.call<Operation>(`${FIREBASE}/projects/${encodeURIComponent(projectId)}:addFirebase`, { method: "POST", body: {} });
        await wait(FIREBASE, op);
      } catch (err) {
        if (!is(409)(err)) throw err;
      }
    },

    /** The Android app in Firebase (created when missing) and its google-services.json. */
    async androidApp(projectId: string, packageName: string, displayName: string): Promise<{ appId: string; googleServicesJson: string }> {
      const base = `${FIREBASE}/projects/${encodeURIComponent(projectId)}`;
      const list = await c.call<{ apps?: Array<{ appId: string; packageName: string }> }>(`${base}/androidApps`);
      let appId = list?.apps?.find((a) => a.packageName === packageName)?.appId;
      if (!appId) {
        const op = await wait(FIREBASE, await c.call<Operation>(`${base}/androidApps`, { method: "POST", body: { packageName, displayName } }));
        appId = (op.response?.appId as string | undefined) ?? undefined;
        if (!appId) throw new GoogleError("Firebase didn't return the Android app", 502, true);
      }
      const cfg = await c.call<{ configFileContents?: string }>(`${FIREBASE}/projects/-/androidApps/${encodeURIComponent(appId)}/config`);
      return { appId, googleServicesJson: Buffer.from(cfg?.configFileContents ?? "", "base64").toString("utf-8") };
    },

    /**
     * Invites the service account in Play Console with day2's permissions
     * (needs the owner to be allowed to manage users there). Throws when
     * Google says no — the guided step remains.
     */
    async invitePlayUser(developerId: string, email: string, packageName: string, perms: PlayPermissions): Promise<void> {
      const base = `${PLAY}/developers/${encodeURIComponent(developerId)}/users`;
      try {
        await c.call(base, { method: "POST", body: { email, developerAccountPermissions: perms.account } });
      } catch (err) {
        if (!is(409)(err)) throw err;
      }
      const grants = `${base}/${encodeURIComponent(email)}/grants`;
      try {
        await c.call(grants, { method: "POST", body: { packageName, appLevelPermissions: perms.app } });
      } catch (err) {
        if (!is(409)(err)) throw err;
        await c.call(`${grants}/${encodeURIComponent(packageName)}`, { method: "PATCH", query: { updateMask: "appLevelPermissions" }, body: { appLevelPermissions: perms.app } });
      }
    },

    client: c,
  };
}

export type Cloud = ReturnType<typeof createCloud>;

/** Pure. A project id Google accepts (6–30 chars, lowercase letters, digits, hyphens, starts with a letter). */
export function projectIdFor(appName: string, suffix: string): string {
  const base = appName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 18) || "app";
  return `${base}-day2-${suffix.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "x"}`.slice(0, 30).replace(/-+$/, "");
}

/** Pure. Google's answer → what the owner can do about it. */
export function cloudProblem(err: unknown, what: string): string {
  const m = errorReason(err);
  if (/disableServiceAccountKeyCreation|Key creation is not allowed/i.test(m)) return `Your Google organization doesn't allow service account keys (policy iam.disableServiceAccountKeyCreation). An organization admin can allow it for this project in IAM → Organization policies, then try again.`;
  if (/Terms of Service|ToS/i.test(m)) return "Google Cloud asks you to accept its terms first: open console.cloud.google.com once, accept, then try again.";
  if (/quota|limit/i.test(m) && /project/i.test(what)) return "Your Google account can't create more projects. Pick an existing project instead.";
  if (/billing/i.test(m)) return `Google needs a billing account on the project for ${what}. Add one in Google Cloud → Billing (the APIs day2 uses are free), then try again.`;
  if (err instanceof GoogleError && err.status === 403) return `Google says your account isn't allowed to ${what} in this project. Use a project you own, or ask its owner to make you Owner.`;
  if (err instanceof GoogleError && err.retryable) return `Google didn't answer while day2 tried to ${what}. Try again in a minute.`;
  return `Google refused to ${what}: ${m.replace(/^Google: /, "")}`;
}

/** Pure. The developer id in a Play Console address (…/developers/<id>/…), or a bare id. */
export function playDeveloperId(input: string): string | null {
  const s = input.trim();
  const m = /\/developers\/(\d{5,25})(?:\/|$|\?)/.exec(s) ?? /^(\d{5,25})$/.exec(s);
  return m?.[1] ?? null;
}

/** Pure. Bucket names Play uses for a developer account's reports, most likely first. */
export function bucketCandidates(developerId: string): string[] {
  return [`pubsite_prod_rev_${developerId}`, `pubsite_prod_${developerId}`];
}
