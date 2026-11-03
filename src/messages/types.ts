/**
 * Messages: push notifications and in-app messages for the lifecycle
 * (docs/messages.md, docs/self-improving-app.md "Messages").
 *
 * Shared types. Users are always day2's hashed ids (`u_` + 32 hex); push
 * tokens stay in the token store and never reach events, logs, the API or
 * the console.
 */

export type PushPlatform = "ios" | "android";
export type Locale = "de" | "en";
export const LOCALES: Locale[] = ["de", "en"];

/** One device's Expo push token. */
export type PushToken = {
  user: string;
  token: string;
  platform: PushPlatform;
  /** IANA zone ("Europe/Berlin") when the app sent one. */
  tz: string | null;
  /** Minutes east of UTC, when the app sent an offset instead (or as well). */
  tzOffset: number | null;
  updatedAt: string;
  invalidatedAt: string | null;
  invalidReason: "not_registered" | "disabled" | null;
  /** The app's language on that device, when sent ("de" | "en"). */
  locale: Locale | null;
  /**
   * The library's device id that registered the token (the field-batch
   * device id). Only that device can replace or clear it; null for tokens
   * registered before day2 bound tokens to devices.
   */
  device?: string | null;
};

/** What the app sends (POST /api/ingest/:key/push, via day2.setPushToken). */
export type PushTokenInput = { user: string; token: string | null; platform: PushPlatform; tz?: string | null; tzOffset?: number | null; locale?: Locale | null; device?: string | null };

/** The library's device id (field-batch `device.id`). */
export const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Someone switched push off (or their device stopped accepting it). */
export type OptOut = { user: string; at: string; reason: "not_registered" | "disabled" };

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export type CampaignKind = "lifecycle" | "trigger" | "announcement";

/**
 * Who a lifecycle campaign is for (retention.ts states):
 *  - onboarding_d1: new users who started yesterday and haven't been back;
 *  - onboarding_d3: new users who started three days ago and haven't been back in the last two days;
 *  - at_risk, lapsing: those lifecycle states;
 *  - winback: dormant users seen within the last 400 days (tokens older than that are gone).
 */
export type Audience = "onboarding_d1" | "onboarding_d3" | "at_risk" | "lapsing" | "winback";
export const AUDIENCES: Audience[] = ["onboarding_d1", "onboarding_d3", "at_risk", "lapsing", "winback"];
export const AUDIENCE_LABEL: Record<Audience, string> = {
  onboarding_d1: "New users, the day after they started",
  onboarding_d3: "New users, three days after they started",
  at_risk: "At-risk users",
  lapsing: "Lapsing users",
  winback: "Users who have been away a long time",
};

export type Channel = "push" | "in_app" | "both";
export type Text = { title: string; body: string; cta?: string };

export type CampaignStatus =
  /** Texts being written or failed their checks. */
  | "draft"
  /** Waiting for the owner's OK (announcements by default). */
  | "waiting"
  | "active"
  | "paused"
  /** Stopped by day2 (worse than the holdout, or the guardrail) or the owner. */
  | "stopped"
  /** An announcement that reached everyone it was going to. */
  | "done";

export type CampaignResult =
  | { state: "collecting"; note: string; treated: number; held: number }
  | { state: "too_few"; note: string; treated: number; held: number }
  | {
      state: "better" | "worse" | "no_difference";
      treated: number;
      held: number;
      treatedRate: number;
      heldRate: number;
      probabilityBetter: number;
      note: string;
    };

export type Guardrail = { recipients: number; optedOut: number; heldWithPush: number; heldOptedOut: number; tripped: boolean; note: string };

export type Campaign = {
  id: string;
  kind: CampaignKind;
  name: string;
  /** Lifecycle campaigns. */
  audience?: Audience;
  /** Trigger campaigns: the event that sends it (the recipient is props.to, else the event's user). */
  trigger?: { event: string };
  channel: Channel;
  /** In-app: the moment in the app it's shown (the app calls day2.message(trigger)). */
  inApp?: { trigger: string; cap: { total: number; perDay: number } };
  /** Per locale; "en" is the fallback. Title ≤ 40, body ≤ 120 characters. */
  texts: Partial<Record<Locale, Text>>;
  /** Where a tap leads, as an app route ("/practice"); absent = the app's start. */
  route?: string;
  status: CampaignStatus;
  holdout: number;
  /** Who wrote the texts. */
  by: "day2" | "owner";
  createdAt: string;
  updatedAt: string;
  approvedAt?: string | null;
  approvedBy?: string | null;
  /** Announcements: when everyone was queued. */
  queuedAt?: string | null;
  /** Announcements: not before this time (each user at their next good local time after it). */
  sendAfter?: string | null;
  checks: { ok: boolean; issues: string[] };
  result: CampaignResult;
  guardrail?: Guardrail | null;
  inAppStats?: { shown: number; tapped: number; dismissed: number } | null;
  opened?: number;
  stoppedReason?: string | null;
  credits?: number;
};

export type Autonomy = "auto" | "ask";

export type MessagesSettings = {
  /** The whole module. Off = nothing is planned or sent. */
  enabled: boolean;
  /** Local hours (0–23): no push from `start` to `end`. */
  quietHours: { start: number; end: number };
  /** Push per user per 7 days, across all campaigns. */
  maxPerWeek: number;
  /** Lifecycle and trigger campaigns: day2 decides (default). Announcements: ask me first (default). */
  autonomy: { lifecycle: Autonomy; announcements: Autonomy };
  /** The share of each campaign's audience that never gets it, to measure it. */
  holdout: number;
};

export const DEFAULT_SETTINGS: MessagesSettings = {
  enabled: true,
  quietHours: { start: 21, end: 9 },
  maxPerWeek: 3,
  autonomy: { lifecycle: "auto", announcements: "ask" },
  holdout: 0.1,
};

export type MessagesState = {
  settings: MessagesSettings;
  campaigns: Campaign[];
  /** When each part of the pass last ran (ISO). */
  ran: { due?: string; plan?: string; daily?: string; triggersUntil?: string };
  /** The setup ticket (expo-notifications, permission timing, token, taps, in-app component). */
  setupTicketId?: string | null;
  /** Something only the owner can fix (push credentials, Expo access token). */
  problem?: { at: string; text: string } | null;
  /** Owner's activity log for this module (newest first, short). */
  log: Array<{ at: string; text: string; credits?: number }>;
};

// ---------------------------------------------------------------------------
// Sends
// ---------------------------------------------------------------------------

export type SendStatus =
  /** Waiting for the user's next good local time. */
  | "queued"
  /** In the holdout: never sent, counted for measurement. */
  | "held"
  /** Handed to Expo (ticket ok, receipt pending). */
  | "sent"
  /** Delivered to Apple/Google (receipt ok). */
  | "delivered"
  | "failed"
  /** Not sent: the time window passed, a limit was reached, or the token went away. */
  | "skipped";

export type SendRecord = {
  id: string;
  campaignId: string;
  user: string;
  channel: "push" | "in_app";
  arm: "on" | "holdout";
  status: SendStatus;
  locale: Locale | null;
  /** When the user entered the audience (the measurement starts here). */
  eligibleAt: string;
  dueAt: string;
  expiresAt: string;
  sentAt: string | null;
  /** Expo's receipt ids for this push, one per device (`device`: a short hash of the token, never the token). */
  receipts: Array<{ id: string; device: string }>;
  error: string | null;
  checkedAt: string | null;
};

export const TITLE_MAX = 40;
export const BODY_MAX = 120;
export const CTA_MAX = 24;
export const USER_RE = /^u_[0-9a-f]{32}$/;
/** Tokens not seen for this long are deleted. */
export const TOKEN_KEEP_DAYS = 400;
/** Send records and opt-outs (hashed users only). */
export const SENDS_KEEP_DAYS = 400;
