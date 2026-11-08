/**
 * Hosting (docs/hosting.md): the backend of an app day2 builds, on Supabase,
 * in day2's own Supabase organization — database, sign-in (email, Apple,
 * Google), file storage, realtime and edge functions. One project per app
 * (production), plus previews per pull request (Supabase branching) or a
 * shared staging project. Costs reach the owner as credits (service `infra`).
 *
 * Secrets (database passwords, secret/service keys, the owner's Apple and
 * Google sign-in secrets, an SMTP password, the owner's own Supabase token
 * after a takeover) live only in the encrypted secret store (store.ts) and
 * never appear in this state, the API or logs.
 */

/** Regions accepted by POST /v1/projects (Management API, checked against its OpenAPI spec, November 2026). */
export const REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "sa-east-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "eu-central-1",
  "eu-central-2",
  "ap-east-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ap-northeast-2",
] as const;
export type Region = (typeof REGIONS)[number];

/** Where each region's data centre is (AWS), in plain words for owners and privacy notices. */
export const REGION_PLACE: Record<Region, { en: string; de: string; eu: boolean }> = {
  "us-east-1": { en: "North Virginia, USA", de: "Nord-Virginia, USA", eu: false },
  "us-east-2": { en: "Ohio, USA", de: "Ohio, USA", eu: false },
  "us-west-1": { en: "North California, USA", de: "Nordkalifornien, USA", eu: false },
  "us-west-2": { en: "Oregon, USA", de: "Oregon, USA", eu: false },
  "ca-central-1": { en: "Canada (Central)", de: "Kanada (Zentral)", eu: false },
  "sa-east-1": { en: "São Paulo, Brazil", de: "São Paulo, Brasilien", eu: false },
  "eu-west-1": { en: "Ireland (EU)", de: "Irland (EU)", eu: true },
  "eu-west-2": { en: "London, UK", de: "London, Vereinigtes Königreich", eu: false },
  "eu-west-3": { en: "Paris, France (EU)", de: "Paris, Frankreich (EU)", eu: true },
  "eu-north-1": { en: "Stockholm, Sweden (EU)", de: "Stockholm, Schweden (EU)", eu: true },
  "eu-central-1": { en: "Frankfurt, Germany (EU)", de: "Frankfurt, Deutschland (EU)", eu: true },
  "eu-central-2": { en: "Zurich, Switzerland", de: "Zürich, Schweiz", eu: false },
  "ap-east-1": { en: "Hong Kong", de: "Hongkong", eu: false },
  "ap-south-1": { en: "Mumbai, India", de: "Mumbai, Indien", eu: false },
  "ap-southeast-1": { en: "Singapore", de: "Singapur", eu: false },
  "ap-southeast-2": { en: "Sydney, Australia", de: "Sydney, Australien", eu: false },
  "ap-northeast-1": { en: "Tokyo, Japan", de: "Tokio, Japan", eu: false },
  "ap-northeast-2": { en: "Seoul, South Korea", de: "Seoul, Südkorea", eu: false },
};

/** Compute sizes accepted by POST /v1/projects (`desired_instance_size`). day2 starts every app on micro. */
export const INSTANCE_SIZES = ["nano", "micro", "small", "medium", "large", "xlarge", "2xlarge", "4xlarge"] as const;
export type InstanceSize = (typeof INSTANCE_SIZES)[number];

export type HostEnv = "production" | "staging";

export type Bucket = {
  /** Lowercase letters, digits, dashes (also the bucket id). */
  name: string;
  /** Public: anyone can read files by URL; everyone writes only their own folder. */
  public: boolean;
  maxBytes?: number;
  mimeTypes?: string[];
};

/** What the app's backend needs: from Create's product plan (`hostingPlanFrom`) or the owner. */
export type HostingPlan = {
  /** Set explicitly; otherwise chosen from `audience`. */
  region?: Region;
  audience?: { countries?: string[]; locales?: string[] };
  /** The app's language — email templates (en, de; others get English). */
  language: string;
  auth: { email: boolean; apple: boolean; google: boolean };
  buckets: Bucket[];
  realtime: boolean;
  instanceSize?: InstanceSize;
  /** The app's deep link scheme (app.json `scheme`), for sign-in redirects. */
  scheme: string | null;
  /** iOS bundle id / Android package: native Sign in with Apple's client id. */
  bundleId?: string | null;
};

export type ProjectStatus = "INACTIVE" | "ACTIVE_HEALTHY" | "ACTIVE_UNHEALTHY" | "COMING_UP" | "UNKNOWN" | "GOING_DOWN" | "INIT_FAILED" | "REMOVED" | "RESTORING" | "UPGRADING" | "PAUSING" | "RESTORE_FAILED";

export type ProjectRecord = {
  env: HostEnv;
  ref: string;
  name: string;
  region: Region;
  orgSlug: string;
  status: ProjectStatus;
  url: string;
  /** The publishable (or legacy anon) key — public by design: it's in the app. */
  publishableKey: string | null;
  instanceSize: InstanceSize;
  createdAt: string;
  /** Whose Supabase organization and token day2 manages it with. */
  managedBy: "day2" | "owner";
  pausedAt?: string | null;
  /** Last time something used it (migrations, previews) — staging pauses when idle. */
  lastUsedAt?: string;
};

/** The steps of setting up one environment, in order; each is done once and skipped after. */
export const STEPS = ["project", "healthy", "keys", "auth", "storage", "migrations", "functions", "advisors", "app_config", "ticket"] as const;
export type Step = (typeof STEPS)[number];

export type MigrationRecord = { env: HostEnv | `pr-${number}`; version: string; name: string; at: string; via: "api" | "cli"; ok: boolean; error?: string };

export type Finding = {
  /** Supabase's `cache_key`: the same finding keeps its key across runs. */
  key: string;
  kind: "security" | "performance";
  name: string;
  level: "ERROR" | "WARN" | "INFO";
  title: string;
  detail: string;
  remediation: string;
  table: string | null;
  ticketId: string | null;
  seenAt: string;
};

export type HealthSnapshot = {
  at: string;
  status: ProjectStatus;
  services: Array<{ name: string; status: "COMING_UP" | "ACTIVE_HEALTHY" | "UNHEALTHY" }>;
  dbBytes: number | null;
  diskBytes: number | null;
  diskUsedBytes: number | null;
  connections: number | null;
  maxConnections: number | null;
  /** Requests in the last 24 hours (Management API usage counts). */
  requests: { rest: number; auth: number; storage: number; realtime: number } | null;
  /** From the edge logs, last 24 hours. Not verified against Supabase's invoice. */
  egressBytes: number | null;
  functionInvocations: number | null;
  functionErrors: number | null;
  storageBytes: number | null;
  authUsers: number | null;
};

/** One day's hosting bill for one environment: credits only leave this module. */
export type UsageDay = { date: string; env: HostEnv; costUsd: number; credits: number; charged: boolean; parts: Record<string, number> };

export type Preview = { pr: number; branchId: string; ref: string; status: string; createdAt: string; migrations: "pending" | "passed" | "failed"; error?: string };

export type ProviderState = { state: "off" | "needs_setup" | "connected" | "failed"; label: string | null; checkedAt: string | null; error: string | null; renewBy?: string | null };

export type HostingLog = { at: string; text: string; credits?: number };

export type HostingState = {
  /** The owner chose "Host with day2" (or Create did). */
  enabled: boolean;
  plan: HostingPlan | null;
  projects: Partial<Record<HostEnv, ProjectRecord>>;
  done: Partial<Record<HostEnv, Step[]>>;
  /** What's running now ("project" → "ticket"), or null. */
  working: { env: HostEnv; step: Step; since: string } | null;
  previews: Preview[];
  /** "available": Supabase branching on day2's plan; "unavailable": a shared staging project instead. */
  branching: "available" | "unavailable" | "unknown";
  auth: {
    siteUrl: string | null;
    redirectUrls: string[];
    templatesLang: "en" | "de";
    smtp: "supabase" | "day2" | "owner";
    apple: ProviderState;
    google: ProviderState;
  };
  buckets: string[];
  functions: Array<{ slug: string; version: number; at: string }>;
  /** Function secret names day2 set (never the values). */
  secretNames: string[];
  migrations: MigrationRecord[];
  findings: Finding[];
  findingsAt: string | null;
  health: HealthSnapshot | null;
  usage: UsageDay[];
  /** The last day billed, per environment (YYYY-MM-DD). */
  billedThrough: Partial<Record<HostEnv, string>>;
  backups: { at: string; pitr: boolean; daily: number; latest: string | null } | null;
  alerts: Array<{ key: string; at: string; ticketId: string | null; text: string }>;
  appConfig: { easJson: "written" | "pending" | "failed"; easEnv: "set" | "skipped" | "failed"; note: string | null } | null;
  backendTicket: string | null;
  takeover: { state: "none" | "ready" | "moved" | "failed"; orgSlug: string | null; at: string | null; by: string | null; error: string | null; warnings: string[] };
  problem: { text: string; at: string } | null;
  log: HostingLog[];
  /** Old design only: a standing demo project day2 created; removed once by retireLegacyDemo (hosting/demo.ts). New captures use a temporary database. */
  demo?: DemoBackend | null;
};

export const DEMO_STEPS = ["project", "healthy", "keys", "auth_config", "schemas", "migrations", "plan", "users", "rows", "uploads"] as const;
export type DemoStep = (typeof DEMO_STEPS)[number];

/** Old design: the standing demo project day2 created and filled — kept only so the one-time migration can delete it through the guard. */
export type DemoBackend = {
  /** Who created it — only a project day2 created as a demo is ever seeded. */
  createdBy: "day2-demo";
  ref: string;
  name: string;
  orgSlug: string;
  region: Region;
  url: string;
  publishableKey: string | null;
  createdAt: string;
  status: ProjectStatus;
  done: DemoStep[];
  working: DemoStep | null;
  migrations: { applied: number; total: number; failed: { file: string; error: string } | null };
  /** The seed plan used (data) and what it put in. */
  plan: { source: "model" | "heuristic"; tables: string[]; notes: string[] } | null;
  /** The whole seed plan (hosting/seed-plan.ts) — data only, checked against the schema. */
  spec?: unknown;
  seededAt: string | null;
  castSeed: number | null;
  rows: number;
  uploads: number;
  /** Rows and users day2 added (to replace them when the cast changes). */
  seeded: { users: string[]; rows: Array<{ table: string; column: string; values: string[] }> };
  pausedAt: string | null;
  problem: string | null;
  log: HostingLog[];
};

export const emptyProvider = (): ProviderState => ({ state: "off", label: null, checkedAt: null, error: null });

export function emptyState(): HostingState {
  return {
    enabled: false,
    plan: null,
    projects: {},
    done: {},
    working: null,
    previews: [],
    branching: "unknown",
    auth: { siteUrl: null, redirectUrls: [], templatesLang: "en", smtp: "supabase", apple: emptyProvider(), google: emptyProvider() },
    buckets: [],
    functions: [],
    secretNames: [],
    migrations: [],
    findings: [],
    findingsAt: null,
    health: null,
    usage: [],
    billedThrough: {},
    backups: null,
    alerts: [],
    appConfig: null,
    backendTicket: null,
    takeover: { state: "none", orgSlug: null, at: null, by: null, error: null, warnings: [] },
    problem: null,
    log: [],
  };
}

/** Secrets per app, in the encrypted store only. */
export type SecretKind =
  | "db_password:production"
  | "db_password:staging"
  | "secret_key:production"
  | "secret_key:staging"
  | "apple"
  | "google"
  | "smtp"
  | "owner_token"
  | "db_password:demo"
  | "secret_key:demo"
  /** The demo account Maestro signs in with ({ email, password }) — never logged or shown. */
  | "demo_login";

export type AppleSignIn = { teamId: string; keyId: string; privateKey: string; servicesId: string | null };
export type GoogleSignIn = { webClientId: string; webClientSecret: string; iosClientId: string | null; androidClientId: string | null };
export type SmtpSettings = { host: string; port: number; user: string; pass: string; from: string; senderName: string | null };
