import type { BugReport } from "../types";
import { renderPlan } from "./plan";
import { openable } from "./screen-flow";
import type { ExpoBuild, Phase, ProductPlan, ScreenComparison } from "./types";

/**
 * After the owner approved the screen flow, the build agent implements it
 * one to one in four steps — (a) the design system as code, (b) the screens
 * and navigation exactly as drawn, (c) data and the backend behind
 * src/backend/, (d) polish and day2's wiring — each a "build" ticket for
 * runBuildAgent, checked (type check, lint, devices) before the next.
 */

export type BuildPhase = Extract<Phase, "theme" | "screens" | "backend" | "polish">;
export const BUILD_PHASES: BuildPhase[] = ["theme", "screens", "backend", "polish"];

const COMMON = [
  "This is a brand-new Expo app (Expo Router, TypeScript) that day2 just created. The owner approved every screen before anything was built:",
  "- PLAN.md: the product plan with every screen, its states and where each button goes.",
  "- design/screens/<id>.png and design/screens/<id>.html: the approved drawing of each screen (open the PNG to see it; the HTML has the exact texts, colors and sizes). <id>.android.png where Android differs.",
  "- design/design-system.json and design/style.png: the approved design system (colors, type, spacing, corners, components).",
  "- design/flow.json and design/flow-map.png: the screens and the navigation between them (each link: label → target screen id).",
  "Keep to Expo's managed workflow: no ios/ or android/ folders, add libraries with `npx expo install <pkg>` (it picks versions that match the SDK), and prefer Expo's own modules (expo-sqlite, expo-secure-store, expo-image…).",
  "Every screen in the plan lives at its route in app/ so it opens from a deep link (<scheme>://<route>). Don't change app.json identifiers, runtimeVersion, updates or eas.json — day2 set them. Don't edit .maestro/day2/ (day2's screenshot flow).",
  "Run `npx tsc --noEmit` and `npm run lint` before you finish and fix what they report.",
];

/** The backend step's hosting: on day2's Supabase (with Hosting's brief for the hosted side), or data on the device. */
export type StepHosting = { mode: "hosted"; brief: string; place: string } | { mode: "local"; why: "not_needed" | "not_configured" | "failed" };
type Ctx = { fieldEndpoint: string | null; fieldKey: string | null; libraryDir: string | null; nativeInstructions?: string[]; legacyMockups?: boolean; hosting?: StepHosting };

/** Pure. The ticket text of one build step. */
export function stepTicket(b: Pick<ExpoBuild, "request" | "identifiers">, plan: ProductPlan, phase: BuildPhase, ctx: Ctx): { title: string; description: string; doneWhen: string[] } {
  const name = b.request.displayName;
  const legacy = ctx.legacyMockups ? ["(This build started before every screen was drawn: design/mockups/ has the drawings of the key screens; draw the rest in the same style.)"] : [];
  if (phase === "theme") {
    return {
      title: `Turn ${name}'s design system into code`,
      description: [
        ...COMMON,
        ...legacy,
        "",
        "This step: the design system as code — no screens yet.",
        "1. src/theme/tokens.ts is written by day2 from design/design-system.json — use it, don't edit it. Add dark mode colors next to it (src/theme/colors.ts) derived from the same palette, and a useTheme() hook that picks light or dark.",
        "2. Components in src/components/ui/ for every component in the design system (buttons, list rows, cards, text fields, tab bar, empty state…) and a Text component with the type styles, each matching design/style.png and the drawings exactly (sizes, corners, spacing, colors).",
        "3. Remove the template's example screens and components (the default template's tabs/explore examples, its themed-text/view components, its colors constants); leave app/_layout.tsx and a placeholder app/index.tsx that renders one of the new components.",
        "4. Accessible: labels on icon buttons, text that scales, touch targets of at least 44 pt.",
        "5. A small test that renders each component (jest-expo if the project has no test setup yet: `npx expo install jest-expo jest @types/jest` and a \"test\" script).",
      ].join("\n"),
      doneWhen: ["src/theme/ has the tokens, dark mode and useTheme()", "Every component of the design system exists in src/components/ui/ and matches the style card", "The template's examples are gone", "Type check and lint pass"],
    };
  }
  if (phase === "screens") {
    const shots = plan.screens.filter(openable).length;
    return {
      title: `Build ${name}'s screens as approved`,
      description: [
        ...COMMON,
        ...legacy,
        "",
        "The theme and components exist (previous step). This step: every screen and the navigation, exactly as approved, with realistic sample data held in memory (the backend comes next).",
        "1. Every screen of the plan at its route, built from src/components/ui/ and src/theme/ only, one to one with its drawing: same layout, same texts, same order of elements. Screens in the \"states\" flow are states of their screen (empty, loading, error) — build them into that screen, not as routes of their own.",
        "2. Navigation exactly as the links in design/flow.json: every button goes where its link says (stacks, tabs and modals as the drawings suggest).",
        "3. The first minute in the plan works by tapping through.",
        `4. day2 checks this on virtual devices: .maestro/day2/screens.yaml opens ${shots} screen${shots === 1 ? "" : "s"} by deep link and takes a screenshot of each; the owner sees them next to the drawings. Make each route open without a signed-in user or data (sample data).`,
        "",
        renderPlan(plan, name),
      ].join("\n"),
      doneWhen: ["Every screen in the plan exists at its route and matches its drawing", "Every link goes where design/flow.json says", "Type check and lint pass"],
    };
  }
  if (phase === "backend") {
    if (ctx.hosting?.mode === "hosted") return hostedBackendStep(name, plan, ctx.hosting);
    const why = ctx.hosting?.why;
    return {
      title: `Add data and the backend to ${name}`,
      description: [
        ...COMMON,
        "",
        "The screens exist (previous step). This step: real data, accounts and server functions — behind the backend adapter in src/backend/.",
        `${why === "not_needed" ? "Everything stays on the device — this app needs no server." : why ? "This app keeps its data on the device for now: day2 hosts its backend later (Host with day2), and then connects it through hosted.ts." : "The app keeps its data on the device for now."} day2 wrote src/backend/: types.ts (the data model), adapter.ts (the Backend interface), local.ts (an in-memory implementation), hosted.ts (a TODO with the same interface) and index.ts (picks local). Don't add any provider SDK (no supabase-js, no Cloudflare client) and don't invent a server URL.`,
        "1. Refine the field types in src/backend/types.ts (they're all string for now) and keep adapter.ts and local.ts in step with them; give local.ts sensible sample data where a screen needs some on first launch.",
        "2. Persist what the plan keeps on the device: pass a persist store to localBackend in index.ts (AsyncStorage via `npx expo install @react-native-async-storage/async-storage`, or expo-sqlite for larger lists).",
        "3. Replace the screens' in-memory sample data with the backend (import { backend } from src/backend), with the empty, loading and error states as drawn.",
        `4. Money (${plan.monetization.model}): ${plan.monetization.model === "free" ? "nothing to add." : `build the placement as drawn (${plan.monetization.placement || "see the plan"}), with its texts, prices and on/off read from one config module (src/config.ts) with sensible defaults — no store billing or ad SDK yet (day2's Money module adds those with the native foundations release).`}`,
        `5. Accounts: ${plan.accounts ? "sign-up, sign-in and sign-out through backend.auth, as drawn; keep the session in expo-secure-store." : "none."}`,
        `6. Server functions: ${plan.functions?.length ? `${plan.functions.map((f) => f.name).join(", ")} — call them through backend.functions; local.ts does what it can on the device and the rest is a clear TODO in hosted.ts.` : "none."}`,
        "7. Unit tests for the data layer against localBackend() (create, list, update, remove, persistence; auth if there are accounts).",
        "",
        renderPlan(plan, name),
      ].join("\n"),
      doneWhen: ["Screens get their data only through src/backend/", "The plan's data survives a restart where it's kept on the device", "Empty, loading and error states as drawn", "Tests cover the backend adapter and pass", "No provider SDK added", "Type check and lint pass"],
    };
  }
  const field = ctx.fieldEndpoint && ctx.fieldKey && ctx.libraryDir;
  return {
    title: `Polish ${name} and wire in day2`,
    description: [
      ...COMMON,
      "",
      "Screens, components and data exist (previous steps). This step: polish and day2's wiring.",
      "1. Go through the first minute in the plan as a new user and fix anything rough: wording, keyboard handling, safe areas, haptics where they help — without moving away from the approved drawings.",
      "2. A Privacy screen (e.g. app/privacy.tsx, linked from settings or the about area) that shows PRIVACY.md's text (copy it into the screen or a module; keep the day2:privacy-start/end markers as comments).",
      ...(field
        ? [
            `3. day2 field checks: day2 placed its library in ${ctx.libraryDir}/native.js (with .d.ts). Once at startup in app/_layout.tsx:`,
            "```",
            `import { startDay2, releaseTag } from "<path>/${ctx.libraryDir}/native.js";`,
            `import * as Application from "expo-application";`,
            `import * as Updates from "expo-updates";`,
            `export const day2 = startDay2({ key: "${ctx.fieldKey}", endpoint: "${ctx.fieldEndpoint}", release: releaseTag(Application.nativeApplicationVersion, Application.nativeBuildVersion, Updates.isEmbeddedLaunch ? null : Updates.updateId) });`,
            "```",
            "   Then call day2.route(pathname) whenever usePathname() changes; day2.track(\"signup\") and day2.track(\"activated\") where the plan's first minute succeeds; wrap the main actions' press handlers in day2.action(\"<name>\", handler).",
            "   identify: when a user signs in or a session is restored call day2.identify(user.id); on sign-out day2.identify(null). Without accounts skip it.",
            "   A test shows startDay2 is called once with this key and endpoint.",
          ]
        : ["3. (day2's field checks are added later through a separate ticket — this server has no public address yet.)"]),
      "4. App icon and splash: keep the template's until the owner provides a logo, but set the splash background to the theme's background color.",
      ...(ctx.nativeInstructions?.length ? ["5. day2 installed these native packages for its modules; wire them in as described:", ...ctx.nativeInstructions.map((n) => `   - ${n}`)] : []),
      "",
      renderPlan(plan, name),
    ].join("\n"),
    doneWhen: ["The first minute works smoothly on a phone", "A Privacy screen shows the notice", ...(field ? ["day2 is started once at startup with the key and endpoint, screens and main actions report to it"] : []), "Tests, type check and lint pass"],
  };
}

/** Pure. The backend step when day2 hosts the app: the same data work, plus migrations, edge functions and hosted.ts with supabase-js. */
function hostedBackendStep(name: string, plan: ProductPlan, h: { brief: string; place: string }): { title: string; description: string; doneWhen: string[] } {
  return {
    title: `Add data and the hosted backend to ${name}`,
    description: [
      ...COMMON,
      "",
      "The screens exist (previous step). This step: real data, accounts, files and server functions — behind the backend adapter in src/backend/, on the backend day2 hosts for this app.",
      `day2 hosts it on Supabase (data stored in ${h.place}): a production and a staging project exist already. After you finish, day2 applies supabase/migrations/ to staging, deploys supabase/functions/, runs the device checks against staging (.env holds staging's public values), and only then applies the migrations to production.`,
      "day2 wrote src/backend/: types.ts (the data model), adapter.ts (the Backend interface), local.ts (an in-memory implementation — keep it: tests and builds without the env values use it), hosted.ts (to implement) and index.ts (picks hosted when EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_KEY are set, local in tests). Don't change that switch; never hard-code the URL or a key.",
      "1. Refine the field types in src/backend/types.ts (they're all string for now) and keep adapter.ts and local.ts in step with them.",
      "2. The database: one migration in supabase/migrations/<UTC timestamp>_<name>.sql with a table per type the plan keeps on the server, row level security turned on for every table and its policies in the same file.",
      "3. src/backend/hosted.ts: the Backend interface with supabase-js — typed client, sign-in with the session kept encrypted on the device, storage, realtime where the plan needs it — as described below.",
      "4. What the plan keeps only on the device stays in local collections (memoryCollection with AsyncStorage as persist), also inside hostedBackend.",
      "5. Replace the screens' in-memory sample data with the backend (import { backend } from src/backend), with the empty, loading and error states as drawn.",
      `6. Money (${plan.monetization.model}): ${plan.monetization.model === "free" ? "nothing to add." : `build the placement as drawn (${plan.monetization.placement || "see the plan"}), with its texts, prices and on/off read from one config module (src/config.ts) with sensible defaults — no store billing or ad SDK yet.`}`,
      `7. Server functions: ${plan.functions?.length ? `${plan.functions.map((f) => f.name).join(", ")} — each an edge function in supabase/functions/<name>/index.ts, called through backend.functions (supabase.functions.invoke); local.ts does what it can on the device.` : "none."}`,
      "8. Unit tests for the data layer against localBackend(), and for hostedBackend with a mocked supabase client (no network).",
      "",
      "The hosted side, as day2's Hosting asks for it:",
      h.brief,
      "",
      renderPlan(plan, name),
    ].join("\n"),
    doneWhen: [
      "Screens get their data only through src/backend/",
      "supabase/migrations/ creates every server table with row level security and its policies",
      "src/backend/hosted.ts implements the Backend interface with supabase-js; index.ts picks it only when both env values are set",
      "localBackend stays and the tests use it",
      "No secret or service key anywhere in the app",
      "Empty, loading and error states as drawn",
      "Type check and lint pass",
    ],
  };
}

/** The ticket as the build agent's input (backlog work, not a bug). */
export function stepReport(buildId: string, phase: BuildPhase, t: { title: string; description: string; doneWhen: string[] }, failure?: string): BugReport {
  return {
    title: t.title,
    description: [t.description, "", "Done when:", ...t.doneWhen.map((d) => `- ${d}`)].join("\n"),
    sourceId: `expo-create:${buildId}:${phase}`,
    source: "manual",
    kind: "build",
    ...(failure
      ? { agentNotes: `IMPORTANT: this step was built once already and its checks failed. Start from what's in the repo and fix this first:\n${failure.slice(0, 3000)}` }
      : {}),
  };
}

/** Pure. The one round of "make it look like the drawing" after a step, from the simulator screenshots. */
export function visualFixReport(buildId: string, phase: BuildPhase, name: string, c: ScreenComparison): BugReport {
  return {
    title: `Match ${name}'s screens to the approved drawings`,
    description: [
      "day2 ran the app on virtual devices and took a screenshot of each screen. Put each screenshot next to its approved drawing and fix clear mismatches only: a missing or extra element, a different layout or order, wrong texts, wrong colors, fonts or corners. Small rendering differences (anti-aliasing, the status bar's contents, sample data that is different but realistic) are fine — leave them.",
      "If every screen already matches, change nothing.",
      "",
      ...c.pairs.map((p) => `- ${p.name} (${p.platform === "ios" ? "iPhone" : "Android"}): screenshot design/compare/${p.screenId}.${p.platform}.png — drawing design/screens/${p.screenId}${p.platform === "android" ? ".android" : ""}.png`),
      "",
      "Don't touch design/ or .maestro/day2/. Run `npx tsc --noEmit` and `npm run lint` before you finish.",
      "",
      "Done when:",
      "- Every screen matches its drawing (or nothing needed changing)",
      "- Type check and lint pass",
    ].join("\n"),
    sourceId: `expo-create:${buildId}:${phase}:match`,
    source: "manual",
    kind: "build",
  };
}
