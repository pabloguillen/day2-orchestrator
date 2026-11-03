/**
 * Store (App Store optimization) for an Expo / React Native app: the
 * listing texts per store and language, keyword research, screenshots,
 * Apple's product page tests and custom product pages, and ratings and
 * reviews. docs/store-listing.md has the whole picture.
 */

export type StoreId = "ios" | "android";

export type AppleField = "name" | "subtitle" | "keywords" | "promotionalText" | "description" | "whatsNew";
export type PlayField = "title" | "shortDescription" | "fullDescription";
export type ListingField = AppleField | PlayField;

export const APPLE_FIELDS: AppleField[] = ["name", "subtitle", "keywords", "promotionalText", "description", "whatsNew"];
export const PLAY_FIELDS: PlayField[] = ["title", "shortDescription", "fullDescription"];

/** Store limits. Apple's keywords count bytes (UTF-8), everything else characters. */
export const LIMITS: Record<ListingField, number> = {
  name: 30,
  subtitle: 30,
  keywords: 100,
  promotionalText: 170,
  description: 4000,
  whatsNew: 4000,
  title: 30,
  shortDescription: 80,
  fullDescription: 4000,
};

export type AppleListing = Partial<Record<AppleField, string>>;
export type PlayListing = Partial<Record<PlayField, string>>;

/** Locale → texts, as each store has them (Apple "de-DE", Play "de-DE"). */
export type Listings = {
  ios: Record<string, AppleListing> | null;
  android: Record<string, PlayListing> | null;
  readAt: string | null;
  /** Why a store couldn't be read (not connected, no app record…). */
  errors: Partial<Record<StoreId, string>>;
};

/**
 * How a change reaches the store:
 *  - "now": Apple's promotional text (no review needed) — applied at once;
 *  - "next_version": other Apple texts — staged, then written into the next
 *    App Store version day2 prepares (release flow) or the version being
 *    prepared in App Store Connect;
 *  - "edit_commit": Google Play — one edit with all approved changes, committed.
 */
export type ApplyHow = "now" | "next_version" | "edit_commit";

export type ProposalStatus = "pending" | "approved" | "staged" | "applied" | "rejected" | "failed";

export type Proposal = {
  id: string;
  store: StoreId;
  locale: string;
  field: ListingField;
  before: string;
  after: string;
  reason: string;
  /** Characters (bytes for Apple keywords) before/after, and the store's limit. */
  chars: { before: number; after: number; limit: number };
  applyHow: ApplyHow;
  status: ProposalStatus;
  researchId: string | null;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  appliedAt: string | null;
  /** App Store version the change went out with. */
  appliedTo: string | null;
  error: string | null;
};

export type KeywordStat = {
  term: string;
  country: string;
  /** Apps the App Store returns for the term (≤ 200, the API's cap). */
  results: number;
  /** Where the app itself appears in those results (1-based), or null. */
  rank: number | null;
  /** The top results' rating counts (a proxy for how hard the term is). */
  topRatings: number[];
  topApps: string[];
};

export type Competitor = { id: string; name: string; subtitle: string | null; seller: string; rating: number | null; ratings: number; genre: string | null; country: string };

export type ResearchRun = {
  id: string;
  at: string;
  /** Why it ran: schedule, a new release, or the owner asked. */
  why: "schedule" | "release" | "owner";
  version: string | null;
  locales: string[];
  keywords: KeywordStat[];
  competitors: Competitor[];
  summary: string;
  proposals: string[];
  credits: number;
};

export type ScreenshotSize = { id: string; store: StoreId; label: string; width: number; height: number; displayType: string | null };

export type ScreenshotShot = { name: string; caption: string; raw: string; framed: Record<string, string> };

export type ScreenshotSet = {
  id: string;
  at: string;
  locale: string;
  /** "draft": made, not approved; "approved": to upload; "uploaded"; "failed". */
  status: "draft" | "approved" | "uploaded" | "failed";
  shots: ScreenshotShot[];
  sizes: string[];
  uploaded: Partial<Record<StoreId, string>>;
  error: string | null;
};

export type TestStatus = "draft" | "waiting_approval" | "submitted" | "running" | "finished" | "stopped" | "failed";

export type StoreTest = {
  id: string;
  kind: "apple_ppo" | "play_experiment";
  name: string;
  /** What's tested, in a sentence (Apple tests screenshots and icons; Play also texts). */
  hypothesis: string;
  locale: string;
  /** Each variant against the current page: its screenshots (and, on Play, texts the owner enters there). */
  treatments: Array<{ name: string; screenshotSetId: string | null; note: string; ascId: string | null }>;
  trafficPercent: number;
  status: TestStatus;
  ascId: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** Entered by the owner (Play has no API; Apple shows results only in App Store Connect). */
  result: { winner: string; note: string; by: string | null; at: string } | null;
  error: string | null;
};

export type CustomPage = {
  id: string;
  name: string;
  /** What it's for: an ad campaign or experiment id ("B-4"), or a theme. */
  purpose: string;
  locale: string;
  promotionalText: string;
  screenshotSetId: string | null;
  ascId: string | null;
  ascVersionId: string | null;
  /** The page's App Store address (carries ?ppid=…). */
  url: string | null;
  ppid: string | null;
  status: "draft" | "waiting_approval" | "submitted" | "live" | "failed";
  /** Campaigns/experiments whose ads lead to this page. */
  campaigns: string[];
  createdAt: string;
  error: string | null;
};

/** "draft": waiting for the owner; "pending": approved, goes out in the next pass; "sent"; "failed"; "skipped": nothing to answer. */
export type ReplyState = "draft" | "pending" | "sent" | "failed" | "skipped";

export type StoreReview = {
  store: StoreId;
  id: string;
  rating: number;
  title: string;
  body: string;
  /** Public nickname, for showing on the page only (never in tickets or events). */
  author: string;
  territory: string | null;
  language: string | null;
  version: string | null;
  createdAt: string;
  /** A reply that was already on the store when day2 read the review. */
  existingReply: string | null;
  reply: { text: string; state: ReplyState; by: string | null; at: string; sentAt: string | null; error: string | null } | null;
  /** 1–2 stars describing a problem → the problem's key and the backlog ticket it went into. */
  problemKey: string | null;
  ticketId: string | null;
  triaged: boolean;
};

export type RatingSnapshot = { at: string; store: StoreId; version: string | null; average: number | null; count: number | null };

/** The Live config's `review` part (docs/self-improving-app.md). */
export type ReviewPrompt = { afterEvents: Record<string, number>; minDaysSinceInstall: number; minDaysBetween: number; notAfterProblem: boolean };

export type StoreAutonomy = {
  /** Listing texts and screenshots: "ask" (approval, default) or "auto" (day2 decides). */
  listing: "ask" | "auto";
  /** Product page tests and custom product pages. */
  tests: "ask" | "auto";
  /** Review replies: "ask" for every reply, or "auto_positive" (4–5 stars go out by themselves). */
  replies: "ask" | "auto_positive";
};

export type StoreSettings = {
  /** Store locales day2 works on, e.g. ["de-DE", "en-US"]. */
  locales: string[];
  autonomy: StoreAutonomy;
  researchEveryDays: number;
  reviewsEveryHours: number;
  reviewPrompt: ReviewPrompt;
  /** iPad screenshots only when the app supports tablets. */
  tablet: boolean;
};

export type StoreLogLine = { at: string; text: string; credits?: number };

export type StoreFile = {
  settings: StoreSettings;
  listings: Listings;
  proposals: Proposal[];
  nextProposal: number;
  research: ResearchRun[];
  screenshots: ScreenshotSet[];
  tests: StoreTest[];
  customPages: CustomPage[];
  ratings: RatingSnapshot[];
  reviewsFetchedAt: string | null;
  /** The store version the last research ran for (a new one triggers research). */
  researchedVersion: string | null;
  log: StoreLogLine[];
};

export const DEFAULT_REVIEW_PROMPT: ReviewPrompt = { afterEvents: { activated: 2 }, minDaysSinceInstall: 3, minDaysBetween: 120, notAfterProblem: true };

export const DEFAULT_SETTINGS: StoreSettings = {
  locales: ["en-US"],
  autonomy: { listing: "ask", tests: "ask", replies: "ask" },
  researchEveryDays: 30,
  reviewsEveryHours: 6,
  reviewPrompt: DEFAULT_REVIEW_PROMPT,
  tablet: false,
};

export function emptyStoreFile(): StoreFile {
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    listings: { ios: null, android: null, readAt: null, errors: {} },
    proposals: [],
    nextProposal: 1,
    research: [],
    screenshots: [],
    tests: [],
    customPages: [],
    ratings: [],
    reviewsFetchedAt: null,
    researchedVersion: null,
    log: [],
  };
}
