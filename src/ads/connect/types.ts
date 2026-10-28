import type { PlatformDeps, PlatformId } from "../types";

/**
 * Connecting an ad platform in one click (OAuth), for each adapter in
 * ../platforms/<id>.ts. Each platform module exports `connect: PlatformConnect`.
 *
 * Who connects:
 *  - day2's operator connects day2's own ad account (spend billed in credits);
 *  - a customer can connect their own ad account instead (they pay the
 *    platform directly);
 *  - for platforms where ads show under the app's own page/profile, the
 *    app's owner connects to pick it (and, where the API allows, day2 grants
 *    itself access in the same step).
 *
 * Only day2's developer-app credentials come from the server environment;
 * everything a person connects is stored encrypted by day2.
 */

/** day2's developer app on the platform (client id/secret, developer token…), from the server environment. */
export type AppCredentials = Record<string, string>;

/** What a completed OAuth gives day2 (stored encrypted). */
export type Tokens = {
  accessToken: string;
  refreshToken?: string;
  /** OAuth 1.0a (X) token secret. */
  tokenSecret?: string;
  /** ms since epoch. */
  expiresAt?: number;
  /** Platform user/member id of whoever connected, when the platform returns it. */
  userId?: string;
  scopes?: string[];
};

export type AdAccountChoice = { id: string; name: string; currency: string; canSpend: boolean; problem?: string };

/** A page / company page / profile / handle the connecting person can run ads as. */
export type IdentityChoice = { ref: string; name: string; kind: string };

export type Purpose = "account" | "identity";

export interface PlatformConnect {
  platform: PlatformId;
  /** day2's developer app from env; null = this platform can't be connected on this server. */
  appCredentials(env: Record<string, string | undefined>): AppCredentials | null;
  /** The env vars appCredentials needs (shown to the operator when missing). */
  appEnv: string[];
  /**
   * Where to send the person. OAuth 1.0a platforms fetch a request token
   * first and return it in `pending` (stored by day2 with the state).
   */
  authorizeUrl(app: AppCredentials, o: { state: string; redirectUri: string; purpose: Purpose }, deps?: PlatformDeps): Promise<{ url: string; pending?: Record<string, string> }>;
  /** Exchanges the callback's query parameters for tokens. */
  exchange(app: AppCredentials, o: { query: Record<string, string>; redirectUri: string; pending?: Record<string, string> }, deps?: PlatformDeps): Promise<Tokens>;
  /** Ad accounts the connected person can use (any currency). */
  listAdAccounts(app: AppCredentials, tokens: Tokens, deps?: PlatformDeps): Promise<AdAccountChoice[]>;
  /** Pages/profiles the connected person can run ads as (app_account platforms). */
  listIdentities?(app: AppCredentials, tokens: Tokens, deps?: PlatformDeps): Promise<IdentityChoice[]>;
  /**
   * With the app owner's tokens, give day2's ad account the access it needs
   * to run ads as `ref` (e.g. LinkedIn page role, Meta Page access request).
   * "pending": the owner still has to approve something on the platform (`todo` says what).
   */
  grantIdentity?(app: AppCredentials, owner: Tokens, ref: string, day2: { tokens: Tokens; adAccountId: string }, deps?: PlatformDeps): Promise<{ status: "ready" | "pending"; todo?: string }>;
  /**
   * The adapter credentials (the shape ../platforms/<id>.ts `create` takes)
   * for a connected ad account.
   */
  credentials(app: AppCredentials, tokens: Tokens, adAccountId: string): unknown;
}
