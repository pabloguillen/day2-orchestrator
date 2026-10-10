import { dirname, resolve } from "node:path";
import { APPS_REGISTRY_FILENAME } from "./apps-registry";
import { creditStoreFor, type CreditStore } from "./credits";

/** The orchestrator checkout — where the operator-level files live. */
export const ORCHESTRATOR_ROOT = resolve(import.meta.dir, "..");

/** Read on every call (not once at import) so integration tests can point
 * the server at a throwaway registry via DAY2_APPS_REGISTRY_PATH without
 * ever touching the operator's real `.day2-apps.json`. */
export function appsRegistryPath(): string {
  return process.env.DAY2_APPS_REGISTRY_PATH ?? resolve(ORCHESTRATOR_ROOT, APPS_REGISTRY_FILENAME);
}

/** The account-wide credits ledger lives next to the apps registry (or in
 * DAY2_CREDITS_DIR), so a throwaway registry gets a throwaway ledger too. */
export function creditStore(): CreditStore {
  return creditStoreFor(appsRegistryPath());
}

/** Where day2's own operator-level state lives (e.g. its Lovable account):
 * DAY2_DATA_DIR in production (a mounted volume), else next to the registry. */
export function dataDir(): string {
  return process.env.DAY2_DATA_DIR ?? dirname(appsRegistryPath());
}
