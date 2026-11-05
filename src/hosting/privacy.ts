import type { NoticeFacts } from "../privacy-notice";
import type { HostingPractice } from "../store-privacy";
import type { HostingStore } from "./store";
import { REGION_PLACE } from "./types";

/**
 * What the app's privacy answers and notice say about hosting: Supabase
 * keeps accounts, content and files in the project's region (day2's
 * subprocessor while the project is in day2's organization; the owner's own
 * processor after a takeover). Null when day2 doesn't host the app.
 */
export async function hostingPrivacy(appId: string, store: HostingStore): Promise<{ practice: HostingPractice; notice: NonNullable<NoticeFacts["hosting"]> } | null> {
  const s = await store.state(appId);
  const p = s.projects.production;
  if (!s.enabled || !p || !s.plan) return null;
  const place = REGION_PLACE[p.region];
  const accounts = s.plan.auth.email || s.plan.auth.apple || s.plan.auth.google;
  const files = s.plan.buckets.length > 0;
  return {
    practice: { processor: "Supabase", region: p.region, place: place.en, eu: place.eu, accounts, files },
    notice: { processor: "Supabase", place: { en: place.en, de: place.de }, eu: place.eu, accounts, files, direct: p.managedBy === "owner" },
  };
}
