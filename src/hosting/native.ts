import type { AppEntry } from "../apps-registry";
import { registerNativeNeed } from "../live/native-foundations";
import type { HostingStore } from "./store";
import type { HostingPlan } from "./types";

/**
 * The native packages the hosted backend needs, for Live's single "native
 * foundations" store release (Create installs them up front). supabase-js
 * itself is JavaScript and ships over the air.
 */
export function registerHostingNativeNeeds(store: () => HostingStore): void {
  const plan = async (app: AppEntry) => {
    const s = await store().state(app.id);
    return s.enabled ? s.plan : null;
  };
  registerNativeNeed({
    module: "hosting",
    packages: ["@react-native-async-storage/async-storage", "expo-secure-store"],
    plugins: ["expo-secure-store"],
    instructions: "Hosting (the app's backend on Supabase): install @react-native-async-storage/async-storage and expo-secure-store with `npx expo install`; the sign-in session is kept encrypted with them (the hosted-backend ticket wires them).",
    whenNeeded: async (app) => Boolean(await plan(app)),
  });
  registerNativeNeed({
    module: "hosting-apple",
    packages: ["expo-apple-authentication", "expo-crypto"],
    plugins: ["expo-apple-authentication"],
    instructions: "Sign in with Apple: install expo-apple-authentication and expo-crypto, add the expo-apple-authentication plugin and `ios.usesAppleSignIn: true` to the app config.",
    whenNeeded: async (app) => Boolean((await plan(app))?.auth.apple),
  });
  registerNativeNeed({
    module: "hosting-google",
    packages: ["@react-native-google-signin/google-signin"],
    plugins: ["@react-native-google-signin/google-signin"],
    instructions: "Sign in with Google: install @react-native-google-signin/google-signin and add its config plugin (with the iOS URL scheme from the iOS client ID, reversed).",
    whenNeeded: async (app) => Boolean((await plan(app))?.auth.google),
  });
}

/** Pure. The native packages a plan's backend needs (Create installs them up front, before the first store build). */
export function hostingNativePackages(plan: Pick<HostingPlan, "auth">): string[] {
  return [
    "@react-native-async-storage/async-storage",
    "expo-secure-store",
    ...(plan.auth.apple ? ["expo-apple-authentication", "expo-crypto"] : []),
    ...(plan.auth.google ? ["@react-native-google-signin/google-signin"] : []),
  ];
}
