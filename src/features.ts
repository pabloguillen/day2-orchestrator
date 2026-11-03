/**
 * Server-side feature flags. The console reads them from GET /api/features
 * and every gated endpoint checks them itself, so a hidden feature can't be
 * reached by calling the API directly either.
 *
 * - createApps: "Create a new app" with Lovable. Off until Lovable confirms
 *   in writing that day2 may build apps for its customers on day2's own
 *   Lovable account (their docs cover each user's own account only).
 *   Turn on with DAY2_FEATURE_CREATE_APPS=on.
 * - createExpoApps: "Native app for iPhone and Android (Expo)" — built by
 *   day2's own agents (src/expo-create/), no third party involved. On unless
 *   DAY2_FEATURE_CREATE_EXPO=off.
 */
export type Features = { createApps: boolean; createExpoApps: boolean };

export function features(): Features {
  return { createApps: process.env.DAY2_FEATURE_CREATE_APPS === "on", createExpoApps: process.env.DAY2_FEATURE_CREATE_EXPO !== "off" };
}
