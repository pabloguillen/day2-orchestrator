import { firstBuildCommand } from "./scaffold";
import type { CreateRequest, Identifiers, OwnerStep } from "./types";

/**
 * The owner's steps after Create, and the first EAS build.
 *
 * Checked against Expo's docs (docs/expo-apps.md, "First builds"): EAS can
 * use an App Store Connect API key in --non-interactive builds to validate,
 * repair and create *provisioning profiles* (eas-cli 20.2.0), and Expo's
 * CI guide still says to run `eas build` once from a terminal so the
 * credentials (Android keystore, iOS distribution certificate and
 * provisioning profile) are created. Creating a distribution certificate
 * and an Android keystore without a person isn't documented ("Generating a
 * new Keystore is not supported in --non-interactive mode"). So: the owner
 * runs the first build once with a copy-paste command; every build after
 * that day2 runs by itself with the connected Expo token (and the ASC key
 * for profile repairs).
 */

/** Pure. */
export function ownerSteps(r: CreateRequest, ids: Identifiers, o: { appId: string; githubRepo: string | null; repoDir: string; local: boolean }): OwnerStep[] {
  const folder = o.local ? `cd ${JSON.stringify(o.repoDir)}` : o.githubRepo ? `gh repo clone ${o.githubRepo} && cd ${o.githubRepo.split("/")[1]}` : `cd <the app's folder>`;
  const steps: OwnerStep[] = [
    {
      id: "expo",
      title: "Connect your Expo account",
      detail: "On the app's Releases page, paste an Expo access token (expo.dev → Account settings → Access tokens). Free Expo accounts work. day2 uses it for builds, over-the-air updates and store submissions.",
      link: { label: "Open Releases", url: `/apps/${o.appId}/releases` },
      done: false,
    },
    {
      id: "first-build",
      title: "Run the first store build once",
      detail: [
        "Apple and Google need signing keys the first time — EAS makes them, but only with you at the keyboard once (it asks you to sign in to Expo and, for iPhone, with your Apple ID; Android signing keys are made for you).",
        "Run this in a terminal on your Mac. It links the app to your Expo account and starts the builds in Expo's cloud (about 15–30 minutes; you can close the terminal once they're queued).",
        "After this, day2 runs every build by itself.",
      ].join(" "),
      command: `${folder} && ${firstBuildCommand(r)}`,
      done: false,
    },
  ];
  if (r.platforms.includes("ios")) {
    steps.push({
      id: "app-store",
      title: "Create the app in App Store Connect",
      detail: `In App Store Connect → Apps → “+” → New App: platform iOS, name “${ids.displayName}”, bundle ID ${ids.bundleId} (it appears after the first build), SKU ${ids.slug}. Needs a paid Apple Developer account. Then add an App Store Connect API key on Connect your stores so day2 can submit and release.`,
      link: { label: "App Store Connect", url: "https://appstoreconnect.apple.com/apps" },
      done: false,
    });
  }
  if (r.platforms.includes("android")) {
    steps.push({
      id: "play",
      title: "Create the app in Google Play Console",
      detail: `In Play Console → Create app: name “${ids.displayName}”, package ${ids.androidPackage}. Google needs the very first upload done by hand: download the Android build from expo.dev and upload it to the internal testing track once. Then sign in with Google on Connect your stores so day2 can release.`,
      link: { label: "Play Console", url: "https://play.google.com/console" },
      done: false,
    });
  }
  return steps;
}
