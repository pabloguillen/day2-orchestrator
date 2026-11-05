import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appKind } from "../field-work";

/**
 * "Host with day2" is offered only for apps day2 created (Create's backend
 * adapter in src/backend/) and Expo apps without a backend of their own.
 * An app that already talks to its own servers (or Firebase, its own
 * Supabase, …) is never migrated automatically — moving live data and
 * accounts is a project for the owner, not something day2 does in passing.
 */

const OWN_BACKEND: Array<[RegExp, string]> = [
  [/"(firebase|@react-native-firebase\/[\w-]+)"/, "Firebase"],
  [/"@supabase\/supabase-js"/, "its own Supabase project"],
  [/"aws-amplify"|"@aws-amplify\/[\w-]+"/, "AWS Amplify"],
  [/"appwrite"|"react-native-appwrite"/, "Appwrite"],
  [/"convex"/, "Convex"],
  [/"pocketbase"/, "PocketBase"],
  [/"parse"/, "Parse"],
  [/"@apollo\/client"|"urql"/, "a GraphQL server"],
  [/"realm"/, "MongoDB Realm"],
];
const API_ENV = /EXPO_PUBLIC_(API|BACKEND|SERVER)_(URL|BASE_URL|HOST)/;

export type Eligibility = { eligible: true; why: "create" | "no_backend" } | { eligible: false; why: "not_expo" | "own_backend"; backend?: string };

export function eligibility(repoPath: string): Eligibility {
  if (appKind(repoPath) !== "react-native") return { eligible: false, why: "not_expo" };
  if (existsSync(join(repoPath, "src", "backend"))) return { eligible: true, why: "create" };
  const pkg = existsSync(join(repoPath, "package.json")) ? readFileSync(join(repoPath, "package.json"), "utf-8") : "";
  for (const [re, name] of OWN_BACKEND) if (re.test(pkg)) return { eligible: false, why: "own_backend", backend: name };
  for (const f of ["app.json", "app.config.ts", "app.config.js", "eas.json", ".env", ".env.example"]) {
    const p = join(repoPath, f);
    if (existsSync(p) && API_ENV.test(readFileSync(p, "utf-8"))) return { eligible: false, why: "own_backend", backend: "its own server" };
  }
  return { eligible: true, why: "no_backend" };
}
