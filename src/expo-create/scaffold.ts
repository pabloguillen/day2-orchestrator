import { noticeSection, noticeVersion } from "../privacy-notice";
import type { CreateRequest, Identifiers, ProductPlan } from "./types";

/**
 * Setting up the Expo app and prewiring what day2 needs to look after it.
 * Pure helpers; the flow runs the commands through its injected runner.
 */

/** Expo's own scaffold. "default" = Expo Router + TypeScript, on the SDK
 * create-expo-app@latest picks; DAY2_EXPO_TEMPLATE pins one (e.g. default@sdk-57). */
export function createExpoAppCommand(dir: string, template = process.env.DAY2_EXPO_TEMPLATE || "default"): string[] {
  return ["npx", "--yes", "create-expo-app@latest", dir, "--template", template, "--yes"];
}

/** Native modules day2's release path needs (mobile-release/setup.ts readiness). */
export const RELEASE_PACKAGES = ["expo-updates", "expo-application"];

type Json = Record<string, unknown>;

/**
 * Pure. app.json with the identifiers, the deep link scheme, the
 * fingerprint runtime policy and (with an EAS project id) the update URL —
 * everything else left as the template made it.
 */
export function patchAppJson(appJson: Json, ids: Identifiers, r: Pick<CreateRequest, "platforms">, projectId: string | null): Json {
  const expo = { ...((appJson.expo as Json) ?? {}) };
  expo.name = ids.displayName;
  expo.slug = ids.slug;
  expo.scheme = ids.scheme;
  expo.version = typeof expo.version === "string" ? expo.version : "1.0.0";
  expo.ios = { ...((expo.ios as Json) ?? {}), bundleIdentifier: ids.bundleId, supportsTablet: (expo.ios as Json | undefined)?.supportsTablet ?? true, config: { ...(((expo.ios as Json | undefined)?.config as Json) ?? {}), usesNonExemptEncryption: false } };
  expo.android = { ...((expo.android as Json) ?? {}), package: ids.androidPackage };
  expo.platforms = [...r.platforms];
  expo.runtimeVersion = { policy: "fingerprint" };
  const updates = { ...((expo.updates as Json) ?? {}) };
  if (projectId) updates.url = `https://u.expo.dev/${projectId}`;
  if (Object.keys(updates).length) expo.updates = updates;
  if (projectId) expo.extra = { ...((expo.extra as Json) ?? {}), eas: { ...((((expo.extra as Json) ?? {}).eas as Json) ?? {}), projectId } };
  return { ...appJson, expo };
}

/** Pure. eas.json as day2's release path wants it (mobile-release/setup.ts). */
export function easJson(existing: Json | null = null): Json {
  const e = existing ?? {};
  const build = (e.build as Record<string, Json>) ?? {};
  const submit = (e.submit as Record<string, Json>) ?? {};
  return {
    ...e,
    cli: { ...((e.cli as Json) ?? {}), version: ">= 16.0.0", appVersionSource: "remote" },
    build: {
      ...build,
      development: { developmentClient: true, distribution: "internal", channel: "development", ...(build.development ?? {}) },
      preview: { distribution: "internal", channel: "preview", ...(build.preview ?? {}) },
      production: { ...(build.production ?? {}), autoIncrement: true, channel: "production" },
    },
    submit: { ...submit, production: { ...(submit.production ?? {}), android: { ...(((submit.production ?? {}) as Json).android as Json), track: "internal" } } },
  };
}

/**
 * Pure. A basic privacy notice for the new app (PRIVACY.md): what the app
 * itself stores (from the plan) and day2's section with its markers, so
 * privacy-notice.ts finds and updates it later. A draft for the owner, not
 * legal advice.
 */
export function privacyNotice(r: CreateRequest, plan: ProductPlan, fieldChecks: boolean): string {
  const section = noticeSection({ mobile: true, fieldChecks, identify: plan.accounts, treatments: false, deviceId: false, adPlatforms: [], adConsent: false }, r.displayName, "en");
  const stored = plan.data.length ? plan.data.map((d) => `- ${d.name} (${d.fields.join(", ")}), kept ${d.where === "device" ? "only on your device" : "on our server"}.`) : ["- Nothing beyond what you enter, kept on your device."];
  const money =
    plan.monetization.model === "subscription" || plan.monetization.model === "one_time"
      ? ["", "**Purchases:** handled by Apple or Google. We receive whether a purchase is active, never your payment details."]
      : plan.monetization.model === "ads"
        ? ["", "**Ads:** the app shows ads from Google AdMob. Personalised ads only after you agreed; otherwise non-personalised ads."]
        : [];
  return [
    `# Privacy notice for ${r.displayName}`,
    "",
    "_Draft written by day2 when the app was created. Replace the placeholders and have it checked before the app goes to the stores._",
    "",
    "**Who is responsible (controller):** [your name or company, address, email]",
    "",
    "## What the app stores",
    "",
    "Personal data the app processes to work:",
    ...stored,
    ...money,
    "",
    ...(section ? [`<!-- day2:privacy-start v=${noticeVersion(section)} -->`, section, "<!-- day2:privacy-end -->", ""] : []),
    "## Your rights",
    "",
    "You can ask us what personal data we hold about you, have it corrected or deleted, and complain to a data protection authority (GDPR Art. 15–21, 77). Contact: [email].",
    "",
  ].join("\n");
}

/** Pure. The command an owner runs once in the app's folder for the first store builds. */
export function firstBuildCommand(r: Pick<CreateRequest, "platforms">): string {
  const platform = r.platforms.length === 2 ? "all" : r.platforms[0]!;
  return `npx eas-cli@latest init && npx eas-cli@latest build --platform ${platform} --profile production`;
}
