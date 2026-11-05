/**
 * Store setup ("day2 fills out the store"): the checklist of everything
 * App Store Connect and Google Play need before the first submission, kept
 * in sync afterwards. docs/store-listing.md → "Store setup".
 *
 * Three kinds of items:
 *  - facts (URLs, contact, categories, age rating, review contact, price):
 *    day2 proposes them once from the code, the owner approves once, then
 *    day2 writes them through the API and keeps the store in line;
 *  - graphics (Google Play icon and feature graphic, App Store previews):
 *    made by day2, approved like screenshots (the listing autonomy setting);
 *  - guided steps (forms with no API): day2 prepares the exact answers, the
 *    owner clicks through and says "done".
 */

import type { StoreId } from "./types";

export type FactKey =
  | "ios.categories"
  | "ios.contentRights"
  | "ios.privacyUrls"
  | "ios.versionInfo"
  | "ios.ageRating"
  | "ios.review"
  | "ios.pricing"
  | "android.details"
  | "android.video";

export const FACT_KEYS: FactKey[] = ["ios.categories", "ios.contentRights", "ios.privacyUrls", "ios.versionInfo", "ios.ageRating", "ios.review", "ios.pricing", "android.details", "android.video"];

export type FactValue = Record<string, string | boolean | null>;

export type Fact = {
  value: FactValue;
  /** "proposed": waiting for the owner's OK; "approved": day2 writes it and keeps the store in line. */
  state: "proposed" | "approved";
  /** Where the proposal came from, in a sentence. */
  why: string;
  proposedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  /** Last time the store matched the approved value (written or read back). */
  syncedAt: string | null;
  /** Why it isn't in the store yet (Apple/Google's message, or what it waits for). */
  error: string | null;
  /** It needs a version being prepared; day2 writes it into the next one. */
  waitsForVersion?: boolean;
  /** Answers Apple didn't take through the API (age rating): the owner sets these by hand. */
  manual?: string[];
};

export type GuidedKey =
  | "ios.privacy"
  | "ios.ageRating"
  | "android.dataSafety"
  | "android.contentRating"
  | "android.targetAudience"
  | "android.ads"
  | "android.appAccess"
  | "android.declarations"
  | "android.category";

export type GraphicKind = "playIcon" | "featureGraphic" | "preview";

export type Graphic = {
  id: string;
  kind: GraphicKind;
  /** File name in day2's store-setup folder for the app. */
  file: string;
  /** App previews: the locale and Apple's preview type (IPHONE_67, …). */
  locale: string | null;
  previewType: string | null;
  status: "draft" | "approved" | "uploaded" | "failed";
  at: string;
  uploadedAt: string | null;
  error: string | null;
};

/** What the content agent worked out from the code (proposals and guided answers). */
export type ContentAnswers = {
  facts: {
    privacyPolicyUrl: string;
    privacyChoicesUrl: string;
    supportUrl: string;
    marketingUrl: string;
    contactEmail: string;
    contactPhone: string;
    copyrightHolder: string;
    primaryCategory: string;
    secondaryCategory: string;
    playCategory: string;
    playTags: string[];
    usesThirdPartyContent: boolean;
    signInRequired: boolean;
    reviewNotes: string;
    free: boolean;
  };
  /** Apple's ageRatingDeclarations attributes. */
  ageRating: Record<string, string | boolean | null>;
  play: {
    /** Target age groups (Play Console → Target audience and content). */
    targetAges: string[];
    appealsToChildren: boolean;
    containsAds: boolean;
    news: boolean;
    health: boolean;
    financial: boolean;
    government: boolean;
    /** Plain-language notes the IARC questionnaire answers rest on. */
    contentNotes: string;
  };
  /** One sentence per fact key: why day2 proposes it. */
  why: Partial<Record<FactKey | "ageRating", string>>;
};

export type SetupState = {
  facts: Partial<Record<FactKey, Fact>>;
  answers: ContentAnswers | null;
  answersAt: string | null;
  graphics: Graphic[];
  confirmed: Partial<Record<GuidedKey, { version: string; at: string; by: string | null }>>;
  /** The App Review demo account: encrypted (DAY2_SECRETS_KEY), never returned by the API. */
  demo: { secret: string; label: string; setAt: string; setBy: string | null } | null;
  /** Last read-back of items that are checks (icon, screenshots, build, …). */
  checks: Record<string, { at: string; ok: boolean; note: string }>;
  lastPassAt: string | null;
};

export const emptySetup = (): SetupState => ({ facts: {}, answers: null, answersAt: null, graphics: [], confirmed: {}, demo: null, checks: {}, lastPassAt: null });

/** What an item is, as the console shows it. */
export type SetupStatus = "done" | "waiting" | "owner" | "not_needed" | "pending" | "problem";

export type FieldSpec = { key: string; label: string; kind: "text" | "url" | "email" | "tel" | "textarea" | "bool" | "select"; options?: Array<[string, string]>; required?: boolean; max?: number };

export type WalkStep = { title: string; detail: string; link?: { label: string; url: string } };

export type SetupItem = {
  id: string;
  store: StoreId;
  title: string;
  status: SetupStatus;
  /** How it gets done: through the API, by the release flow, a check day2 does, or a guided step. */
  how: "api" | "release" | "check" | "guided";
  detail: string;
  /** Facts: the value, its fields (to edit before approving), why. */
  fact?: { key: FactKey; value: FactValue; state: Fact["state"]; why: string; fields: FieldSpec[]; approvedBy: string | null; syncedAt: string | null };
  /** Guided steps: the prepared answers (each with a copy button), the walkthrough, the version the owner confirms. */
  answers?: Array<{ q: string; a: string }>;
  steps?: WalkStep[];
  version?: string;
  confirmedAt?: string | null;
  link?: { label: string; url: string };
  graphics?: Array<{ id: string; kind: GraphicKind; status: Graphic["status"]; url: string; locale: string | null; error: string | null }>;
  /** App Review: whether a demo account is stored (never the credentials). */
  demo?: { set: boolean; label: string | null; setAt: string | null };
  error?: string | null;
};
