import { collectFeedback, type FeedbackDeps, type FeedbackReport } from "./feedback";
import type { DraftResult } from "./make";
import { publishDue, type PublishDeps, type PublishReport } from "./publish";
import { loadSocialState, logLine, updateSocialState } from "./state";
import type { SocialPostStore } from "./store";
import type { SocialPlatform } from "./types";

/**
 * One social pass for one app (on the autopilot timer, every 15 minutes):
 * make the next post when it's due, publish what's approved and due, read
 * results. Stopped entirely by the app's kill switch or the Social pause.
 */

/** Drafts waiting for the owner, at most — day2 doesn't pile up posts nobody looked at. */
export const MAX_WAITING = 3;
/** At most one new post a day. */
export const MAKE_EVERY_MS = 20 * 3_600_000;

export type PassDeps = {
  posts: SocialPostStore;
  statePath: string;
  /** Connected and turned-on platforms. */
  platforms: SocialPlatform[];
  /** social_content posts per week from the app's growth strategy (launch stage: 3). */
  perWeek: number;
  killSwitch: boolean;
  draft: () => Promise<DraftResult & { credits?: number }>;
  publish: Omit<PublishDeps, "stopped">;
  feedback: FeedbackDeps;
  now?: () => Date;
};

export type PassReport = { made: string[]; skippedMaking: string | null; publish: PublishReport | null; feedback: FeedbackReport | null };

/** Whether a new post is due, and why not. Pure. */
export function makeDue(o: { now: Date; lastMadeAt: string | null; perWeek: number; groupsLastWeek: number; waiting: number; platforms: number }): string | null {
  if (!o.platforms) return "no platform connected";
  if (o.perWeek <= 0) return "the growth plan has no social posts right now";
  if (o.waiting >= MAX_WAITING) return `${o.waiting} posts are waiting for your OK`;
  if (o.groupsLastWeek >= o.perWeek) return `${o.groupsLastWeek} of ${o.perWeek} posts this week are made`;
  if (o.lastMadeAt && o.now.getTime() - Date.parse(o.lastMadeAt) < MAKE_EVERY_MS) return "one post a day at most";
  return null;
}

export async function socialPass(appId: string, d: PassDeps): Promise<PassReport> {
  const now = d.now ? d.now() : new Date();
  const state = loadSocialState(d.statePath);
  const stopped = d.killSwitch || state.paused;
  const report: PassReport = { made: [], skippedMaking: null, publish: null, feedback: null };
  if (!stopped) {
    const posts = await d.posts.list(appId, { limit: 100 });
    const week = posts.filter((p) => now.getTime() - Date.parse(p.createdAt) < 7 * 86_400_000);
    const why = makeDue({
      now,
      lastMadeAt: state.lastMadeAt,
      perWeek: d.perWeek,
      groupsLastWeek: new Set(week.map((p) => p.group)).size,
      waiting: new Set(posts.filter((p) => p.status === "waiting_approval" || p.status === "draft").map((p) => p.group)).size,
      platforms: d.platforms.length,
    });
    report.skippedMaking = why;
    if (!why) {
      try {
        const r = await d.draft();
        report.made = r.posts.map((p) => p.id);
        updateSocialState(d.statePath, (s) =>
          logLine(
            { ...s, lastMadeAt: now.toISOString() },
            r.posts.length ? `Made a new post (${r.arm?.replace(/-/g, " ")})${r.posts.some((p) => p.status === "approved") ? " — it goes out on its own" : " — waiting for your OK"}.` : `No post this time: ${r.dropped ?? "nothing usable"}.`,
            now,
          ),
        );
      } catch (err) {
        report.skippedMaking = (err as Error).message.slice(0, 200);
        updateSocialState(d.statePath, (s) => logLine({ ...s, lastMadeAt: now.toISOString() }, `Couldn't make a post: ${(err as Error).message.slice(0, 160)}`, now));
      }
    }
    report.publish = await publishDue(appId, { ...d.publish, stopped: false });
    for (const p of report.publish.published) updateSocialState(d.statePath, (s) => logLine(s, `Published ${p}.`, now));
    for (const p of report.publish.failed) updateSocialState(d.statePath, (s) => logLine(s, `Couldn't publish ${p}.`, now));
  } else {
    report.skippedMaking = d.killSwitch ? "the kill switch is on" : "Social is paused";
  }
  // Results are read even while paused (read-only).
  report.feedback = await collectFeedback(appId, d.feedback).catch(() => null);
  await d.publish.links.purge(now).catch(() => 0);
  return report;
}
