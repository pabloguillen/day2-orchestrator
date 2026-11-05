import type { Region } from "./types";

/**
 * Where an app's backend lives: next to its users, and for European
 * audiences inside the EU (data stays in the chosen region — Supabase runs
 * the database, files and functions there).
 */

const EU = ["DE", "AT", "NL", "BE", "LU", "PL", "CZ", "SK", "HU", "SI", "HR", "RO", "BG", "IT", "GR", "CY", "MT", "LI"];
const EU_WEST = ["FR", "ES", "PT", "MC", "AD"];
const NORDIC = ["SE", "DK", "FI", "NO", "IS", "EE", "LV", "LT"];
const COUNTRY: Record<string, Region> = {
  ...Object.fromEntries(EU.map((c) => [c, "eu-central-1"])),
  ...Object.fromEntries(EU_WEST.map((c) => [c, "eu-west-3"])),
  ...Object.fromEntries(NORDIC.map((c) => [c, "eu-north-1"])),
  IE: "eu-west-1",
  GB: "eu-west-2",
  UK: "eu-west-2",
  CH: "eu-central-2",
  US: "us-east-1",
  MX: "us-east-1",
  CA: "ca-central-1",
  BR: "sa-east-1",
  AR: "sa-east-1",
  CL: "sa-east-1",
  CO: "sa-east-1",
  PE: "sa-east-1",
  IN: "ap-south-1",
  JP: "ap-northeast-1",
  KR: "ap-northeast-2",
  SG: "ap-southeast-1",
  MY: "ap-southeast-1",
  ID: "ap-southeast-1",
  TH: "ap-southeast-1",
  VN: "ap-southeast-1",
  PH: "ap-southeast-1",
  HK: "ap-east-1",
  TW: "ap-east-1",
  AU: "ap-southeast-2",
  NZ: "ap-southeast-2",
};
/** Language-only hints, when no country is known. */
const LANG: Record<string, Region> = { de: "eu-central-1", fr: "eu-west-3", es: "eu-west-3", it: "eu-central-1", nl: "eu-central-1", pl: "eu-central-1", sv: "eu-north-1", da: "eu-north-1", fi: "eu-north-1", ja: "ap-northeast-1", ko: "ap-northeast-2", pt: "sa-east-1", hi: "ap-south-1" };

/** Pure. The region for an audience: the most common region among its countries (then locales); ties go to the EU. */
export function regionFor(audience: { countries?: string[]; locales?: string[] } | undefined, fallback: Region): Region {
  const votes = new Map<Region, number>();
  const vote = (r: Region | undefined) => r && votes.set(r, (votes.get(r) ?? 0) + 1);
  for (const c of audience?.countries ?? []) vote(COUNTRY[c.trim().toUpperCase()]);
  if (!votes.size) {
    for (const l of audience?.locales ?? []) {
      const [lang, country] = l.replace("_", "-").split("-");
      vote(country ? (COUNTRY[country.toUpperCase()] ?? LANG[lang!.toLowerCase()]) : LANG[lang!.toLowerCase()]);
    }
  }
  if (!votes.size) return fallback;
  const best = Math.max(...votes.values());
  const top = [...votes.entries()].filter(([, n]) => n === best).map(([r]) => r);
  return top.find((r) => r.startsWith("eu-")) ?? top[0]!;
}
