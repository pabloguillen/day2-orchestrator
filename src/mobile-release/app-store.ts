import { createSign } from "node:crypto";
import { redact, request, tokenCache, type RequestInit2 } from "../ads/http";
import { PlatformError, type PlatformId } from "../ads/types";
import type { AppStore, IosState } from "./adapters";
import type { AscCredential } from "./credentials";

/**
 * App Store Connect API — the App Store version, "What's New", phased
 * release, review submission and release of an iOS app.
 *
 * - Auth: an ES256 JWT signed with the team's API key (.p8), valid 19 min,
 *   reused until a minute before it expires.
 * - Review goes through reviewSubmissions (+ items); the old
 *   appStoreVersionSubmissions endpoint is gone.
 * - Apple's 409s carry a list of errors (missing screenshots, age rating,
 *   …); they're turned into one plain-language message for the owner.
 * - 429/5xx are retried by `request` (Retry-After respected).
 */

const BASE = "https://api.appstoreconnect.apple.com";
const AUD = "appstoreconnect-v1";
const TOKEN_TTL_SEC = 1140;
const NOTES_MAX = 4000;
const EDITABLE_STATES = ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"];
const OPEN_SUBMISSION_STATES = ["READY_FOR_REVIEW", "UNRESOLVED_ISSUES"];
// `request` only uses the id in its own error messages.
const PLATFORM = "appstore" as PlatformId;

type AppleError = { status?: string; code?: string; title?: string; detail?: string; meta?: { associatedErrors?: Record<string, AppleError[]> } };
type Resource<A = Record<string, unknown>> = { type: string; id: string; attributes?: A; relationships?: Record<string, { data?: { type: string; id: string } | Array<{ type: string; id: string }> | null }> };
type Doc<T> = { data: T; included?: Resource[] };

export class AppStoreError extends Error {
  constructor(
    message: string,
    public status?: number,
    public retryable = false,
    /** Apple's error codes (e.g. ENTITY_ERROR.ATTRIBUTE.INVALID), when it sent any. */
    public codes: string[] = [],
  ) {
    super(`App Store Connect: ${message}`);
  }
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** Pure. The ES256 bearer token App Store Connect expects. */
export function ascJwt(cred: AscCredential, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", kid: cred.keyId, typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: cred.issuerId, iat, exp: iat + TOKEN_TTL_SEC, aud: AUD }));
  const key = cred.privateKey.includes("\\n") ? cred.privateKey.replace(/\\n/g, "\n") : cred.privateKey;
  const signer = createSign("SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign({ key, dsaEncoding: "ieee-p1363" }))}`;
}

/** Pure. Apple's limit for "What's New" is 4000 characters. */
export function trimWhatsNew(text: string): string {
  const t = text.trim();
  return t.length <= NOTES_MAX ? t : `${t.slice(0, NOTES_MAX - 1).trimEnd()}…`;
}

/** Pure. Apple's error list (including associated errors) as one readable sentence list. */
export function describeAppleErrors(errors: AppleError[]): string {
  const out: string[] = [];
  const add = (e: AppleError) => {
    const line = (e.detail ?? e.title ?? e.code ?? "").trim();
    if (line && !out.includes(line)) out.push(line);
    for (const list of Object.values(e.meta?.associatedErrors ?? {})) for (const a of list) add(a);
  };
  for (const e of errors) add(e);
  return out.join("; ");
}

const VERSION_STATE: Record<string, IosState> = {
  PREPARE_FOR_SUBMISSION: "ready_for_submit",
  READY_FOR_REVIEW: "ready_for_submit",
  WAITING_FOR_REVIEW: "waiting_for_review",
  IN_REVIEW: "in_review",
  ACCEPTED: "in_review",
  PENDING_APPLE_RELEASE: "in_review",
  PROCESSING_FOR_DISTRIBUTION: "in_review",
  PENDING_DEVELOPER_RELEASE: "pending_release",
  READY_FOR_DISTRIBUTION: "ready_for_sale",
  READY_FOR_SALE: "ready_for_sale",
  REJECTED: "rejected",
  METADATA_REJECTED: "rejected",
  INVALID_BINARY: "rejected",
  DEVELOPER_REJECTED: "developer_rejected",
  WAITING_FOR_EXPORT_COMPLIANCE: "processing",
};

/** Pure. */
export function mapVersionState(appVersionState: string | null | undefined, appStoreState?: string | null): IosState {
  return VERSION_STATE[appVersionState ?? ""] ?? VERSION_STATE[appStoreState ?? ""] ?? "other";
}

type PhasedAttrs = { phasedReleaseState?: string; currentDayNumber?: number | null };
const PHASED = { INACTIVE: "inactive", ACTIVE: "active", PAUSED: "paused", COMPLETE: "complete" } as const;

/** Query string with JSON:API's bracketed keys and comma lists left readable. */
const qs = (params: Record<string, string | number>) =>
  Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%2C/g, ",")}`)
    .join("&");

const rel = (type: string, id: string) => ({ data: { type, id } });

export function createAppStore(cred: AscCredential, deps: { fetch?: typeof fetch; now?: () => Date; sleep?: (ms: number) => Promise<void> } = {}): AppStore {
  const now = deps.now ?? (() => new Date());
  const httpDeps = { fetch: deps.fetch, now, sleep: deps.sleep };

  const token = tokenCache(
    async () => ({ accessToken: ascJwt(cred, now()), expiresInSec: TOKEN_TTL_SEC }),
    () => now().getTime(),
  );

  async function api<T>(path: string, init: RequestInit2 = {}): Promise<T> {
    let res: Response;
    try {
      res = await request<Response>(PLATFORM, httpDeps, `${BASE}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${await token()}` },
        rawResponse: true,
      });
    } catch (err) {
      if (err instanceof PlatformError) throw new AppStoreError(err.message.replace(/^appstore: /, ""), err.status, err.retryable);
      throw err;
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 500);
      let codes: string[] = [];
      try {
        const j = JSON.parse(text) as { errors?: AppleError[] };
        if (Array.isArray(j.errors) && j.errors.length) {
          msg = describeAppleErrors(j.errors) || msg;
          codes = j.errors.map((e) => e.code ?? "").filter(Boolean);
        }
      } catch {
        /* not JSON */
      }
      const prefix = res.status === 409 ? "Apple can't accept this yet: " : `${res.status} `;
      throw new AppStoreError(`${prefix}${redact(msg)}`, res.status, false, codes);
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  const is = (err: unknown, status: number) => err instanceof AppStoreError && err.status === status;

  const appIds = new Map<string, string>();
  async function appIdFor(bundleId: string): Promise<string> {
    const cached = appIds.get(bundleId);
    if (cached) return cached;
    const r = await api<Doc<Resource[]>>(`/v1/apps?${qs({ "filter[bundleId]": bundleId, limit: 1 })}`);
    const id = r.data?.[0]?.id;
    if (!id) throw new AppStoreError(`There's no app with bundle id ${bundleId} in App Store Connect. Create the app record there (Apps → +) first.`);
    appIds.set(bundleId, id);
    return id;
  }

  async function phasedOf(versionId: string): Promise<Resource<PhasedAttrs> | null> {
    try {
      const r = await api<Doc<Resource<PhasedAttrs> | null>>(`/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionPhasedRelease`);
      return r?.data ?? null;
    } catch (err) {
      if (is(err, 404)) return null;
      throw err;
    }
  }

  async function setPhased(versionId: string, state: "PAUSED" | "ACTIVE") {
    const p = await phasedOf(versionId);
    if (!p) throw new AppStoreError("this version has no phased release.");
    await api(`/v1/appStoreVersionPhasedReleases/${encodeURIComponent(p.id)}`, {
      method: "PATCH",
      json: { data: { type: "appStoreVersionPhasedReleases", id: p.id, attributes: { phasedReleaseState: state } } },
    });
  }

  return {
    async findBuild({ bundleId, version, buildNumber }) {
      const appId = await appIdFor(bundleId);
      const r = await api<Doc<Array<Resource<{ processingState?: string; usesNonExemptEncryption?: boolean | null }>>>>(
        `/v1/builds?${qs({ "filter[app]": appId, "filter[version]": buildNumber, "filter[preReleaseVersion.version]": version, sort: "-uploadedDate", limit: 1 })}`,
      );
      const b = r.data?.[0];
      if (!b) return null;
      const ps = b.attributes?.processingState;
      const processing = ps === "VALID" ? "valid" : ps === "FAILED" || ps === "INVALID" ? "failed" : "processing";
      return { appId, buildId: b.id, processing, missingCompliance: b.attributes?.usesNonExemptEncryption == null };
    },

    async setNoNonExemptEncryption(buildId) {
      await api(`/v1/builds/${encodeURIComponent(buildId)}`, {
        method: "PATCH",
        json: { data: { type: "builds", id: buildId, attributes: { usesNonExemptEncryption: false } } },
      });
    },

    async submitForReview({ appId, version, buildId, notes, phased }) {
      // 1. The App Store version: reuse an editable one, or create it.
      const editable = await api<Doc<Array<Resource<{ versionString?: string }>>>>(
        `/v1/apps/${encodeURIComponent(appId)}/appStoreVersions?${qs({ "filter[platform]": "IOS", "filter[appVersionState]": EDITABLE_STATES.join(","), limit: 5 })}`,
      );
      let versionId: string;
      const existing = editable.data?.[0];
      if (existing) {
        versionId = existing.id;
        if (existing.attributes?.versionString !== version)
          await api(`/v1/appStoreVersions/${encodeURIComponent(versionId)}`, {
            method: "PATCH",
            json: { data: { type: "appStoreVersions", id: versionId, attributes: { versionString: version } } },
          });
      } else {
        const created = await api<Doc<Resource>>(`/v1/appStoreVersions`, {
          method: "POST",
          json: {
            data: {
              type: "appStoreVersions",
              attributes: { platform: "IOS", versionString: version, releaseType: "AFTER_APPROVAL" },
              relationships: { app: rel("apps", appId) },
            },
          },
        });
        versionId = created.data.id;
      }
      const v = encodeURIComponent(versionId);

      // 2. The build.
      await api(`/v1/appStoreVersions/${v}/relationships/build`, { method: "PATCH", json: { data: { type: "builds", id: buildId } } });

      // 3. "What's New" in every locale.
      const whatsNew = trimWhatsNew(notes);
      const locs = await api<Doc<Resource[]>>(`/v1/appStoreVersions/${v}/appStoreVersionLocalizations?${qs({ limit: 200 })}`);
      if (locs.data?.length) {
        for (const loc of locs.data)
          await api(`/v1/appStoreVersionLocalizations/${encodeURIComponent(loc.id)}`, {
            method: "PATCH",
            json: { data: { type: "appStoreVersionLocalizations", id: loc.id, attributes: { whatsNew } } },
          });
      } else {
        await api(`/v1/appStoreVersionLocalizations`, {
          method: "POST",
          json: { data: { type: "appStoreVersionLocalizations", attributes: { locale: "en-US", whatsNew }, relationships: { appStoreVersion: rel("appStoreVersions", versionId) } } },
        });
      }

      // 4. Phased release (Apple starts it when the version goes live).
      if (phased && !(await phasedOf(versionId))) {
        try {
          await api(`/v1/appStoreVersionPhasedReleases`, {
            method: "POST",
            json: {
              data: {
                type: "appStoreVersionPhasedReleases",
                attributes: { phasedReleaseState: "INACTIVE" },
                relationships: { appStoreVersion: rel("appStoreVersions", versionId) },
              },
            },
          });
        } catch (err) {
          // The first version of an app can't have one: go on without.
          if (!is(err, 409)) throw err;
        }
      }

      // 5. Review submission: reuse an open one or create it, add the version, submit.
      const open = await api<Doc<Resource[]>>(
        `/v1/reviewSubmissions?${qs({ "filter[app]": appId, "filter[platform]": "IOS", "filter[state]": OPEN_SUBMISSION_STATES.join(",") })}`,
      );
      let submissionId = open.data?.[0]?.id;
      if (!submissionId) {
        const created = await api<Doc<Resource>>(`/v1/reviewSubmissions`, {
          method: "POST",
          json: { data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: rel("apps", appId) } } },
        });
        submissionId = created.data.id;
      }
      const s = encodeURIComponent(submissionId);
      try {
        await api(`/v1/reviewSubmissionItems`, {
          method: "POST",
          json: {
            data: {
              type: "reviewSubmissionItems",
              relationships: { reviewSubmission: rel("reviewSubmissions", submissionId), appStoreVersion: rel("appStoreVersions", versionId) },
            },
          },
        });
      } catch (err) {
        if (!is(err, 409)) throw err;
        // Fine if the version is already in this submission; anything else is a real refusal.
        const items = await api<Doc<Resource[]>>(`/v1/reviewSubmissions/${s}/items?${qs({ include: "appStoreVersion", limit: 50 })}`);
        const there = (items.data ?? []).some((i) => {
          const d = i.relationships?.appStoreVersion?.data;
          return !!d && !Array.isArray(d) && d.id === versionId;
        });
        if (!there) throw err;
      }
      await api(`/v1/reviewSubmissions/${s}`, {
        method: "PATCH",
        json: { data: { type: "reviewSubmissions", id: submissionId, attributes: { submitted: true } } },
      });
      return { versionId };
    },

    async versionState(versionId) {
      const r = await api<Doc<Resource<{ appVersionState?: string; appStoreState?: string }>>>(
        `/v1/appStoreVersions/${encodeURIComponent(versionId)}?${qs({ include: "appStoreVersionPhasedRelease" })}`,
      );
      const state = mapVersionState(r.data.attributes?.appVersionState, r.data.attributes?.appStoreState);
      const p = (r.included ?? []).find((i) => i.type === "appStoreVersionPhasedReleases") as Resource<PhasedAttrs> | undefined;
      const ps = PHASED[(p?.attributes?.phasedReleaseState ?? "") as keyof typeof PHASED];
      return { state, phased: p && ps ? { state: ps, day: p.attributes?.currentDayNumber ?? null } : null };
    },

    async release(versionId) {
      await api(`/v1/appStoreVersionReleaseRequests`, {
        method: "POST",
        json: { data: { type: "appStoreVersionReleaseRequests", relationships: { appStoreVersion: rel("appStoreVersions", versionId) } } },
      });
    },

    pausePhased: (versionId) => setPhased(versionId, "PAUSED"),
    resumePhased: (versionId) => setPhased(versionId, "ACTIVE"),
  };
}
