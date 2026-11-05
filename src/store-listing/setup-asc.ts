import { AppStoreError } from "../mobile-release/app-store";
import type { AscCredential } from "../mobile-release/credentials";
import { ascHttp, ascQs as qs, ascRel as rel, type AscDoc as Doc, type AscResource as Resource } from "./asc";

/**
 * App Store Connect API for store setup — the same key day2 releases with
 * (App Manager role). Each method reads first so a pass only writes what
 * differs. Endpoints (Apple's App Store Connect API reference):
 *
 *  - apps (contentRightsDeclaration), appInfos (primaryCategory /
 *    secondaryCategory → appCategories), appInfoLocalizations
 *    (privacyPolicyUrl, privacyChoicesUrl);
 *  - appStoreVersions (copyright, build), appStoreVersionLocalizations
 *    (supportUrl, marketingUrl);
 *  - ageRatingDeclarations (one per app info, read via
 *    appInfos/{id}/ageRatingDeclaration, changed with PATCH);
 *  - appStoreReviewDetails (one per version: contact, notes, demo account);
 *  - appPriceSchedules (+ appPricePoints) and v2 appAvailabilities
 *    (territoryAvailabilities);
 *  - appScreenshotSets (which display types a version has) and
 *    appPreviewSets / appPreviews (reserve, upload, commit).
 */

export type AscSetupClient = ReturnType<typeof createAscSetup>;

export const APPLE_CATEGORIES = [
  "BOOKS", "BUSINESS", "DEVELOPER_TOOLS", "EDUCATION", "ENTERTAINMENT", "FINANCE", "FOOD_AND_DRINK", "GAMES", "GRAPHICS_AND_DESIGN", "HEALTH_AND_FITNESS",
  "LIFESTYLE", "MAGAZINES_AND_NEWSPAPERS", "MEDICAL", "MUSIC", "NAVIGATION", "NEWS", "PHOTO_AND_VIDEO", "PRODUCTIVITY", "REFERENCE", "SHOPPING",
  "SOCIAL_NETWORKING", "SPORTS", "STICKERS", "TRAVEL", "UTILITIES", "WEATHER",
];

export type ReviewDetail = { contactFirstName: string; contactLastName: string; contactPhone: string; contactEmail: string; notes: string; demoAccountRequired: boolean; demoAccountName?: string; demoAccountPassword?: string };

const INFO_EDITABLE = ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "WAITING_FOR_REVIEW"];
const INFO_LIVE = ["READY_FOR_DISTRIBUTION", "READY_FOR_SALE"];

export function createAscSetup(cred: AscCredential, deps: Parameters<typeof ascHttp>[1] = {}) {
  const { api, all, uploadAsset } = ascHttp(cred, deps);
  const enc = encodeURIComponent;
  const missing = (err: unknown) => err instanceof AppStoreError && err.status === 404;

  /** The app info being prepared (editable), else the live one. */
  async function appInfo(appId: string): Promise<{ id: string; editable: boolean } | null> {
    const list = await api<Doc<Array<Resource<{ state?: string; appStoreState?: string }>>>>(`/v1/apps/${enc(appId)}/appInfos`);
    const st = (i: Resource<{ state?: string; appStoreState?: string }>) => i.attributes?.state ?? i.attributes?.appStoreState ?? "";
    const editable = (list.data ?? []).find((i) => INFO_EDITABLE.includes(st(i)));
    const live = (list.data ?? []).find((i) => INFO_LIVE.includes(st(i))) ?? list.data?.[0];
    const pick = editable ?? live;
    return pick ? { id: pick.id, editable: Boolean(editable) } : null;
  }

  const relId = (r: Resource, name: string): string | null => {
    const d = r.relationships?.[name]?.data;
    return d && !Array.isArray(d) ? d.id : null;
  };

  return {
    appInfo,

    // ---- App info ----

    async categories(infoId: string): Promise<{ primary: string | null; secondary: string | null }> {
      const r = await api<Doc<Resource>>(`/v1/appInfos/${enc(infoId)}?${qs({ include: "primaryCategory,secondaryCategory" })}`);
      return { primary: relId(r.data, "primaryCategory"), secondary: relId(r.data, "secondaryCategory") };
    },

    async setCategories(infoId: string, primary: string, secondary: string | null): Promise<void> {
      await api(`/v1/appInfos/${enc(infoId)}`, {
        method: "PATCH",
        json: {
          data: {
            type: "appInfos",
            id: infoId,
            relationships: { primaryCategory: rel("appCategories", primary), secondaryCategory: { data: secondary ? { type: "appCategories", id: secondary } : null } },
          },
        },
      });
    },

    async contentRights(appId: string): Promise<string | null> {
      const r = await api<Doc<Resource<{ contentRightsDeclaration?: string | null }>>>(`/v1/apps/${enc(appId)}?${qs({ "fields[apps]": "contentRightsDeclaration" })}`);
      return r.data.attributes?.contentRightsDeclaration ?? null;
    },

    async setContentRights(appId: string, value: "DOES_NOT_USE_THIRD_PARTY_CONTENT" | "USES_THIRD_PARTY_CONTENT"): Promise<void> {
      await api(`/v1/apps/${enc(appId)}`, { method: "PATCH", json: { data: { type: "apps", id: appId, attributes: { contentRightsDeclaration: value } } } });
    },

    /** Privacy links per locale of an app info. */
    async infoLocalizations(infoId: string): Promise<Array<{ id: string; locale: string; privacyPolicyUrl: string | null; privacyChoicesUrl: string | null }>> {
      const list = await all<{ locale?: string; privacyPolicyUrl?: string | null; privacyChoicesUrl?: string | null }>(`/v1/appInfos/${enc(infoId)}/appInfoLocalizations?${qs({ limit: 200 })}`);
      return list.map((l) => ({ id: l.id, locale: l.attributes?.locale ?? "", privacyPolicyUrl: l.attributes?.privacyPolicyUrl ?? null, privacyChoicesUrl: l.attributes?.privacyChoicesUrl ?? null }));
    },

    async setInfoLocalization(id: string, attrs: { privacyPolicyUrl?: string; privacyChoicesUrl?: string | null }): Promise<void> {
      await api(`/v1/appInfoLocalizations/${enc(id)}`, { method: "PATCH", json: { data: { type: "appInfoLocalizations", id, attributes: attrs } } });
    },

    // ---- Version ----

    async version(versionId: string): Promise<{ copyright: string | null; buildId: string | null }> {
      const r = await api<Doc<Resource<{ copyright?: string | null }>>>(`/v1/appStoreVersions/${enc(versionId)}?${qs({ include: "build" })}`);
      return { copyright: r.data.attributes?.copyright ?? null, buildId: relId(r.data, "build") };
    },

    async setCopyright(versionId: string, copyright: string): Promise<void> {
      await api(`/v1/appStoreVersions/${enc(versionId)}`, { method: "PATCH", json: { data: { type: "appStoreVersions", id: versionId, attributes: { copyright } } } });
    },

    async versionLocalizations(versionId: string): Promise<Array<{ id: string; locale: string; supportUrl: string | null; marketingUrl: string | null }>> {
      const list = await all<{ locale?: string; supportUrl?: string | null; marketingUrl?: string | null }>(`/v1/appStoreVersions/${enc(versionId)}/appStoreVersionLocalizations?${qs({ limit: 200 })}`);
      return list.map((l) => ({ id: l.id, locale: l.attributes?.locale ?? "", supportUrl: l.attributes?.supportUrl ?? null, marketingUrl: l.attributes?.marketingUrl ?? null }));
    },

    async setVersionLocalization(id: string, attrs: { supportUrl?: string; marketingUrl?: string | null }): Promise<void> {
      await api(`/v1/appStoreVersionLocalizations/${enc(id)}`, { method: "PATCH", json: { data: { type: "appStoreVersionLocalizations", id, attributes: attrs } } });
    },

    // ---- Age rating ----

    async ageRating(infoId: string): Promise<{ id: string; attributes: Record<string, unknown> } | null> {
      try {
        const r = await api<Doc<Resource | null>>(`/v1/appInfos/${enc(infoId)}/ageRatingDeclaration`);
        return r?.data ? { id: r.data.id, attributes: r.data.attributes ?? {} } : null;
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
    },

    async setAgeRating(id: string, attributes: Record<string, unknown>): Promise<void> {
      await api(`/v1/ageRatingDeclarations/${enc(id)}`, { method: "PATCH", json: { data: { type: "ageRatingDeclarations", id, attributes } } });
    },

    // ---- App Review information ----

    async reviewDetail(versionId: string): Promise<{ id: string; attributes: Partial<ReviewDetail> } | null> {
      try {
        const r = await api<Doc<Resource<Partial<ReviewDetail>> | null>>(`/v1/appStoreVersions/${enc(versionId)}/appStoreReviewDetail`);
        return r?.data ? { id: r.data.id, attributes: r.data.attributes ?? {} } : null;
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
    },

    async saveReviewDetail(versionId: string, existingId: string | null, attributes: ReviewDetail): Promise<string> {
      if (existingId) {
        await api(`/v1/appStoreReviewDetails/${enc(existingId)}`, { method: "PATCH", json: { data: { type: "appStoreReviewDetails", id: existingId, attributes } } });
        return existingId;
      }
      const r = await api<Doc<Resource>>(`/v1/appStoreReviewDetails`, {
        method: "POST",
        json: { data: { type: "appStoreReviewDetails", attributes, relationships: { appStoreVersion: rel("appStoreVersions", versionId) } } },
      });
      return r.data.id;
    },

    // ---- Pricing and availability ----

    /** The app's price now in a territory ("0.0" when free), or null when no price was ever set. */
    async currentPrice(appId: string, territory: string): Promise<string | null> {
      let scheduleId: string;
      try {
        const s = await api<Doc<Resource | null>>(`/v1/apps/${enc(appId)}/appPriceSchedule`);
        if (!s?.data) return null;
        scheduleId = s.data.id;
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
      const prices = await api<Doc<Array<Resource<{ startDate?: string | null; endDate?: string | null }>>>>(
        `/v1/appPriceSchedules/${enc(scheduleId)}/manualPrices?${qs({ include: "appPricePoint", "filter[territory]": territory, limit: 50 })}`,
      );
      const today = new Date().toISOString().slice(0, 10);
      const current = (prices.data ?? []).find((p) => (!p.attributes?.startDate || p.attributes.startDate <= today) && (!p.attributes?.endDate || p.attributes.endDate > today));
      if (!current) return null;
      const pointId = relId(current, "appPricePoint");
      const point = (prices.included ?? []).find((i) => i.type === "appPricePoints" && i.id === pointId) as Resource<{ customerPrice?: string }> | undefined;
      return point?.attributes?.customerPrice ?? null;
    },

    /** The price point for a customer price in a territory ("0" → free). */
    async pricePoint(appId: string, territory: string, price: string): Promise<string> {
      const points = await all<{ customerPrice?: string }>(`/v1/apps/${enc(appId)}/appPricePoints?${qs({ "filter[territory]": territory, limit: 200 })}`, 1200);
      const want = Number(price);
      const hit = points.find((p) => Number(p.attributes?.customerPrice ?? NaN) === want);
      if (!hit) throw new AppStoreError(`there's no App Store price of ${price} in ${territory} — pick one of Apple's price points.`);
      return hit.id;
    },

    /** One price for the app from today, in the base territory (Apple works out the others). */
    async setPrice(appId: string, territory: string, pricePointId: string): Promise<void> {
      await api(`/v1/appPriceSchedules`, {
        method: "POST",
        json: {
          data: {
            type: "appPriceSchedules",
            relationships: { app: rel("apps", appId), baseTerritory: rel("territories", territory), manualPrices: { data: [{ type: "appPrices", id: "${price-0}" }] } },
          },
          included: [{ type: "appPrices", id: "${price-0}", attributes: { startDate: null }, relationships: { appPricePoint: rel("appPricePoints", pricePointId) } }],
        },
      });
    },

    /** Territories the app is available in, or null when availability was never set. */
    async availability(appId: string): Promise<{ id: string; territories: Array<{ id: string; territory: string; available: boolean }> } | null> {
      let id: string;
      try {
        const r = await api<Doc<Resource | null>>(`/v1/apps/${enc(appId)}/appAvailabilityV2`);
        if (!r?.data) return null;
        id = r.data.id;
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
      const list = await all<{ available?: boolean }>(`/v2/appAvailabilities/${enc(id)}/territoryAvailabilities?${qs({ include: "territory", limit: 200 })}`);
      return { id, territories: list.map((t) => ({ id: t.id, territory: relId(t, "territory") ?? "", available: t.attributes?.available !== false })) };
    },

    async territories(): Promise<string[]> {
      return (await all(`/v1/territories?${qs({ limit: 200 })}`)).map((t) => t.id);
    },

    /** First-time availability: these territories, and new ones Apple adds later. */
    async createAvailability(appId: string, territories: string[]): Promise<void> {
      const ref = (t: string) => `\${t-${t}}`;
      await api(`/v2/appAvailabilities`, {
        method: "POST",
        json: {
          data: {
            type: "appAvailabilities",
            attributes: { availableInNewTerritories: true },
            relationships: { app: rel("apps", appId), territoryAvailabilities: { data: territories.map((t) => ({ type: "territoryAvailabilities", id: ref(t) })) } },
          },
          included: territories.map((t) => ({ type: "territoryAvailabilities", id: ref(t), attributes: { available: true }, relationships: { territory: rel("territories", t) } })),
        },
      });
    },

    async setTerritory(id: string, available: boolean): Promise<void> {
      await api(`/v1/territoryAvailabilities/${enc(id)}`, { method: "PATCH", json: { data: { type: "territoryAvailabilities", id, attributes: { available } } } });
    },

    // ---- Screenshots and previews ----

    /** The screenshot display types a version localization has (with at least one screenshot). */
    async screenshotTypes(localizationId: string): Promise<string[]> {
      const sets = await all<{ screenshotDisplayType?: string }>(`/v1/appStoreVersionLocalizations/${enc(localizationId)}/appScreenshotSets?${qs({ include: "appScreenshots", limit: 50 })}`);
      return sets.filter((s) => {
        const d = s.relationships?.appScreenshots?.data;
        return d === undefined || (Array.isArray(d) && d.length > 0);
      }).map((s) => s.attributes?.screenshotDisplayType ?? "").filter(Boolean);
    },

    /** Replaces a version localization's previews of one type with one video (Apple allows up to three). */
    async replacePreview(localizationId: string, previewType: string, file: string, posterFrame = "00:00:05:00"): Promise<string> {
      const sets = await api<Doc<Array<Resource<{ previewType?: string }>>>>(`/v1/appStoreVersionLocalizations/${enc(localizationId)}/appPreviewSets?${qs({ "filter[previewType]": previewType, limit: 10 })}`);
      let setId = (sets.data ?? []).find((s) => s.attributes?.previewType === previewType)?.id;
      if (setId) {
        for (const p of await all(`/v1/appPreviewSets/${enc(setId)}/appPreviews?${qs({ limit: 10 })}`)) await api(`/v1/appPreviews/${enc(p.id)}`, { method: "DELETE" });
      } else {
        const created = await api<Doc<Resource>>(`/v1/appPreviewSets`, {
          method: "POST",
          json: { data: { type: "appPreviewSets", attributes: { previewType }, relationships: { appStoreVersionLocalization: rel("appStoreVersionLocalizations", localizationId) } } },
        });
        setId = created.data.id;
      }
      return uploadAsset({ type: "appPreviews", file, parent: { rel: "appPreviewSet", type: "appPreviewSets", id: setId }, attributes: { mimeType: file.endsWith(".mov") ? "video/quicktime" : "video/mp4", previewFrameTimeCode: posterFrame } });
    },
  };
}
