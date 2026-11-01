import type { Store } from "./store-privacy";

/**
 * "Do it with me": the store privacy changes as a walkthrough, one screen at
 * a time — where to click in App Store Connect / the Play Console, then each
 * change, then publishing. Apple and Google don't let other tools fill these
 * forms, so the owner clicks; day2 says exactly what.
 */

export type WalkStep = { title: string; detail: string; link?: { label: string; url: string } };

/** Pure. The steps for one store, from the changes (store-privacy changesFor). */
export function walkthrough(store: Store, changes: string[], o: { appName: string; appStoreId: string | null }): WalkStep[] {
  if (!changes.length) return [];
  const each = (c: string, i: number): WalkStep => ({ title: `Change ${i + 1} of ${changes.length}`, detail: c });
  if (store === "ios") {
    return [
      {
        title: "Open App Privacy",
        detail: `Sign in to App Store Connect with your Apple developer account. ${o.appStoreId ? `This opens ${o.appName}'s App Privacy page.` : `Open Apps → ${o.appName}, then App Privacy in the left sidebar (under General).`}`,
        link: { label: "Open App Store Connect", url: o.appStoreId ? `https://appstoreconnect.apple.com/apps/${o.appStoreId}/distribution/privacy` : "https://appstoreconnect.apple.com/apps" },
      },
      {
        title: "Edit the data types",
        detail: 'Next to "Data Types", click Edit (or Get Started if it\'s the first time). Tick every data type the next steps add, keep everything that\'s already ticked, then click Save.',
      },
      ...changes.map((c, i) => ({
        ...each(c, i),
        detail: `${c}\n\nOn App Privacy, find the data type in the list and click it (or "Set Up"). Answer the questions in order — what it's used for, linked to the user, used for tracking — exactly as above, then Save.`,
      })),
      {
        title: "Publish",
        detail: "Back on App Privacy, click Publish (top right) and confirm. The App Store page shows the new answers from then on — no new build needed.",
      },
    ];
  }
  return [
    {
      title: "Open Data safety",
      detail: `Sign in to the Play Console, open ${o.appName}, then in the left menu: Policy and programs → App content. Find "Data safety" and click Manage (or Start).`,
      link: { label: "Open the Play Console", url: "https://play.google.com/console" },
    },
    {
      title: "Data collection and security",
      detail: 'Does your app collect or share any of the required user data types? Yes. Is all of the user data collected by your app encrypted in transit? Yes. Keep your other answers (account creation, deletion) as they are. Click Next.',
    },
    {
      title: "Tick the data types",
      detail: "Tick every data type the next steps add and keep the ones already ticked. Click Next.",
    },
    ...changes.map((c, i) => ({
      ...each(c, i),
      detail: `${c}\n\nOn "Data usage and handling", click the arrow next to the data type. Collected: Yes. Shared: as above. Is this data processed ephemerally? No. Is it required or optional? Required — users can't turn it off. Then tick the purposes listed above and Save.`,
    })),
    {
      title: "Save and submit",
      detail: "Click Next to see the summary, then Save. Google shows it on your store page after reviewing it (usually within a few days; your app stays available meanwhile).",
    },
  ];
}
