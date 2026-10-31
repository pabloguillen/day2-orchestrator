import { createSign } from "node:crypto";
import { redact, request, tokenCache, type RequestInit2 } from "../ads/http";
import { PlatformError } from "../ads/types";
import type { Play, PlayLifecycle } from "./adapters";
import type { PlayCredential } from "./credentials";

/**
 * Google Play Developer API v3 — staged rollouts on the production track.
 *
 * - Auth: the service account signs an RS256 JWT, exchanged for an access
 *   token (cached until a minute before it expires).
 * - Every change is one short edit: insert → tracks.get → tracks.update →
 *   validate → commit (ERROR_IF_IN_REVIEW), with the edit deleted when any
 *   step fails. Play allows one open edit per app, so operations on the
 *   same package are serialised in-process.
 * - Track updates are read-modify-write: during a staged rollout the track
 *   holds our inProgress/halted release AND the previous completed one,
 *   which must stay (it's what the other users keep getting). Only the
 *   release carrying our version code changes; other versions' drafts are
 *   kept; other versions' completed releases go once ours is completed, and
 *   other versions' inProgress/halted releases are superseded by ours.
 * - A commit Play refuses because changes must be sent for review manually
 *   (left over from a rejection) is NOT retried with changesNotSentForReview:
 *   the owner decides in Play Console.
 */

const BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const TRACK = "production";
const NOTES_MAX = 500;

type ReleaseStatus = "inProgress" | "halted" | "completed" | "draft";
type Release = {
  name?: string;
  versionCodes?: string[];
  status?: ReleaseStatus;
  userFraction?: number;
  releaseNotes?: Array<{ language: string; text: string }>;
  [k: string]: unknown;
};
type Track = { track?: string; releases?: Release[] };

export class PlayError extends Error {
  constructor(
    message: string,
    public status?: number,
    public retryable = false,
  ) {
    super(`Google Play: ${message}`);
  }
}

const DRAFT_APP = /only releases with status draft may be created on draft app/i;
const NOT_SENT_FOR_REVIEW = /changesNotSentForReview/i;

const LIFECYCLE: Record<string, PlayLifecycle> = {
  RELEASE_LIFECYCLE_STATE_DRAFT: "draft",
  RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW: "not_sent",
  RELEASE_LIFECYCLE_STATE_IN_REVIEW: "in_review",
  RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED: "approved_not_published",
  RELEASE_LIFECYCLE_STATE_NOT_APPROVED: "rejected",
  RELEASE_LIFECYCLE_STATE_PUBLISHED: "published",
  RELEASE_LIFECYCLE_STATE_UNSPECIFIED: "unknown",
};

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** Pure. An RS256-signed service-account assertion for the androidpublisher scope. */
export function serviceAccountJwt(cred: PlayCredential, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: cred.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  // Keys pasted through env/JSON sometimes carry literal "\n".
  const key = cred.privateKey.includes("\\n") ? cred.privateKey.replace(/\\n/g, "\n") : cred.privateKey;
  return `${header}.${claims}.${b64url(signer.sign(key))}`;
}

/** Pure. Play's limit is 500 characters per language. */
export function trimNotes(text: string): string {
  const t = text.trim();
  return t.length <= NOTES_MAX ? t : `${t.slice(0, NOTES_MAX - 1).trimEnd()}…`;
}

const hasCode = (r: Release, code: string) => (r.versionCodes ?? []).map(String).includes(code);

function friendly(message: string): string {
  if (DRAFT_APP.test(message)) return "the app has never been published on Google Play; publish the first release in Play Console (day2 can only roll out updates to a published app).";
  return message;
}

export function createPlay(cred: PlayCredential, deps: { fetch?: typeof fetch; now?: () => Date } = {}): Play {
  const now = deps.now ?? (() => new Date());
  const httpDeps = { fetch: deps.fetch, now };

  /** JSON call with Google's error.message surfaced (and tokens redacted). */
  async function call<T>(url: string, init: RequestInit2 = {}): Promise<T> {
    let res: Response;
    try {
      res = await request<Response>("google", httpDeps, url, { ...init, rawResponse: true });
    } catch (err) {
      if (err instanceof PlatformError) throw new PlayError(err.message.replace(/^google: /, ""), err.status, err.retryable);
      throw err;
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 500);
      try {
        const j = JSON.parse(text) as { error?: { message?: string } | string; error_description?: string };
        msg = typeof j.error === "object" && j.error?.message ? j.error.message : j.error_description ?? (typeof j.error === "string" ? j.error : msg);
      } catch {
        /* not JSON */
      }
      throw new PlayError(`${res.status} ${redact(friendly(msg))}`, res.status, false);
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  const token = tokenCache(
    async () => {
      const r = await call<{ access_token: string; expires_in: number }>(TOKEN_URL, {
        method: "POST",
        form: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountJwt(cred, now()) },
      });
      return { accessToken: r.access_token, expiresInSec: r.expires_in };
    },
    () => now().getTime(),
  );

  const api = async <T>(path: string, init: RequestInit2 = {}): Promise<T> =>
    call<T>(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${await token()}` } });

  // One open edit per app: serialise per package.
  const locks = new Map<string, Promise<unknown>>();
  function locked<T>(pkg: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(pkg) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    locks.set(pkg, tail);
    void tail.then(() => {
      if (locks.get(pkg) === tail) locks.delete(pkg);
    });
    return run;
  }

  const app = (pkg: string) => `/applications/${encodeURIComponent(pkg)}`;

  /** Runs `fn` inside a fresh edit; commits it when `commit`, deletes it otherwise or on failure. */
  async function inEdit<T>(pkg: string, commit: boolean, fn: (editPath: string) => Promise<T>): Promise<T> {
    const edit = await api<{ id: string }>(`${app(pkg)}/edits`, { method: "POST", json: {} });
    const editPath = `${app(pkg)}/edits/${encodeURIComponent(edit.id)}`;
    let committed = false;
    try {
      const out = await fn(editPath);
      if (commit) {
        await api(`${editPath}:validate`, { method: "POST" });
        try {
          await api(`${editPath}:commit`, { method: "POST", query: { changesInReviewBehavior: "ERROR_IF_IN_REVIEW" } });
        } catch (err) {
          if (err instanceof PlayError && NOT_SENT_FOR_REVIEW.test(err.message))
            throw new PlayError(
              "changes are waiting in Play Console from a previous rejection and must be sent for review there (Publishing overview → Send for review). day2 won't send them on your behalf.",
              err.status,
            );
          throw err;
        }
        committed = true;
      }
      return out;
    } finally {
      if (!committed) await api(editPath, { method: "DELETE", retries: 1 }).catch(() => {});
    }
  }

  const getTrack = (editPath: string) => api<Track>(`${editPath}/tracks/${TRACK}`);
  const putTrack = (editPath: string, releases: Release[]) => api<Track>(`${editPath}/tracks/${TRACK}`, { method: "PUT", json: { track: TRACK, releases } });

  /** Read-modify-write of the production track around the release holding `code`. */
  function updateRelease(pkg: string, code: string, change: (current: Release | null, track: Release[]) => Release) {
    return locked(pkg, () =>
      inEdit(pkg, true, async (editPath) => {
        const releases = (await getTrack(editPath)).releases ?? [];
        const ours = change(releases.find((r) => hasCode(r, code)) ?? null, releases);
        const done = ours.status === "completed";
        const others = releases.filter((r) => !hasCode(r, code) && (r.status === "draft" || (!done && r.status === "completed")));
        await putTrack(editPath, [...others, ours]);
      }),
    );
  }

  const requireOurs = (r: Release | null, code: string): Release => {
    if (!r) throw new PlayError(`version code ${code} isn't on the production track (promote it first).`);
    return r;
  };

  const complete: Play["complete"] = ({ packageName, versionCode }) =>
    updateRelease(packageName, versionCode, (cur) => {
      const { userFraction: _drop, ...rest } = requireOurs(cur, versionCode);
      return { ...rest, status: "completed" };
    });

  const checkFraction = (f: number) => {
    if (!Number.isFinite(f) || f <= 0) throw new PlayError(`rollout fraction must be above 0 (got ${f}).`);
  };

  return {
    async promote({ packageName, versionCode, fraction, notes, name }) {
      checkFraction(fraction);
      await updateRelease(packageName, versionCode, (_cur, releases) => {
        const language = releases.flatMap((r) => r.releaseNotes ?? []).find((n) => n.language)?.language ?? "en-US";
        const release: Release = { name, versionCodes: [versionCode], status: fraction >= 1 ? "completed" : "inProgress", releaseNotes: [{ language, text: trimNotes(notes) }] };
        if (fraction < 1) release.userFraction = fraction;
        return release;
      });
    },

    async setFraction({ packageName, versionCode, fraction }) {
      checkFraction(fraction);
      if (fraction >= 1) return complete({ packageName, versionCode });
      await updateRelease(packageName, versionCode, (cur) => ({ ...requireOurs(cur, versionCode), status: "inProgress", userFraction: fraction }));
    },

    async halt({ packageName, versionCode }) {
      await updateRelease(packageName, versionCode, (cur) => ({ ...requireOurs(cur, versionCode), status: "halted" }));
    },

    complete,

    async status({ packageName, versionCode }) {
      const listed = await api<{ releases?: Array<{ releaseName?: string; activeArtifacts?: Array<{ versionCode?: string | number }>; releaseLifecycleState?: string }> }>(
        `${app(packageName)}/tracks/${TRACK}/releases`,
      );
      const summary = (listed?.releases ?? []).find((r) => (r.activeArtifacts ?? []).some((a) => String(a.versionCode) === versionCode));
      const lifecycle: PlayLifecycle = summary ? (LIFECYCLE[summary.releaseLifecycleState ?? ""] ?? "unknown") : "unknown";
      const ours = await locked(packageName, () => inEdit(packageName, false, async (editPath) => ((await getTrack(editPath)).releases ?? []).find((r) => hasCode(r, versionCode)) ?? null));
      return {
        lifecycle,
        status: ours?.status ?? null,
        fraction: typeof ours?.userFraction === "number" ? ours.userFraction : ours?.status === "completed" ? 1 : null,
      };
    },
  };
}
