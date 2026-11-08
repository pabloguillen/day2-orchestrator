import type { NewTicketInput } from "../backlog";
import { SOCIAL_FLOW, STORE_FLOW, STORE_NOTES } from "./capture";
import type { DemoCast } from "./demo-cast/schema";

/**
 * The app-side half of real screens, written by day2's build agent as a
 * pull request on the app's repo (a backlog ticket, like every change day2
 * makes to an app): a Maestro flow that signs in to the demo account and
 * takes a screenshot of each key moment, notes on what each shows, a demo
 * build profile, and a demo-only sign-in. Nothing secret goes into the
 * repo — the address and public key of the run's temporary database are
 * added to the build by day2 when it builds (capture-run.ts), and the
 * run's login reaches Maestro through MAESTRO_* environment variables. The
 * temporary database is plain http on this machine (127.0.0.1 from the
 * iPhone Simulator, 10.0.2.2 from the Android emulator), so demo builds
 * must allow cleartext to exactly those hosts — and only demo builds.
 *
 * Also the EAS side: day2's own workflow file and build profile for a
 * cloud capture, written into a temporary checkout (never committed).
 */

export const DEMO_FLOW_KEY = "creative:demo-flow";
export const DEMO_PROFILE = "day2-demo";
export const DEMO_FLAG = "EXPO_PUBLIC_DAY2_DEMO";
export const LOGIN_ENV = { email: "MAESTRO_DAY2_DEMO_EMAIL", password: "MAESTRO_DAY2_DEMO_PASSWORD" } as const;
export const SHOT_PREFIX = "day2-shot-";
export const ARTIFACT = "day2-screens";
export const CAPTURE_WORKFLOW = ".eas/workflows/day2-capture.yml";

/** Pure. The 3–6 moments to capture, from the app's features (or the store notes' names). */
export function demoMoments(features: string[], existing: Array<{ name: string; shows: string }>): Array<{ name: string; shows: string }> {
  if (existing.length >= 3) return existing.slice(0, 6);
  const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "screen";
  return features.slice(0, 5).map((f, k) => ({ name: `${String(k + 1).padStart(2, "0")}-${slug(f.split(/[:—–(]/)[0]!)}`, shows: f.slice(0, 120) }));
}

/** The ticket for the build agent (one per app; source key DEMO_FLOW_KEY). */
export function demoFlowTicket(o: { appName: string; features: string[]; locale: string; cast: DemoCast | null; hasStoreFlow: boolean; existingNotes: Array<{ name: string; shows: string }>; record: boolean }): NewTicketInput {
  const moments = demoMoments(o.features, o.existingNotes);
  const self = o.cast?.people.find((p) => p.key === o.cast?.self);
  const friend = o.cast?.people.find((p) => p.key !== o.cast?.self);
  return {
    title: "Real screens: a Maestro flow through the app with the demo account",
    type: "task",
    description: [
      `day2 makes ${o.appName}'s posts and store screenshots from the real app: for each capture it starts a temporary database with the app's migrations (filled with fictional friends — never real users; deleted after the run), builds the app against it and runs a Maestro flow on the iPhone Simulator (on the owner's Mac, or on EAS through a short-lived tunnel) in ${o.locale}. This ticket adds what the app needs for that. Never commit a URL, key or password — day2 passes them at build and run time, new for every run.`,
      "",
      "1. **Backend address from the build.** Where the Supabase client is created (e.g. src/config/supabase.ts), read `process.env.EXPO_PUBLIC_SUPABASE_URL` and `process.env.EXPO_PUBLIC_SUPABASE_KEY` and fall back to the current values when they're unset, so production builds don't change. day2 sets them only for its demo build (e.g. `http://127.0.0.1:55400` — plain http, a different port each run).",
      `   **Plain http to the temporary database, demo builds only:** in app.config (read \`process.env.${DEMO_FLAG}\` there), when it is \`"1"\`: iOS \`ios.infoPlist.NSAppTransportSecurity = { NSAllowsLocalNetworking: true }\` (or an exception domain for \`127.0.0.1\`/\`localhost\` only — never \`NSAllowsArbitraryLoads\`); Android a network security config (a small config plugin) allowing cleartext only for \`10.0.2.2\`, \`127.0.0.1\` and \`localhost\`. Store builds keep the defaults (no cleartext). EAS captures use an https tunnel, so they need nothing extra.`,
      `2. **Demo sign-in, demo builds only.** When \`process.env.${DEMO_FLAG} === "1"\` (never in store builds), the sign-in screen also shows an email + password form: inputs with testID \`day2-demo-email\` and \`day2-demo-password\` and a button \`day2-demo-signin\` that calls \`supabase.auth.signInWithPassword\`. Skip onboarding steps that need a real phone (push permission, contacts) in that mode.`,
      `3. **eas.json:** add a build profile \`${DEMO_PROFILE}\`: \`{"distribution":"internal","ios":{"simulator":true},"android":{"buildType":"apk"},"env":{"${DEMO_FLAG}":"1"}}\` — no backend values in it.`,
      `4. **${STORE_FLOW}**${o.hasStoreFlow ? " (it exists — extend it)" : ""}: \`appId: \${APP_ID}\` at the top; \`launchApp: { clearState: true, arguments: { AppleLanguages: "(\${DAY2_LOCALE_LANG})", AppleLocale: "\${DAY2_LOCALE}" } }\`; sign in with \`inputText: \${${LOGIN_ENV.email}}\` and \`inputText: \${${LOGIN_ENV.password}}\` (Maestro reads MAESTRO_* variables from its environment — never write the values into the flow); dismiss any permission dialog; then visit each moment and \`takeScreenshot: ${SHOT_PREFIX}<name>\` (the prefix lets day2 find them):`,
      ...moments.map((m) => `   - \`${m.name}\`: ${m.shows}`),
      `   Wait for content (\`extendedWaitUntil\` on a visible element, e.g. a friend's name${friend ? ` like "${friend.displayName}"` : ""}) before each screenshot; no keyboard, no spinners, no debug overlays.${self ? ` The demo account is ${self.displayName} (@${self.username}).` : ""}`,
      `5. **${STORE_NOTES}:** \`{"screens":[{"name":"01-…","shows":"one sentence: what the viewer sees here"}]}\`, one per screenshot, names without the prefix.`,
      ...(o.record ? [`6. **${SOCIAL_FLOW}** (optional): the same sign-in, then \`startRecording: ${SHOT_PREFIX}clip\` … \`stopRecording\` around the one interaction that explains the app best (5–10 s), plus the same screenshots.`] : []),
      "",
      "Run it once locally: `supabase start` in the repo, a demo build with `EXPO_PUBLIC_DAY2_DEMO=1 EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 EXPO_PUBLIC_SUPABASE_KEY=<anon key from supabase status>`, a user you add in the local Studio, then `maestro test` with `-e APP_ID=… -e DAY2_LOCALE=… -e DAY2_LOCALE_LANG=…` and the two MAESTRO_ variables exported in your shell.",
    ].join("\n"),
    doneWhen: [
      "The Supabase client reads EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_KEY with the current values as fallback",
      `A demo-only email/password sign-in exists behind ${DEMO_FLAG}`,
      `Demo builds (${DEMO_FLAG}=1) allow plain http to 127.0.0.1/localhost (iOS NSAllowsLocalNetworking) and 10.0.2.2 (Android cleartext for that host only); store builds don't`,
      `eas.json has the ${DEMO_PROFILE} profile (no secrets)`,
      `${STORE_FLOW} signs in with the MAESTRO_ variables and takes a ${SHOT_PREFIX}… screenshot of each moment`,
      `${STORE_NOTES} describes each screenshot`,
      "No URL, key or password is committed",
    ],
    priority: 3,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: DEMO_FLOW_KEY },
    actor: "day2",
    createdNote: "Needed for real screens in posts (Growth → Formats).",
  };
}

// ---------------------------------------------------------------- EAS (cloud capture)

/** Pure. eas.json with day2's demo profile: simulator/APK, the demo flag, the run's temporary database address (a tunnel) and public key (written into a temporary checkout only). */
export function withDemoProfile(easJson: string | null, demo: { url: string; key: string }): string {
  const j = (easJson ? JSON.parse(easJson) : {}) as { build?: Record<string, { env?: Record<string, string> } & Record<string, unknown>> };
  const cur = j.build?.[DEMO_PROFILE] ?? {};
  j.build = { ...(j.build ?? {}), [DEMO_PROFILE]: { ...cur, distribution: "internal", ios: { simulator: true }, android: { buildType: "apk" }, env: { ...(cur.env ?? {}), [DEMO_FLAG]: "1", EXPO_PUBLIC_SUPABASE_URL: demo.url, EXPO_PUBLIC_SUPABASE_KEY: demo.key } } };
  return `${JSON.stringify(j, null, 2)}\n`;
}

/**
 * Pure. The capture workflow: an iOS simulator build with the demo profile,
 * then EAS's Maestro job on it (docs.expo.dev/eas/workflows/syntax, "maestro"
 * job), and after the tests the flow's screenshots uploaded as a workflow
 * artifact (eas/upload_artifact, type other) that day2 then downloads.
 * The login comes from the job's EAS environment (secret variables day2 sets).
 */
export function captureWorkflowYaml(o: { flow: string; platform?: "ios" | "android"; record?: boolean; environment?: string }): string {
  const p = o.platform ?? "ios";
  return [
    "name: day2 capture",
    "jobs:",
    "  build:",
    `    name: Demo build for the ${p === "ios" ? "iOS Simulator" : "Android emulator"}`,
    "    type: build",
    "    params:",
    `      platform: ${p}`,
    `      profile: ${DEMO_PROFILE}`,
    "  capture:",
    "    name: Capture the key moments",
    "    needs: [build]",
    "    type: maestro",
    `    environment: ${o.environment ?? "preview"}`,
    "    params:",
    "      build_id: ${{ needs.build.outputs.build_id }}",
    `      flow_path: ['${o.flow}']`,
    `      record_screen: ${o.record ? "true" : "false"}`,
    "    hooks:",
    "      after_maestro_tests:",
    "        - uses: eas/upload_artifact",
    "          if: ${{ always() }}",
    "          with:",
    "            type: other",
    `            name: ${ARTIFACT}`,
    "            path: |",
    `              ${SHOT_PREFIX}*.png`,
    `              **/${SHOT_PREFIX}*.png`,
    `              ~/.maestro/tests/**/${SHOT_PREFIX}*.png`,
    "",
  ].join("\n");
}

/**
 * Pure. Download links of the capture artifact in `eas workflow:view --json`
 * output. The CLI's JSON shape for artifacts isn't documented, so this
 * looks for any object naming the artifact (or a .png / archive) that
 * carries a https link.
 */
export function artifactLinks(json: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number, named: boolean) => {
    if (!v || typeof v !== "object" || depth > 10) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1, named);
      return;
    }
    const o = v as Record<string, unknown>;
    const label = [o.name, o.key, o.filename, o.type].filter((x) => typeof x === "string").join(" ");
    const here = named || label.includes(ARTIFACT) || label.includes(SHOT_PREFIX);
    for (const k of ["downloadUrl", "download_url", "url", "fileUrl", "signedUrl"]) {
      const u = o[k];
      if (typeof u === "string" && /^https:\/\//.test(u) && (here || /\.(png|zip|tar\.gz|tgz)(\?|$)/i.test(u))) out.add(u);
    }
    for (const x of Object.values(o)) walk(x, depth + 1, here);
  };
  walk(json, 0, false);
  return [...out].slice(0, 20);
}
