import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import type { NewTicketInput } from "../backlog";
import { appKind } from "../field-work";
import { registerNativeNeed } from "../live/native-foundations";
import { IN_APP_TRIGGERS } from "./contributor";

/**
 * Getting push and in-app messages into the app: one native need (the
 * native foundations release, Live) and one ticket for the build agent
 * (JavaScript only, ships over the air once the native release is out).
 */

export const SETUP_KEY = "messages:setup";
export const NATIVE_PACKAGES = ["expo-notifications", "expo-device", "expo-constants"];

export function hasNotifications(repoPath: string): boolean {
  const p = join(repoPath, "package.json");
  return existsSync(p) && readFileSync(p, "utf-8").includes('"expo-notifications"');
}

export const NATIVE_INSTRUCTIONS = [
  "Messages (push notifications):",
  "- Install expo-notifications, expo-device and expo-constants with `npx expo install` (versions that match the app's Expo SDK).",
  '- Add "expo-notifications" to the plugins in app.json / app.config (keep the app\'s existing icon; set `color` to the brand color when there is one).',
  "- Android: set expo.android.googleServicesFile to the app's google-services.json when the repo has one. If it doesn't, leave a note in the pull request: the owner adds it from the Firebase console (it may be committed; the FCM V1 service account key may not).",
  "- Nothing else native: EAS manages the iOS push key and uses the FCM V1 key the owner uploads in EAS for Android.",
].join("\n");

/** Registered once at load: the native foundations ticket includes it while Messages is on and the app lacks it. */
export function registerMessagesNativeNeed(enabled: (app: AppEntry) => Promise<boolean>): void {
  registerNativeNeed({
    module: "messages",
    packages: NATIVE_PACKAGES,
    plugins: ["expo-notifications"],
    instructions: NATIVE_INSTRUCTIONS,
    async whenNeeded(app) {
      return appKind(app.repoPath) === "react-native" && !hasNotifications(app.repoPath) && (await enabled(app));
    },
  });
}

export function setupTicket(): NewTicketInput {
  const triggers = Object.entries(IN_APP_TRIGGERS)
    .map(([k, v]) => `   - "${k}": ${v}`)
    .join("\n");
  return {
    title: "Push notifications and in-app messages",
    type: "feature",
    description: [
      "day2 sends the app's lifecycle messages (a nudge the day after a first try, at risk, lapsing, win-back, announcements) through Expo's push service, and shows in-app messages from Live config. The app needs the parts below, written once in the app's own style. expo-notifications comes with the native foundations release; if it isn't installed yet, build on top of that ticket's branch or wait for it.",
      "",
      "1. Setup (one module, e.g. src/notifications.ts):",
      "   - Notifications.setNotificationHandler with shouldShowBanner, shouldShowList, shouldPlaySound: false, shouldSetBadge: false.",
      '   - Android: Notifications.setNotificationChannelAsync("default", { name: <the app\'s word for updates>, importance: DEFAULT }) BEFORE asking for permission or a token (Android 13 shows no prompt without a channel).',
      "2. Asking for permission at a good moment — never at launch:",
      "   - After the user's first success in the app (the first finished core action), show the app's own short explanation screen or sheet (what they'll get, how rarely), then call Notifications.requestPermissionsAsync.",
      "   - iOS: if the user hasn't decided yet and the app has no own explanation yet, it may ask with { ios: { allowProvisional: true } } so notifications arrive quietly in Notification Center first; treat ios.status === IosAuthorizationStatus.PROVISIONAL as allowed.",
      "   - Ask at most once by the system prompt; if denied, offer a switch in the app's settings that opens Linking.openSettings().",
      "3. The token:",
      "   - When allowed and on a real device (expo-device Device.isDevice): getExpoPushTokenAsync({ projectId: Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId }), in try/catch (it needs the network; retry on the next launch).",
      "   - Call day2.setPushToken(token.data). On every launch, re-read the permission: if it's no longer granted, call day2.setPushToken(null). On sign-out call day2.setPushToken(null) before day2.identify(null); after the next sign-in, call day2.identify first and then day2.setPushToken(token) again.",
      "   - Re-register on Notifications.addPushTokenListener.",
      "   - Never log the token or send it anywhere else; never put it in analytics events.",
      "4. Taps:",
      '   - Each push from day2 carries data: { day2: { c: "<campaign id>", r: "<app route or null>" } }.',
      "   - Handle both Notifications.addNotificationResponseReceivedListener and Notifications.getLastNotificationResponseAsync() (app started by the tap); only for actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER.",
      '   - Report day2.track("push_opened") and day2.messageEvent(data.day2.c, "tapped") (that is how day2 counts opens per campaign), then navigate: data.day2.r is a path in the app (expo-router: router.push(r); React Navigation: the matching screen); unknown or missing → the start screen. Never open external URLs from a push.',
      "5. In-app messages — one component in the app's own design (no generic library UI):",
      "   - At each of these moments call day2.message(trigger) and, when it returns a message, show it (title, body, optional button that navigates to cta.route):",
      triggers,
      '   - Report day2.messageEvent(message.id, "shown") when it appears, "tapped" on the button, "dismissed" when closed. The library applies the caps; the component never shows more than one message at a time and nothing on top of a purchase or sign-in flow.',
      "   - If the user just opened a push of the same campaign (data.day2.c === message.id) in this session, don't show it.",
      "6. Tests: permission is not requested at launch; setPushToken is called with the token after permission and with null when it's revoked or on sign-out; a tap with r navigates there and reports push_opened; the in-app component reports shown/tapped/dismissed.",
      "",
      "Texts and timing come from day2 (Live config and the push itself); don't hard-code message texts.",
    ].join("\n"),
    doneWhen: [
      "Permission is asked after the first success, not at launch (iOS provisional where it fits)",
      "The Expo push token reaches day2.setPushToken, and null when push is off or on sign-out",
      "Tapping a day2 push opens the right screen and reports push_opened",
      "An in-app message component in the app's style shows day2.message(trigger) and reports day2.messageEvent",
      "The app builds and its tests pass",
    ],
    priority: 2,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: SETUP_KEY },
    actor: "day2",
    createdNote: "Needed for day2's lifecycle messages (Messages).",
  };
}
