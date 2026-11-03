import type { BugReport } from "../types";
import { renderPlan } from "./plan";
import type { ExpoBuild, Mockup, Phase, ProductPlan } from "./types";

/**
 * The build agent implements the approved plan in three steps — screens,
 * then data and state, then polish — each one a "build" ticket for
 * runBuildAgent, checked (type check, lint, devices) before the next.
 */

export type BuildPhase = Extract<Phase, "screens" | "data" | "polish">;
export const BUILD_PHASES: BuildPhase[] = ["screens", "data", "polish"];

const COMMON = [
  "This is a brand-new Expo app (Expo Router, TypeScript) that day2 just created. PLAN.md in the repo root is the product plan the owner approved; design/mockups/ has the approved drawings of the key screens (open the PNGs to see them).",
  "Keep to Expo's managed workflow: no ios/ or android/ folders, add libraries with `npx expo install <pkg>` (it picks versions that match the SDK), and prefer Expo's own modules (expo-sqlite, expo-secure-store, expo-image…).",
  "Every screen in the plan lives at its route in app/ so it opens from a deep link (<scheme>://<route>). Don't change app.json identifiers, runtimeVersion, updates or eas.json — day2 set them.",
  "Run `npx tsc --noEmit` and `npm run lint` before you finish and fix what they report.",
];

function mockupLines(mockups: Mockup[]): string[] {
  return mockups.length ? ["", "Approved drawings:", ...mockups.map((m) => `- design/mockups/${m.screenId}.png: ${m.name}${m.note ? ` — ${m.note}` : ""}`)] : [];
}

/** Pure. The ticket text of one build step. */
export function stepTicket(b: Pick<ExpoBuild, "request" | "identifiers" | "mockups">, plan: ProductPlan, phase: BuildPhase, ctx: { fieldEndpoint: string | null; fieldKey: string | null; libraryDir: string | null; nativeInstructions?: string[] }): { title: string; description: string; doneWhen: string[] } {
  const name = b.request.displayName;
  if (phase === "screens") {
    return {
      title: `Build the screens of ${name}`,
      description: [
        ...COMMON,
        ...mockupLines(b.mockups),
        "",
        "This step: the screens and the navigation, with realistic sample data held in memory (data and storage come in the next step).",
        "1. Remove the template's example screens and components that the plan doesn't use (the default template's tabs/explore examples).",
        "2. A small theme (colors, spacing, type sizes, corner radii) in one file, matching the drawings, with dark mode.",
        "3. Every screen of the plan at its route, laid out like the drawings for key screens and in the same style for the rest. The first minute in the plan works by tapping through.",
        "4. Accessible: labels on icon buttons, text that scales, touch targets of at least 44 pt.",
        "",
        renderPlan(plan, name),
      ].join("\n"),
      doneWhen: ["Every screen in the plan exists at its route", "Key screens match the approved drawings", "The template's example screens are gone", "Type check and lint pass"],
    };
  }
  if (phase === "data") {
    return {
      title: `Add data and state to ${name}`,
      description: [
        ...COMMON,
        "",
        "The screens exist (previous step). This step: real data and state.",
        "1. The data in the plan, stored where the plan says (on the device: expo-sqlite or AsyncStorage for small settings; a server only if the plan says so — then a typed client with a clear placeholder for the URL, no invented backend).",
        "2. Replace the sample data with the stored data, with empty, loading and error states on every screen that loads something.",
        `3. Money (${plan.monetization.model}): ${plan.monetization.model === "free" ? "nothing to add." : `build the placement as described (${plan.monetization.placement || "see the plan"}) in the app's own style, with its texts, prices and on/off read from one config module (src/config.ts or similar) with sensible defaults — no store billing or ad SDK yet (day2's Money module adds those with the native foundations release).`}`,
        `4. Accounts: ${plan.accounts ? "sign-in as the plan describes; keep tokens in expo-secure-store." : "none."}`,
        "5. Unit tests for the data layer (jest-expo if the project has no test setup yet: `npx expo install jest-expo jest @types/jest` and a \"test\" script).",
        "",
        renderPlan(plan, name),
      ].join("\n"),
      doneWhen: ["The plan's data is stored and survives a restart", "Empty, loading and error states on screens that load data", "Tests cover the data layer and pass", "Type check and lint pass"],
    };
  }
  const field = ctx.fieldEndpoint && ctx.fieldKey && ctx.libraryDir;
  return {
    title: `Polish ${name} and wire in day2`,
    description: [
      ...COMMON,
      "",
      "Screens and data exist (previous steps). This step: polish and day2's wiring.",
      "1. Go through the first minute in the plan as a new user and fix anything rough: wording, empty states, keyboard handling, safe areas, haptics where they help.",
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
