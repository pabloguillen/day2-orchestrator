import type { LiveContributor } from "../live/contributors";
import type { LiveMessage } from "../../packages/sensors/src/types";
import type { Campaign, MessagesState } from "./types";
import type { MessagesStore } from "./store";

/**
 * In-app messages reach the app through Live config (`messages`): the app
 * calls day2.message(trigger) at the moment named here and shows the
 * message in its own component, which reports day2.messageEvent(id,
 * "shown" | "tapped" | "dismissed").
 *
 * Holdout: `audience.percent` = 100 − the campaign's holdout, so the same
 * share of users never sees it in the app.
 *
 * The contribution depends only on the app's campaigns and the time, never
 * on who asks (Live serves every user the same config).
 */

/** The moments in the app the build agent wires (setup ticket). */
export const IN_APP_TRIGGERS: Record<string, string> = {
  comeback: "the first time the app is opened after being away for a while (lifecycle.js stateOf says reactivated or resurrected)",
  app_open: "every time the app comes to the foreground (caps keep it rare)",
  after_first_success: "right after the user's first success in the app",
};

/** Pure. Live config `messages` from active campaigns that show in the app. */
export function liveMessages(state: MessagesState): LiveMessage[] {
  if (!state.settings.enabled) return [];
  return state.campaigns
    .filter((c): c is Campaign & { inApp: NonNullable<Campaign["inApp"]> } => c.status === "active" && (c.channel === "in_app" || c.channel === "both") && Boolean(c.inApp) && c.checks.ok)
    .map((c) => {
      const base = c.texts.en ?? Object.values(c.texts)[0]!;
      const locale = Object.fromEntries(Object.entries(c.texts).map(([l, t]) => [l, { title: t!.title, body: t!.body, ...(t!.cta ? { cta: t!.cta } : {}) }]));
      return {
        id: c.id,
        trigger: c.inApp.trigger,
        title: base.title,
        body: base.body,
        ...(base.cta || c.route ? { cta: { label: base.cta ?? "OK", ...(c.route ? { route: c.route } : {}) } } : {}),
        cap: c.inApp.cap,
        audience: { percent: Math.round((1 - c.holdout) * 100) },
        locale,
      };
    });
}

export function messagesContributor(store?: () => MessagesStore): LiveContributor {
  return {
    module: "messages",
    async contribute(app) {
      const s = store ? store() : (await import("./runtime")).messagesStore();
      return { messages: liveMessages(await s.state(app.id)) };
    },
  };
}
