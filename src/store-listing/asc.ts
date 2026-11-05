import { createHash } from "node:crypto";
import { redact, request, tokenCache, type RequestInit2 } from "../ads/http";
import { PlatformError, type PlatformId } from "../ads/types";
import { AppStoreError, ascJwt, describeAppleErrors } from "../mobile-release/app-store";
import type { AscCredential } from "../mobile-release/credentials";
import type { AppleField, AppleListing } from "./types";

/**
 * App Store Connect API for the store listing — the same API key day2
 * releases with (App Manager role):
 *
 *  - texts: appInfoLocalizations (name, subtitle — editable while a version
 *    is being prepared) and appStoreVersionLocalizations (description,
 *    keywords, promotional text, What's New). Promotional text can change on
 *    the live version at any time; the rest goes with a version;
 *  - screenshots: appScreenshotSets → appScreenshots (reserve, upload the
 *    parts Apple asks for, commit with the file's MD5);
 *  - product page optimization: appStoreVersionExperiments (v2) with
 *    treatments, treatment localizations and their screenshot sets;
 *  - custom product pages: appCustomProductPages with a version and
 *    localizations (created in one request);
 *  - ratings and reviews: customerReviews and customerReviewResponses.
 */

const BASE = "https://api.appstoreconnect.apple.com";
const TOKEN_TTL_SEC = 1140;
const PLATFORM = "appstore" as PlatformId;
export const EDITABLE_STATES = ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"];
const LIVE_STATES = ["READY_FOR_DISTRIBUTION", "READY_FOR_SALE"];

type Resource<A = Record<string, unknown>> = { type: string; id: string; attributes?: A; relationships?: Record<string, { data?: { type: string; id: string } | Array<{ type: string; id: string }> | null }> };
type Doc<T> = { data: T; included?: Resource[]; links?: { next?: string } };

export type ScreenshotTarget = { kind: "appStoreVersionLocalizations" | "appCustomProductPageLocalizations" | "appStoreVersionExperimentTreatmentLocalizations"; id: string };

export type AscReview = { id: string; rating: number; title: string; body: string; author: string; territory: string | null; createdAt: string; reply: string | null };

export type AscListingClient = ReturnType<typeof createAscListing>;

const VERSION_FIELDS: AppleField[] = ["description", "keywords", "promotionalText", "whatsNew"];
const INFO_FIELDS: AppleField[] = ["name", "subtitle"];

const qs = (params: Record<string, string | number>) =>
  Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%2C/g, ",")}`)
    .join("&");
const rel = (type: string, id: string) => ({ data: { type, id } });
const pick = (o: Record<string, unknown> | undefined, keys: AppleField[]): AppleListing => {
  const out: AppleListing = {};
  for (const k of keys) if (typeof o?.[k] === "string") out[k] = o[k] as string;
  return out;
};

/** Pure. MD5 of a file's bytes, as Apple's sourceFileChecksum wants it (hex). */
export const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");

type AscDeps = { fetch?: typeof fetch; now?: () => Date; sleep?: (ms: number) => Promise<void>; readFile?: (path: string) => Promise<Uint8Array> };

/**
 * The App Store Connect HTTP core the Store clients share: signed requests
 * with Apple's errors as one plain sentence, every page of a list, and the
 * asset upload Apple uses for screenshots and previews (reserve → upload
 * the parts it asks for → commit with the file's MD5).
 */
export function ascHttp(cred: AscCredential, deps: AscDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const httpDeps = { fetch: deps.fetch, now, sleep: deps.sleep };
  const readFile = deps.readFile ?? (async (p: string) => new Uint8Array(await Bun.file(p).arrayBuffer()));
  const token = tokenCache(async () => ({ accessToken: ascJwt(cred, now()), expiresInSec: TOKEN_TTL_SEC }), () => now().getTime());

  async function api<T>(path: string, init: RequestInit2 = {}): Promise<T> {
    let res: Response;
    try {
      res = await request<Response>(PLATFORM, httpDeps, path.startsWith("http") ? path : `${BASE}${path}`, {
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
        const j = JSON.parse(text) as { errors?: Parameters<typeof describeAppleErrors>[0] };
        if (Array.isArray(j.errors) && j.errors.length) {
          msg = describeAppleErrors(j.errors) || msg;
          codes = j.errors.map((e) => e.code ?? "").filter(Boolean);
        }
      } catch {
        /* not JSON */
      }
      throw new AppStoreError(`${res.status === 409 ? "Apple can't accept this yet: " : `${res.status} `}${redact(msg)}`, res.status, false, codes);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Every page of a list (Apple pages with links.next). */
  async function all<A>(path: string, max = 1000): Promise<Array<Resource<A>>> {
    const out: Array<Resource<A>> = [];
    let next: string | undefined = path;
    while (next && out.length < max) {
      const r: Doc<Array<Resource<A>>> = await api(next);
      out.push(...(r.data ?? []));
      next = r.links?.next;
    }
    return out;
  }

  type Op = { method?: string; url?: string; length?: number; offset?: number; requestHeaders?: Array<{ name: string; value: string }> };
  /** Reserves an asset (appScreenshots, appPreviews), uploads its parts, commits it with the MD5. Returns its id. */
  async function uploadAsset(o: { type: "appScreenshots" | "appPreviews"; file: string; parent: { rel: string; type: string; id: string }; attributes?: Record<string, unknown> }): Promise<string> {
    const bytes = await readFile(o.file);
    const fileName = o.file.split("/").pop()!;
    const reserved = await api<Doc<Resource<{ uploadOperations?: Op[] }>>>(`/v1/${o.type}`, {
      method: "POST",
      json: { data: { type: o.type, attributes: { fileName, fileSize: bytes.length, ...(o.attributes ?? {}) }, relationships: { [o.parent.rel]: rel(o.parent.type, o.parent.id) } } },
    });
    const id = reserved.data.id;
    for (const op of reserved.data.attributes?.uploadOperations ?? []) {
      const part = bytes.subarray(op.offset ?? 0, (op.offset ?? 0) + (op.length ?? bytes.length));
      const headers = Object.fromEntries((op.requestHeaders ?? []).map((h) => [h.name, h.value]));
      const res = await request<Response>(PLATFORM, httpDeps, op.url!, { method: (op.method ?? "PUT") as "PUT", headers, raw: part, rawResponse: true });
      if (!res.ok) throw new AppStoreError(`uploading ${fileName} failed (${res.status}).`, res.status);
    }
    await api(`/v1/${o.type}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      json: { data: { type: o.type, id, attributes: { uploaded: true, sourceFileChecksum: md5(bytes) } } },
    });
    return id;
  }

  return { api, all, uploadAsset, now };
}

export type AscHttp = ReturnType<typeof ascHttp>;
export type { Resource as AscResource, Doc as AscDoc };
export { qs as ascQs, rel as ascRel };

export function createAscListing(cred: AscCredential, deps: AscDeps = {}) {
  const { api, all, uploadAsset } = ascHttp(cred, deps);

  const ids = new Map<string, string>();
  async function appIdFor(bundleId: string): Promise<string> {
    const cached = ids.get(bundleId);
    if (cached) return cached;
    const r = await api<Doc<Resource[]>>(`/v1/apps?${qs({ "filter[bundleId]": bundleId, limit: 1 })}`);
    const id = r.data?.[0]?.id;
    if (!id) throw new AppStoreError(`There's no app with bundle id ${bundleId} in App Store Connect.`);
    ids.set(bundleId, id);
    return id;
  }

  type VersionAttrs = { versionString?: string; appVersionState?: string; appStoreState?: string };
  async function versions(appId: string) {
    const list = await api<Doc<Array<Resource<VersionAttrs>>>>(`/v1/apps/${encodeURIComponent(appId)}/appStoreVersions?${qs({ "filter[platform]": "IOS", limit: 10 })}`);
    const state = (v: Resource<VersionAttrs>) => v.attributes?.appVersionState ?? v.attributes?.appStoreState ?? "";
    const live = (list.data ?? []).find((v) => LIVE_STATES.includes(state(v)) || LIVE_STATES.includes(v.attributes?.appStoreState ?? "")) ?? null;
    const editable = (list.data ?? []).find((v) => EDITABLE_STATES.includes(state(v))) ?? null;
    return {
      live: live ? { id: live.id, version: live.attributes?.versionString ?? null } : null,
      editable: editable ? { id: editable.id, version: editable.attributes?.versionString ?? null } : null,
    };
  }

  type InfoAttrs = { state?: string; appStoreState?: string };
  /** The app info being prepared (editable name/subtitle), else the live one. */
  async function appInfos(appId: string) {
    const list = await api<Doc<Array<Resource<InfoAttrs>>>>(`/v1/apps/${encodeURIComponent(appId)}/appInfos`);
    const st = (i: Resource<InfoAttrs>) => i.attributes?.state ?? i.attributes?.appStoreState ?? "";
    const editable = (list.data ?? []).find((i) => ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED"].includes(st(i))) ?? null;
    const live = (list.data ?? []).find((i) => ["READY_FOR_DISTRIBUTION", "READY_FOR_SALE"].includes(st(i))) ?? list.data?.[0] ?? null;
    return { editable: editable?.id ?? null, live: live?.id ?? null };
  }

  async function versionLocalizations(versionId: string) {
    return all<Record<string, unknown> & { locale?: string }>(`/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations?${qs({ limit: 200 })}`);
  }

  async function infoLocalizations(infoId: string) {
    return all<Record<string, unknown> & { locale?: string }>(`/v1/appInfos/${encodeURIComponent(infoId)}/appInfoLocalizations?${qs({ limit: 200 })}`);
  }

  /** The version localization for a locale, created when it isn't there yet. */
  async function versionLocalizationId(versionId: string, locale: string): Promise<string> {
    const have = (await versionLocalizations(versionId)).find((l) => l.attributes?.locale === locale);
    if (have) return have.id;
    const r = await api<Doc<Resource>>(`/v1/appStoreVersionLocalizations`, {
      method: "POST",
      json: { data: { type: "appStoreVersionLocalizations", attributes: { locale }, relationships: { appStoreVersion: rel("appStoreVersions", versionId) } } },
    });
    return r.data.id;
  }

  return {
    appIdFor,
    versions,

    /** What the App Store shows (or is being prepared), per locale. */
    async readListing(appId: string): Promise<{ locales: Record<string, AppleListing>; versionId: string | null; version: string | null; editable: boolean }> {
      const v = await versions(appId);
      const target = v.editable ?? v.live;
      const out: Record<string, AppleListing> = {};
      if (target) for (const l of await versionLocalizations(target.id)) if (l.attributes?.locale) out[l.attributes.locale] = pick(l.attributes, VERSION_FIELDS);
      const info = await appInfos(appId);
      const infoId = info.editable ?? info.live;
      if (infoId) for (const l of await infoLocalizations(infoId)) if (l.attributes?.locale) out[l.attributes.locale] = { ...(out[l.attributes.locale] ?? {}), ...pick(l.attributes, INFO_FIELDS) };
      return { locales: out, versionId: target?.id ?? null, version: target?.version ?? null, editable: Boolean(v.editable) };
    },

    /** Promotional text, no review needed: on the live version (and the one being prepared, so it carries over). */
    async setPromotionalText(appId: string, locale: string, text: string): Promise<void> {
      const v = await versions(appId);
      const targets = [v.live, v.editable].filter((x): x is { id: string; version: string | null } => Boolean(x));
      if (!targets.length) throw new AppStoreError("the app has no App Store version yet.");
      for (const t of targets) {
        const id = await versionLocalizationId(t.id, locale);
        await api(`/v1/appStoreVersionLocalizations/${encodeURIComponent(id)}`, {
          method: "PATCH",
          json: { data: { type: "appStoreVersionLocalizations", id, attributes: { promotionalText: text } } },
        });
      }
    },

    /** Writes texts into a version being prepared: version texts on its localizations, name/subtitle on the app info being prepared. */
    async writeVersionTexts(appId: string, versionId: string, byLocale: Record<string, AppleListing>): Promise<void> {
      const info = await appInfos(appId);
      let infoLocs: Awaited<ReturnType<typeof infoLocalizations>> | null = null;
      for (const [locale, texts] of Object.entries(byLocale)) {
        const vAttrs = pick(texts as Record<string, unknown>, VERSION_FIELDS);
        if (Object.keys(vAttrs).length) {
          const id = await versionLocalizationId(versionId, locale);
          await api(`/v1/appStoreVersionLocalizations/${encodeURIComponent(id)}`, { method: "PATCH", json: { data: { type: "appStoreVersionLocalizations", id, attributes: vAttrs } } });
        }
        const iAttrs = pick(texts as Record<string, unknown>, INFO_FIELDS);
        if (!Object.keys(iAttrs).length) continue;
        if (!info.editable) throw new AppStoreError("the app's name and subtitle can only change while a new version is being prepared.");
        infoLocs ??= await infoLocalizations(info.editable);
        const have = infoLocs.find((l) => l.attributes?.locale === locale);
        if (have) await api(`/v1/appInfoLocalizations/${encodeURIComponent(have.id)}`, { method: "PATCH", json: { data: { type: "appInfoLocalizations", id: have.id, attributes: iAttrs } } });
        else
          await api(`/v1/appInfoLocalizations`, {
            method: "POST",
            json: { data: { type: "appInfoLocalizations", attributes: { locale, ...iAttrs }, relationships: { appInfo: rel("appInfos", info.editable) } } },
          });
      }
    },

    versionLocalizationId,

    /**
     * Replaces the screenshots of one display type on a target (a version,
     * custom product page or test treatment localization): the set is
     * created when missing, old screenshots go, each new one is reserved,
     * uploaded in the parts Apple asks for, and committed with its MD5.
     */
    async replaceScreenshots(target: ScreenshotTarget, displayType: string, files: string[]): Promise<{ setId: string; ids: string[] }> {
      const relName = target.kind.replace(/s$/, "") as "appStoreVersionLocalization" | "appCustomProductPageLocalization" | "appStoreVersionExperimentTreatmentLocalization";
      const sets = await api<Doc<Array<Resource<{ screenshotDisplayType?: string }>>>>(`/v1/${target.kind}/${encodeURIComponent(target.id)}/appScreenshotSets?${qs({ "filter[screenshotDisplayType]": displayType, limit: 10 })}`);
      let setId = (sets.data ?? []).find((s) => s.attributes?.screenshotDisplayType === displayType)?.id;
      if (setId) {
        const old = await all(`/v1/appScreenshotSets/${encodeURIComponent(setId)}/appScreenshots?${qs({ limit: 50 })}`);
        for (const s of old) await api(`/v1/appScreenshots/${encodeURIComponent(s.id)}`, { method: "DELETE" });
      } else {
        const created = await api<Doc<Resource>>(`/v1/appScreenshotSets`, {
          method: "POST",
          json: { data: { type: "appScreenshotSets", attributes: { screenshotDisplayType: displayType }, relationships: { [relName]: rel(target.kind, target.id) } } },
        });
        setId = created.data.id;
      }
      const out: string[] = [];
      for (const file of files.slice(0, 10)) out.push(await uploadAsset({ type: "appScreenshots", file, parent: { rel: "appScreenshotSet", type: "appScreenshotSets", id: setId } }));
      return { setId, ids: out };
    },

    // ---- Product page optimization (v2 experiments) ----

    async createExperiment(o: { appId: string; name: string; trafficProportion: number }): Promise<string> {
      const r = await api<Doc<Resource>>(`/v2/appStoreVersionExperiments`, {
        method: "POST",
        json: { data: { type: "appStoreVersionExperiments", attributes: { platform: "IOS", name: o.name.slice(0, 64), trafficProportion: Math.round(o.trafficProportion) }, relationships: { app: rel("apps", o.appId) } } },
      });
      return r.data.id;
    },

    /** A treatment and its localization (the place its screenshots and promotional text go). */
    async createTreatment(o: { experimentId: string; name: string; locale: string; promotionalText?: string }): Promise<{ treatmentId: string; localizationId: string }> {
      const t = await api<Doc<Resource>>(`/v1/appStoreVersionExperimentTreatments`, {
        method: "POST",
        json: { data: { type: "appStoreVersionExperimentTreatments", attributes: { name: o.name.slice(0, 64) }, relationships: { appStoreVersionExperimentV2: rel("appStoreVersionExperiments", o.experimentId) } } },
      });
      const l = await api<Doc<Resource>>(`/v1/appStoreVersionExperimentTreatmentLocalizations`, {
        method: "POST",
        json: { data: { type: "appStoreVersionExperimentTreatmentLocalizations", attributes: { locale: o.locale }, relationships: { appStoreVersionExperimentTreatment: rel("appStoreVersionExperimentTreatments", t.data.id) } } },
      });
      return { treatmentId: t.data.id, localizationId: l.data.id };
    },

    async startExperiment(experimentId: string): Promise<void> {
      await api(`/v2/appStoreVersionExperiments/${encodeURIComponent(experimentId)}`, {
        method: "PATCH",
        json: { data: { type: "appStoreVersionExperiments", id: experimentId, attributes: { started: true } } },
      });
    },

    async stopExperiment(experimentId: string): Promise<void> {
      await api(`/v2/appStoreVersionExperiments/${encodeURIComponent(experimentId)}`, {
        method: "PATCH",
        json: { data: { type: "appStoreVersionExperiments", id: experimentId, attributes: { started: false } } },
      });
    },

    async experimentState(experimentId: string): Promise<{ state: string; startDate: string | null; endDate: string | null; reviewRequired: boolean }> {
      const r = await api<Doc<Resource<{ state?: string; startDate?: string | null; endDate?: string | null; reviewRequired?: boolean }>>>(`/v2/appStoreVersionExperiments/${encodeURIComponent(experimentId)}`);
      return { state: r.data.attributes?.state ?? "UNKNOWN", startDate: r.data.attributes?.startDate ?? null, endDate: r.data.attributes?.endDate ?? null, reviewRequired: Boolean(r.data.attributes?.reviewRequired) };
    },

    // ---- Custom product pages ----

    /** A custom product page with one version and one localization (promotional text), in one request. Returns its address (with ppid). */
    async createCustomPage(o: { appId: string; name: string; locale: string; promotionalText: string; templateVersionId?: string | null }): Promise<{ id: string; url: string | null; versionId: string | null; localizationId: string | null }> {
      const vRef = "${new-version}";
      const lRef = "${new-localization}";
      const r = await api<Doc<Resource<{ url?: string }>>>(`/v1/appCustomProductPages`, {
        method: "POST",
        json: {
          data: {
            type: "appCustomProductPages",
            attributes: { name: o.name.slice(0, 64) },
            relationships: {
              app: rel("apps", o.appId),
              ...(o.templateVersionId ? { appStoreVersionTemplate: rel("appStoreVersions", o.templateVersionId) } : {}),
              appCustomProductPageVersions: { data: [{ type: "appCustomProductPageVersions", id: vRef }] },
            },
          },
          included: [
            { type: "appCustomProductPageVersions", id: vRef, relationships: { appCustomProductPageLocalizations: { data: [{ type: "appCustomProductPageLocalizations", id: lRef }] } } },
            { type: "appCustomProductPageLocalizations", id: lRef, attributes: { locale: o.locale, promotionalText: o.promotionalText } },
          ],
        },
      });
      const version = (r.included ?? []).find((i) => i.type === "appCustomProductPageVersions");
      const loc = (r.included ?? []).find((i) => i.type === "appCustomProductPageLocalizations");
      return { id: r.data.id, url: r.data.attributes?.url ?? null, versionId: version?.id ?? null, localizationId: loc?.id ?? null };
    },

    async customPageState(versionId: string): Promise<string> {
      const r = await api<Doc<Resource<{ state?: string }>>>(`/v1/appCustomProductPageVersions/${encodeURIComponent(versionId)}`);
      return r.data.attributes?.state ?? "UNKNOWN";
    },

    /** Sends a custom product page version or an experiment to App Review (one review submission, reused while open). */
    async submitItem(appId: string, item: { type: "appCustomProductPageVersions" | "appStoreVersionExperiments"; id: string }): Promise<void> {
      const open = await api<Doc<Resource[]>>(`/v1/reviewSubmissions?${qs({ "filter[app]": appId, "filter[platform]": "IOS", "filter[state]": "READY_FOR_REVIEW" })}`);
      let sid = open.data?.[0]?.id;
      if (!sid) sid = (await api<Doc<Resource>>(`/v1/reviewSubmissions`, { method: "POST", json: { data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: rel("apps", appId) } } } })).data.id;
      const relName = item.type === "appCustomProductPageVersions" ? "appCustomProductPageVersion" : "appStoreVersionExperimentV2";
      await api(`/v1/reviewSubmissionItems`, { method: "POST", json: { data: { type: "reviewSubmissionItems", relationships: { reviewSubmission: rel("reviewSubmissions", sid), [relName]: rel(item.type, item.id) } } } });
      await api(`/v1/reviewSubmissions/${encodeURIComponent(sid)}`, { method: "PATCH", json: { data: { type: "reviewSubmissions", id: sid, attributes: { submitted: true } } } });
    },

    // ---- Ratings and reviews ----

    /** Newest first; stops at `since` (or after `max`). */
    async reviews(appId: string, o: { since?: string | null; max?: number } = {}): Promise<AscReview[]> {
      type A = { rating?: number; title?: string; body?: string; reviewerNickname?: string; createdDate?: string; territory?: string };
      const out: AscReview[] = [];
      let next: string | undefined = `/v1/apps/${encodeURIComponent(appId)}/customerReviews?${qs({ sort: "-createdDate", limit: 100, include: "response" })}`;
      const max = o.max ?? 300;
      while (next && out.length < max) {
        const r: Doc<Array<Resource<A>>> = await api(next);
        const responses = new Map((r.included ?? []).filter((i) => i.type === "customerReviewResponses").map((i) => [i.id, String((i.attributes as { responseBody?: string } | undefined)?.responseBody ?? "")]));
        let older = false;
        for (const d of r.data ?? []) {
          const at = d.attributes?.createdDate ?? "";
          if (o.since && at && at <= o.since) {
            older = true;
            break;
          }
          const respRel = d.relationships?.response?.data;
          const respId = respRel && !Array.isArray(respRel) ? respRel.id : null;
          out.push({
            id: d.id,
            rating: Number(d.attributes?.rating ?? 0),
            title: d.attributes?.title ?? "",
            body: d.attributes?.body ?? "",
            author: d.attributes?.reviewerNickname ?? "",
            territory: d.attributes?.territory ?? null,
            createdAt: at,
            reply: respId ? (responses.get(respId) ?? "") : null,
          });
        }
        next = older ? undefined : r.links?.next;
      }
      return out;
    },

    async reply(reviewId: string, text: string): Promise<void> {
      await api(`/v1/customerReviewResponses`, {
        method: "POST",
        json: { data: { type: "customerReviewResponses", attributes: { responseBody: text }, relationships: { review: rel("customerReviews", reviewId) } } },
      });
    },
  };
}
