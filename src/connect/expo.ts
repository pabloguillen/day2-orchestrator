import { redactToken } from "../mobile-release/eas";

/**
 * Expo's GraphQL API (https://api.expo.dev/graphql), the one eas-cli itself
 * uses, with the owner's robot token as `Authorization: Bearer`. Expo has no
 * OAuth for third-party apps, so the owner makes a robot user once and
 * pastes its token (docs/connect.md). The queries and mutations are copied
 * from eas-cli's source (packages/eas-cli/src/graphql, credentials/android/
 * api/graphql); they're not a documented public API and haven't run
 * against a real account from day2 yet.
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export const EXPO_GRAPHQL = "https://api.expo.dev/graphql";

export class ExpoApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    /** A safe, short code to show instead of Expo's own text (which can echo the input). */
    public code: string = status ? `http_${status}` : "expo_error",
  ) {
    super(message);
  }
}

/** Pure. Expo's error code (extensions.errorCode), when it's a plain identifier. */
const safeCode = (errors: Array<{ extensions?: { errorCode?: string } }>) => {
  const c = errors.map((e) => e.extensions?.errorCode).find((x) => typeof x === "string" && /^[A-Z0-9_]{2,60}$/i.test(x));
  return c ? c.toLowerCase() : "graphql_error";
};

export type ExpoWho = { kind: "robot" | "user" | "other"; name: string; accounts: Array<{ id: string; name: string }> };
export type ExpoProject = { id: string; fullName: string };

export function createExpoApi(token: string, doFetch: FetchLike = fetch) {
  async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(EXPO_GRAPHQL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ query, variables }) });
    } catch {
      throw new ExpoApiError("day2 couldn't reach Expo. Try again in a minute.");
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new ExpoApiError("Expo didn't accept that token. Create a new one for the robot user and paste it whole.", res.status);
    let body: { data?: T; errors?: Array<{ message?: string; extensions?: { errorCode?: string } }> };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new ExpoApiError(`Expo answered ${res.status}. Try again in a minute.`, res.status);
    }
    if (body.errors?.length) {
      const m = redactToken(body.errors.map((e) => e.message ?? e.extensions?.errorCode ?? "error").join("; "), token).slice(0, 300);
      if (/unauthori|not authenticated|UNAUTHORIZED/i.test(m)) throw new ExpoApiError("Expo didn't accept that token. Create a new one for the robot user and paste it whole.", 401, "unauthorized");
      throw new ExpoApiError(`Expo said: ${m}`, res.status, safeCode(body.errors));
    }
    if (!body.data) throw new ExpoApiError(`Expo answered ${res.status} without data.`, res.status);
    return body.data;
  }

  return {
    /** Who the token is, and the accounts it can act for. */
    async whoami(): Promise<ExpoWho> {
      const d = await gql<{ meActor: { __typename: string; id: string; username?: string; firstName?: string | null; accounts: Array<{ id: string; name: string }> } | null }>(
        `query Day2Whoami { meActor { __typename id ... on User { username } ... on SSOUser { username } ... on Robot { firstName } accounts { id name } } }`,
      );
      const a = d.meActor;
      if (!a) throw new ExpoApiError("Expo didn't accept that token. Create a new one for the robot user and paste it whole.", 401);
      return { kind: a.__typename === "Robot" ? "robot" : /User/.test(a.__typename) ? "user" : "other", name: a.username ?? a.firstName ?? a.id, accounts: a.accounts ?? [] };
    },

    async projectById(id: string): Promise<ExpoProject | null> {
      try {
        const d = await gql<{ app: { byId: { id: string; fullName: string } } }>(`query Day2AppById($appId: String!) { app { byId(appId: $appId) { id fullName } } }`, { appId: id });
        return d.app.byId;
      } catch (err) {
        if (/not found|does not exist|could not find/i.test((err as Error).message)) return null;
        throw err;
      }
    },

    async projectByFullName(fullName: string): Promise<ExpoProject | null> {
      try {
        const d = await gql<{ app: { byFullName: { id: string; fullName: string } } }>(`query Day2AppByFullName($fullName: String!) { app { byFullName(fullName: $fullName) { id fullName } } }`, { fullName });
        return d.app.byFullName;
      } catch (err) {
        if (/not found|does not exist|could not find|experience/i.test((err as Error).message)) return null;
        throw err;
      }
    },

    async createProject(accountId: string, projectName: string): Promise<string> {
      const d = await gql<{ app: { createApp: { id: string } } }>(`mutation Day2CreateApp($appInput: AppInput!) { app { createApp(appInput: $appInput) { id } } }`, { appInput: { accountId, projectName } });
      return d.app.createApp.id;
    },

    /**
     * Uploads a Google service account key as the app's FCM V1 key and
     * assigns it to the Android app's credentials (what `eas credentials` →
     * Android → FCM V1 → Upload does).
     */
    async setFcmV1Key(o: { accountId: string; projectFullName: string; projectId: string; packageName: string; jsonKey: Record<string, unknown> }): Promise<void> {
      try {
        await uploadFcm(o);
      } catch (err) {
        // Expo's text could echo the key (a validation error quotes its input): only a fixed message and a code leave here.
        const e = err instanceof ExpoApiError ? err : null;
        throw new ExpoApiError("EAS didn't take the push key", e?.status, e?.code ?? "network");
      }
    },
  };

  async function uploadFcm(o: { accountId: string; projectFullName: string; projectId: string; packageName: string; jsonKey: Record<string, unknown> }): Promise<void> {
    {
      const key = await gql<{ googleServiceAccountKey: { createGoogleServiceAccountKey: { id: string } } }>(
        `mutation Day2CreateGsaKey($googleServiceAccountKeyInput: GoogleServiceAccountKeyInput!, $accountId: ID!) { googleServiceAccountKey { createGoogleServiceAccountKey(googleServiceAccountKeyInput: $googleServiceAccountKeyInput, accountId: $accountId) { id } } }`,
        { googleServiceAccountKeyInput: { jsonKey: o.jsonKey }, accountId: o.accountId },
      );
      const keyId = key.googleServiceAccountKey.createGoogleServiceAccountKey.id;
      const existing = await gql<{ app: { byFullName: { androidAppCredentials: Array<{ id: string }> } } }>(
        `query Day2AndroidCreds($projectFullName: String!, $applicationIdentifier: String) { app { byFullName(fullName: $projectFullName) { androidAppCredentials(filter: { applicationIdentifier: $applicationIdentifier }) { id } } } }`,
        { projectFullName: o.projectFullName, applicationIdentifier: o.packageName },
      );
      const credId = existing.app.byFullName.androidAppCredentials[0]?.id;
      if (credId) {
        await gql(`mutation Day2SetFcmV1($androidAppCredentialsId: ID!, $googleServiceAccountKeyId: ID!) { androidAppCredentials { setGoogleServiceAccountKeyForFcmV1(id: $androidAppCredentialsId, googleServiceAccountKeyId: $googleServiceAccountKeyId) { id } } }`, {
          androidAppCredentialsId: credId,
          googleServiceAccountKeyId: keyId,
        });
      } else {
        await gql(
          `mutation Day2CreateAndroidCreds($androidAppCredentialsInput: AndroidAppCredentialsInput!, $appId: ID!, $applicationIdentifier: String!) { androidAppCredentials { createAndroidAppCredentials(androidAppCredentialsInput: $androidAppCredentialsInput, appId: $appId, applicationIdentifier: $applicationIdentifier) { id } } }`,
          { androidAppCredentialsInput: { googleServiceAccountKeyForFcmV1Id: keyId }, appId: o.projectId, applicationIdentifier: o.packageName },
        );
      }
    }
  }
}

export type ExpoApi = ReturnType<typeof createExpoApi>;

/** Pure. The robot-user page for an Expo account (where the owner makes day2's token). */
export const robotsUrl = (account: string | null) => (account ? `https://expo.dev/accounts/${encodeURIComponent(account)}/settings/robots` : "https://expo.dev/settings/access-tokens");

/** Pure. The Expo slug and owner from app.json (expo.slug, expo.owner). */
export function expoConfig(appJson: unknown): { slug: string | null; owner: string | null; projectId: string | null } {
  const root = (appJson && typeof appJson === "object" ? (appJson as Record<string, unknown>) : {}) as Record<string, unknown>;
  const expo = ((root.expo as Record<string, unknown>) ?? root) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const projectId = s(((expo.extra as Record<string, unknown> | undefined)?.eas as Record<string, unknown> | undefined)?.projectId);
  return { slug: s(expo.slug), owner: s(expo.owner), projectId };
}
