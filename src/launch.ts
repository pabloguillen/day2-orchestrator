import type { ExistingIntegration } from "./field-work";

/**
 * The launch checklist: what has to be in place before the app's next
 * release goes out with day2 in it — separate from the growth backlog, so
 * it's clear what's essential and who does each step (day2 or the owner).
 * Optional parts (releases by day2, ads to the website) only appear once
 * the owner turned them on.
 */

export type LaunchState = "done" | "day2" | "you";

export type LaunchItem = {
  id: "public_address" | "field_checks" | "privacy_notice" | "store_answers" | "release_setup" | "ads_handoff";
  title: string;
  /** Why it matters, in a sentence. */
  why: string;
  /** Before the next release (true), or only for something the owner turned on. */
  essential: boolean;
  state: LaunchState;
  /** What happens next / what to do, in plain words. */
  next: string;
  ticket: { id: string; state: string } | null;
  /** Where in the console to act. */
  to: string;
};

type Ticket = { id: string; state: string } | null;

export type LaunchInput = {
  appId: string;
  kind: string;
  /** day2's address users' devices and ad platforms reach (DAY2_PUBLIC_URL). */
  publicUrl: string;
  ingestKey: string;
  field: { reporting: boolean; installTicket: Ticket; existing: ExistingIntegration | null };
  privacy: {
    applies: boolean;
    stores: Array<{ store: "ios" | "android"; upToDate: boolean; steps: string[] }>;
    notice: { upToDate: boolean; found: { path: string } | null; ticket: Ticket } | null;
  } | null;
  releases: { enabled: boolean; codeGaps: number; setupTicket: Ticket; missingAccounts: string[] } | null;
  ads: { handoffNeeded: boolean; ready: boolean; ticketId: string | null; why: string | null } | null;
};

const open = (t: Ticket) => Boolean(t && t.state !== "done" && t.state !== "parked");

/** Pure. The checklist for one app, essential items first. */
export function launchChecklist(i: LaunchInput): LaunchItem[] {
  const items: LaunchItem[] = [];
  const supported = i.kind === "web" || i.kind === "react-native";
  if (!supported) return items;
  const app = (p: string) => `/apps/${i.appId}${p}`;
  const isPublic = i.publicUrl.startsWith("https://");

  items.push({
    id: "public_address",
    title: "A public address for day2",
    why: "Your app's users, the ad platforms and your website reach day2 there — a local address works only on this computer.",
    essential: true,
    state: isPublic ? "done" : "you",
    next: isPublic
      ? `day2 is reachable at ${i.publicUrl}.`
      : "Run day2's tunnel (deploy/tunnel/day2-tunnel.sh) with your domain and set DAY2_PUBLIC_URL to its https address, then restart day2.",
    ticket: null,
    to: app("/checks"),
  });

  const f = i.field;
  const ex = f.existing;
  const fieldItem = (state: LaunchState, next: string, ticket: Ticket = null): LaunchItem => ({
    id: "field_checks",
    title: "day2 in the app",
    why: "Crash and error reports, checks that screens and buttons work, and the usage that growth and retention are measured by.",
    essential: true,
    state,
    next,
    ticket,
    to: app("/checks"),
  });
  if (f.reporting) items.push(fieldItem("done", "The app reports to day2."));
  else if (ex && ex.envKey && !ex.envSetForRelease)
    items.push(
      fieldItem(
        "you",
        isPublic
          ? `It's wired in (${ex.file}) but off until release builds get its settings. Add to eas.json → build.production.env: "${ex.envKey}": "${i.ingestKey}"${ex.envEndpoint ? `, "${ex.envEndpoint}": "${i.publicUrl}"` : ""} (the key is send-only and safe in the app), or set them as EAS environment variables. The next release build then reports.`
          : `It's wired in (${ex.file}) and turns on with ${ex.envKey}${ex.envEndpoint ? ` and ${ex.envEndpoint}` : ""} in release builds — once day2 has a public address.`,
      ),
    );
  else if (ex) items.push(fieldItem("you", `It's wired in (${ex.file}). Reports start with the next release build${i.kind === "web" ? " / deploy" : ""}.`));
  else if (open(f.installTicket)) {
    const t = f.installTicket!;
    items.push(fieldItem(t.state === "to_approve" ? "you" : "day2", t.state === "to_approve" ? `Review and merge ${t.id}; reports start with the next release${i.kind === "web" ? " / deploy" : " build"}.` : `day2 wires it in (${t.id}).`, t));
  } else items.push(fieldItem(isPublic ? "day2" : "you", isPublic ? "day2 adds a ticket to wire it in on its next pass." : "Waits for day2's public address, so the app doesn't get a local one."));

  const p = i.privacy;
  if (p?.notice) {
    const n = p.notice;
    items.push({
      id: "privacy_notice",
      title: "Your privacy notice mentions day2",
      why: "Users have to be told what's collected and why — before a build with day2 reaches them.",
      essential: true,
      state: n.upToDate ? "done" : open(n.ticket) ? (n.ticket!.state === "to_approve" ? "you" : "day2") : "you",
      next: n.upToDate
        ? "Up to date."
        : open(n.ticket)
          ? n.ticket!.state === "to_approve"
            ? `Review and merge ${n.ticket!.id}.`
            : `day2 adds its section (${n.ticket!.id}).`
          : n.found
            ? `day2 can add its section to ${n.found.path} — say yes on the Privacy page.`
            : "Copy day2's section into your privacy notice, then confirm on the Privacy page.",
      ticket: n.ticket,
      to: app("/privacy"),
    });
  }
  if (p?.applies) {
    const due = p.stores.filter((s) => !s.upToDate);
    const names = (ss: typeof due) => ss.map((s) => (s.store === "ios" ? "App Store" : "Google Play")).join(" and ");
    items.push({
      id: "store_answers",
      title: "App Store and Google Play privacy answers",
      why: "The stores' privacy questionnaires have to match what the app collects, or a release can be rejected or pulled.",
      essential: true,
      state: due.length ? "you" : "done",
      next: due.length ? `Update the ${names(due)} answers (the Privacy page lists each change), then confirm there.` : "Up to date.",
      ticket: null,
      to: app("/privacy"),
    });
  }

  const r = i.releases;
  if (r?.enabled) {
    const missing = r.missingAccounts;
    items.push({
      id: "release_setup",
      title: "Releases by day2",
      why: "So day2 can ship merged changes — updates in stages, store builds — and roll back what crashes.",
      essential: false,
      state: r.codeGaps ? (r.setupTicket?.state === "to_approve" ? "you" : "day2") : missing.length ? "you" : "done",
      next: r.codeGaps
        ? r.setupTicket?.state === "to_approve"
          ? `Review and merge ${r.setupTicket.id}.`
          : `day2 sets the app up for it${r.setupTicket ? ` (${r.setupTicket.id})` : ""}.`
        : missing.length
          ? `Connect ${missing.join(", ")} on the Releases page.`
          : "Ready.",
      ticket: r.setupTicket,
      to: app("/releases"),
    });
  }

  const a = i.ads;
  if (a?.handoffNeeded) {
    items.push({
      id: "ads_handoff",
      title: "Your website sends people from ads on to the stores",
      why: "Your ads lead to your website; phones there go straight on to the App Store / Google Play.",
      essential: false,
      state: a.ready ? "done" : "you",
      next: a.ready ? "Live." : `${a.why ?? "Not on the live website yet"}${a.ticketId ? ` (${a.ticketId})` : ""}.`,
      ticket: a.ticketId ? { id: a.ticketId, state: "todo" } : null,
      to: app("/growth/ads"),
    });
  }
  return items;
}

/** Source keys of the tickets that belong to the launch checklist (shown as "Launch" on the board). */
export const LAUNCH_KEYS = [/^field:install$/, /^privacy-notice:update:/, /^release:setup$/, /^ads:website-handoff:/, /^store-privacy:att$/];
export const isLaunchKey = (key: string | undefined) => Boolean(key && LAUNCH_KEYS.some((r) => r.test(key)));
