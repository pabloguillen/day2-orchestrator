import type { AppleCatalog } from "./catalog-apple";
import type { GoogleCatalog } from "./catalog-google";
import { addLog, type MoneyFile, type Product, type ProductPlan, type StoreSide, type Strategy } from "./types";

/**
 * The strategy's products → store products. A product id is fixed for life
 * (`<bundle>.<key>.v<version>`): a different price, period or trial is a
 * new version, because the stores give every user of a region the same
 * price for one product — price tests and price changes are new products
 * (old subscribers keep theirs). New products and price changes are "ask
 * me first" by default; approving a strategy approves the products it
 * lists (the owner saw their prices there).
 */

export const productIdFor = (appId: string, key: string, version: number) => `${appId.toLowerCase().replace(/[^a-z0-9._]/g, "_").replace(/^[^a-z0-9]+/, "")}.${key.toLowerCase().replace(/[^a-z0-9_]/g, "_")}.v${version}`;

const samePlan = (a: ProductPlan, b: ProductPlan) =>
  a.kind === b.kind &&
  a.period === b.period &&
  (a.trialDays ?? 0) === (b.trialDays ?? 0) &&
  a.base.amount === b.base.amount &&
  a.base.currency === b.base.currency &&
  a.base.region === b.base.region &&
  JSON.stringify([...a.regional].sort((x, y) => x.region.localeCompare(y.region))) === JSON.stringify([...b.regional].sort((x, y) => x.region.localeCompare(y.region)));

const side = (on: boolean): StoreSide => ({ state: on ? "waiting" : "skipped" });

/** Pure. Adds the products a plan needs that aren't there yet (same key + same price = the same product). */
export function planProducts(
  file: MoneyFile,
  plans: ProductPlan[],
  o: { idBase: string; stores: { ios: boolean; android: boolean }; approval: Product["approval"]; test?: Product["test"]; now: Date },
): { file: MoneyFile; added: Product[]; kept: Product[] } {
  const added: Product[] = [];
  const kept: Product[] = [];
  let products = file.products;
  for (const plan of plans) {
    const live = products.filter((p) => p.key === plan.key && !p.retiredAt);
    const same = live.find((p) => samePlan(p, plan) && (p.test?.variant ?? null) === (o.test?.variant ?? null));
    if (same) {
      kept.push(same);
      continue;
    }
    const version = Math.max(0, ...products.filter((p) => p.key === plan.key).map((p) => p.version)) + 1;
    const product: Product = {
      ...plan,
      productId: productIdFor(o.idBase, plan.key, version),
      version,
      test: o.test ?? null,
      approval: o.approval,
      ios: side(o.stores.ios),
      android: side(o.stores.android),
      createdAt: o.now.toISOString(),
      retiredAt: null,
    };
    products = [...products, product];
    added.push(product);
  }
  return { file: { ...file, products }, added, kept };
}

/** Pure. A strategy the owner approved: its products, approved by the same person. */
export function productsForStrategy(file: MoneyFile, s: Strategy, o: { idBase: string; stores: { ios: boolean; android: boolean }; now: Date }) {
  return planProducts(file, s.products, { ...o, approval: { state: "approved", by: s.decidedBy, at: s.decidedAt } });
}

export function decideProduct(file: MoneyFile, productId: string, approve: boolean, by: string | null, now: Date): MoneyFile {
  const p = file.products.find((x) => x.productId === productId);
  if (!p || p.approval.state !== "waiting") return file;
  const next = { ...file, products: file.products.map((x) => (x.productId === productId ? { ...x, approval: { state: approve ? ("approved" as const) : ("declined" as const), by, at: now.toISOString() }, ...(approve ? {} : { retiredAt: now.toISOString() }) } : x)) };
  return addLog(next, `${by ?? "The owner"} ${approve ? "approved" : "declined"} ${p.name} at ${p.base.amount} ${p.base.currency}.`, now);
}

const ready = (p: Product) => (p.approval.state === "approved" || p.approval.state === "auto") && !p.retiredAt;

export type ApplyDeps = {
  apple: AppleCatalog | null;
  google: GoogleCatalog | null;
  bundleId: string | null;
  packageName: string | null;
  locale: string;
  groupName: string;
  now: Date;
};

/** Creates approved products in the stores that don't have them yet; failures are kept with a plain reason and retried next pass. */
export async function applyProducts(file: MoneyFile, deps: ApplyDeps): Promise<{ file: MoneyFile; created: string[]; failed: string[] }> {
  const created: string[] = [];
  const failed: string[] = [];
  let f = file;
  const update = (id: string, store: "ios" | "android", s: StoreSide) => {
    f = { ...f, products: f.products.map((p) => (p.productId === id ? { ...p, [store]: s } : p)) };
  };
  for (const p of file.products.filter(ready)) {
    if ((p.ios.state === "waiting" || p.ios.state === "failed") && deps.bundleId) {
      if (!deps.apple) update(p.productId, "ios", { ...p.ios, state: "waiting", error: "Connect App Store Connect (Releases page) so day2 can create it." });
      else {
        const firstPurchase = !f.products.some((x) => x.productId !== p.productId && x.ios.state === "created");
        try {
          update(p.productId, "ios", await deps.apple.ensure(p, { bundleId: deps.bundleId, locale: deps.locale, groupName: deps.groupName, firstPurchase }));
          created.push(`${p.productId} (App Store)`);
        } catch (err) {
          update(p.productId, "ios", { ...p.ios, state: "failed", error: (err as Error).message, at: deps.now.toISOString() });
          failed.push(`${p.productId} (App Store): ${(err as Error).message}`);
        }
      }
    }
    if ((p.android.state === "waiting" || p.android.state === "failed") && deps.packageName) {
      if (!deps.google) update(p.productId, "android", { ...p.android, state: "waiting", error: "Connect Google Play (Releases page) so day2 can create it." });
      else {
        try {
          update(p.productId, "android", await deps.google.ensure(p, { packageName: deps.packageName, locale: deps.locale }));
          created.push(`${p.productId} (Google Play)`);
        } catch (err) {
          update(p.productId, "android", { ...p.android, state: "failed", error: (err as Error).message, at: deps.now.toISOString() });
          failed.push(`${p.productId} (Google Play): ${(err as Error).message}`);
        }
      }
    }
  }
  if (created.length) f = addLog(f, `Created ${created.join(", ")}.`, deps.now);
  for (const x of failed) f = addLog(f, `Couldn't create ${x}`, deps.now);
  return { file: f, created, failed };
}
