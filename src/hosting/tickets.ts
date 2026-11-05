import { createHash } from "node:crypto";
import type { NewTicketInput, Priority } from "../backlog";
import type { MigrationProblem } from "./migrations";
import type { Finding, HostingPlan } from "./types";

/**
 * Backlog tickets from Hosting: the hosted side of the app's backend (the
 * build agent writes it, in the app's own style), advisor findings, plan
 * limits coming close, and migrations that break the rules.
 */

export const BACKEND_KEY = "hosting:backend";
export const TYPES_KEY = "hosting:types";
const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);

/** Generated types beyond this size go in as "regenerate" instructions instead. */
const TYPES_MAX = 24_000;

/** The rules every ticket that touches the backend repeats. */
export const BACKEND_RULES = [
  "Rules for the backend (day2 checks them before anything reaches production):",
  "- Database changes are migrations in supabase/migrations/<UTC timestamp>_<name>.sql (e.g. 20261103120000_add_lists.sql). Never edit a migration that's already in main: write a new one.",
  "- Every table in the public schema gets `alter table public.<t> enable row level security;` and its policies in the same migration — per table, for each of select/insert/update/delete it needs, usually `using ((select auth.uid()) = user_id)`. A table without RLS is refused.",
  "- Backwards-compatible migrations only: people keep older app versions for weeks. Expand first (add tables, nullable columns or columns with a default, new views); switch the app over; contract later (drop or rename the old thing) in its own migration marked with a line `-- day2:contract`, only after the app versions that use the old shape are gone. day2 applies production migrations just before the over-the-air update or store build that needs them, and refuses unmarked destructive ones.",
  "- No secret or service key in the app, ever. The app only knows EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_KEY (the publishable key, public by design). Anything that needs more power runs in an edge function (supabase/functions/<name>/index.ts) and reads its secrets with Deno.env.get; list each secret's name in supabase/functions/.env.example (no values).",
].join("\n");

/** Pure. The ticket that implements the hosted side of the app's backend adapter (src/backend/, written by Create). */
export function backendTicketInput(o: { appName: string; plan: HostingPlan; types: string | null; dataNotes?: string[] }): NewTicketInput {
  const { plan } = o;
  const providers = [plan.auth.email && "email (a 6-digit code)", plan.auth.apple && "Sign in with Apple", plan.auth.google && "Google"].filter(Boolean) as string[];
  const types = o.types && o.types.length <= TYPES_MAX ? o.types : null;
  const steps: string[] = [
    `day2 now hosts ${o.appName}'s backend on Supabase (database, sign-in, files${plan.realtime ? ", realtime" : ""}${"" /* functions are optional */}). The app already has a backend adapter in src/backend/ with a typed interface, a local in-memory implementation and a TODO for the hosted one. Implement the hosted one with supabase-js, keeping the interface and the app's code style.`,
    "",
    "1. Packages: `npx expo install @supabase/supabase-js @react-native-async-storage/async-storage expo-secure-store react-native-url-polyfill`" + (plan.auth.apple ? " expo-apple-authentication expo-crypto" : "") + (plan.auth.google ? " @react-native-google-signin/google-signin" : "") + ". Native ones arrive with the native foundations store release; build on its branch if it isn't merged yet.",
    "2. The client (src/backend/supabase.ts): `import 'react-native-url-polyfill/auto'`; `createClient<Database>(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_KEY!, { auth: { storage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false } })`.",
    "   - Session storage: a small adapter that keeps the session encrypted — an AES key in expo-secure-store and the encrypted session in AsyncStorage (SecureStore holds only ~2 KB; Supabase's React Native guide shows this). AsyncStorage alone only if the app has no sign-in.",
    "   - AppState: `supabase.auth.startAutoRefresh()` when the app becomes active, `stopAutoRefresh()` when it goes to the background.",
    "3. Pick the implementation in src/backend/index.ts: hosted when both EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_KEY are set, else the local in-memory one (tests, previews without a backend). Never hard-code the URL or key; day2 sets them in eas.json and in EAS environment variables.",
    `4. Sign-in (${providers.join(", ") || "none planned"}):`,
    ...(plan.auth.email ? ["   - Email: `signInWithOtp({ email, options: { shouldCreateUser: true } })` then `verifyOtp({ email, token, type: 'email' })` with the 6-digit code the user types — no magic links to handle."] : []),
    ...(plan.auth.apple ? ["   - Apple (iOS): expo-apple-authentication `signInAsync` with a SHA-256-hashed nonce (expo-crypto), then `signInWithIdToken({ provider: 'apple', token: credential.identityToken, nonce: rawNonce })`. Show Apple's own button (AppleAuthenticationButton). Add `ios.usesAppleSignIn: true` and the expo-apple-authentication plugin to the app config."] : []),
    ...(plan.auth.google ? ["   - Google: @react-native-google-signin/google-signin with `webClientId` (and `iosClientId`) from EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID / EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID, then `signInWithIdToken({ provider: 'google', token: idToken })`. Add its config plugin with the iOS URL scheme."] : []),
    "   - After sign-in call day2.identify(user.id) (the library hashes it); on sign-out call day2.identify(null) and `supabase.auth.signOut()`.",
    `   - Redirects (if a flow needs one) use the app's scheme: ${plan.scheme ? `${plan.scheme}://auth/callback` : "<scheme>://auth/callback"}.`,
    "5. Data: every adapter method maps to typed queries on the generated `Database` type (`supabase.from('<table>').select(...)`), returning the adapter's own types. Handle `error` from every call; map it to the adapter's error type. Rows belong to `user_id = auth.uid()` unless the plan says data is shared.",
    ...(plan.buckets.length
      ? [
          `6. Files: buckets ${plan.buckets.map((b) => `"${b.name}"${b.public ? " (public)" : ""}`).join(", ")} exist with policies: users write only under their own folder. Upload with \`supabase.storage.from(bucket).upload(\`\${userId}/\${id}.\${ext}\`, arrayBuffer, { contentType })\` (read the file with expo-file-system as base64 → ArrayBuffer); show ${plan.buckets.some((b) => b.public) ? "public files with getPublicUrl and " : ""}private files with createSignedUrl.`,
        ]
      : []),
    ...(plan.realtime ? [`${plan.buckets.length ? 7 : 6}. Realtime where the plan needs live updates: \`supabase.channel('<table>').on('postgres_changes', { event: '*', schema: 'public', table, filter: 'user_id=eq.' + userId }, …).subscribe()\`, removed on unmount; add the table to the publication in a migration (\`alter publication supabase_realtime add table public.<t>;\`).`] : []),
    "",
    "Schema: write the tables the plan stores on the server as migrations (see the rules below), and keep src/backend/database.types.ts in step with them.",
    ...(types
      ? ["day2 generated the types of the current database (Management API, `supabase gen types typescript`). Put them in src/backend/database.types.ts as they are:", "```ts", types.trim(), "```"]
      : ["day2 will regenerate src/backend/database.types.ts from the database once the migrations are applied to staging; until then write it by hand in the same shape `supabase gen types typescript` produces."]),
    "",
    ...(o.dataNotes?.length ? ["What the plan stores on the server:", ...o.dataNotes.map((d) => `- ${d}`), ""] : []),
    BACKEND_RULES,
    "",
    "Tests: the adapter's existing tests run against both implementations; the hosted one with a mocked supabase client (no network). Test that the hosted implementation is chosen only when both env values are set, that sign-out clears the session and calls day2.identify(null), and that uploads go under the user's own folder.",
  ];
  return {
    title: "Hosted backend: connect the app to its database, sign-in and files",
    type: "feature",
    description: steps.join("\n"),
    doneWhen: [
      "src/backend has a supabase-js implementation of the adapter, chosen when EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_KEY are set",
      "The session is kept encrypted on the device and refreshed while the app is open",
      `Sign-in works with ${providers.join(", ") || "the planned methods"}`,
      "Every table is created in supabase/migrations with row level security and per-table policies",
      "No secret or service key anywhere in the app",
      "The app builds and its tests pass",
    ],
    priority: 2,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: BACKEND_KEY },
    actor: "day2",
    createdNote: "day2 hosts the app's backend (Hosting).",
  };
}

/** Pure. New generated types after migrations changed the schema. */
export function typesTicket(types: string, version: string): NewTicketInput {
  return {
    title: "Update the database types after the latest migrations",
    type: "task",
    description: ["The database changed. Replace src/backend/database.types.ts with these types (generated by day2 from the staging database) and fix anything that no longer type-checks:", "```ts", types.length <= TYPES_MAX ? types.trim() : "// too large to paste here — day2 will split it; regenerate locally with `supabase gen types typescript`", "```"].join("\n"),
    doneWhen: ["src/backend/database.types.ts matches the database", "`npx tsc --noEmit` passes"],
    priority: 3,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: `${TYPES_KEY}:${version}` },
    actor: "day2",
    createdNote: "The database schema changed (Hosting).",
  };
}

/** Pure. Advisor findings → tickets, one per kind of finding. RLS missing is P1 and a security problem. */
export function findingTickets(findings: Finding[]): Array<{ key: string; names: string[]; input: NewTicketInput }> {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    if (f.level === "INFO") continue;
    groups.set(f.name, [...(groups.get(f.name) ?? []), f]);
  }
  const out: Array<{ key: string; names: string[]; input: NewTicketInput }> = [];
  for (const [name, fs] of groups) {
    const rls = name === "rls_disabled_in_public" || name === "policy_exists_rls_disabled";
    const security = fs[0]!.kind === "security";
    const key = `hosting:advisor:${name}:${h(fs.map((f) => f.key).sort().join(","))}`;
    const priority: Priority = rls ? 1 : fs.some((f) => f.level === "ERROR") ? 2 : 3;
    out.push({
      key,
      names: fs.map((f) => f.key),
      input: {
        title: rls ? `Turn on row level security: ${fs.map((f) => f.table ?? "a table").join(", ")}` : `Database ${security ? "security" : "performance"}: ${fs[0]!.title}`,
        type: security ? "bug" : "improvement",
        description: [
          `Supabase's ${security ? "security" : "performance"} advisor found this in the app's production database:`,
          "",
          ...fs.map((f) => `- ${f.detail}${f.remediation ? ` (how to fix: ${f.remediation})` : ""}`),
          "",
          rls ? "Anyone with the app's public key can read and change these tables until row level security is on. Add a migration that enables it and adds the policies each table needs." : "Fix it with a migration (or in the edge function, if that's where it is).",
          "",
          BACKEND_RULES,
        ].join("\n"),
        doneWhen: rls ? ["Every table listed has row level security with policies, in a migration", "The advisor no longer reports it"] : ["The advisor no longer reports it", "The app builds and its tests pass"],
        priority,
        prioritySource: "day2",
        source: { kind: "day2_proposal", key },
        signals: security ? { security: rls } : {},
        actor: "day2",
        createdNote: "From Supabase's database advisor (Hosting).",
      },
    });
  }
  return out;
}

/** Pure. Migrations that break the rules (no RLS, destructive without the contract mark). */
export function migrationProblemTicket(problems: MigrationProblem[]): NewTicketInput {
  const key = `hosting:migrations:${h(problems.map((p) => `${p.file}:${p.kind}`).join("|"))}`;
  const rls = problems.some((p) => p.kind === "no_rls");
  return {
    title: rls ? "Migrations: tables without row level security" : "Migrations: split a change that breaks older app versions",
    type: "bug",
    description: ["day2 didn't apply the app's database migrations to production, because:", "", ...problems.map((p) => `- ${p.text}`), "", BACKEND_RULES].join("\n"),
    doneWhen: ["day2 applies the migrations to production without refusing them"],
    priority: rls ? 1 : 2,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key },
    signals: rls ? { security: true } : {},
    actor: "day2",
    createdNote: "Production migrations were held back (Hosting).",
  };
}

/** Pure. A limit is coming close (database size, disk, connections, function errors). */
export function alertTicket(kind: "database" | "disk" | "connections" | "functions" | "credits", text: string, month: string): NewTicketInput {
  const titles = { database: "The database is getting close to its included size", disk: "The database disk is almost full", connections: "The database is close to its connection limit", functions: "Edge functions are failing", credits: "Hosting will run out of credits soon" };
  const fix = {
    database: "Look for tables that grow without bound (logs, events, old drafts) and add clean-up, or archive old rows. If the data is needed, day2 moves the app to the next compute size and the extra storage is charged in credits.",
    disk: "Same as above; Supabase grows the disk by itself, but each grow takes hours to repeat.",
    connections: "Make sure the app doesn't open a connection per request in edge functions (use supabase-js, not a raw Postgres client) and that realtime channels are removed on unmount.",
    functions: "Find the failing function in the logs, fix it, and add a test for the case.",
    credits: "Top up credits or move to a bigger plan on the Credits page. If credits run out, day2 keeps the app's backend running for 14 days and then asks before pausing it.",
  };
  return {
    title: titles[kind],
    type: kind === "functions" ? "bug" : "task",
    description: [text, "", fix[kind]].join("\n"),
    doneWhen: kind === "credits" ? ["Enough credits for the next month of hosting"] : ["Below the limit again with room to grow"],
    priority: kind === "disk" || kind === "functions" ? 2 : 3,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: `hosting:alert:${kind}:${month}` },
    actor: "day2",
    createdNote: "Hosting health check.",
  };
}
