import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../day2-paths";

/**
 * Exchange rates for ad accounts that aren't in USD (a customer's own EUR
 * account, say). day2 plans and compares in USD; budgets are converted into
 * the account's currency when set, and reported spend back to USD.
 *
 * Rates: the European Central Bank's daily reference rates (via
 * frankfurter.app), refreshed once a day and cached on disk. An env
 * override (`DAY2_FX_EUR=0.92` = EUR per USD) wins; without either, a
 * conservative built-in table keeps things running.
 */

const FALLBACK: Record<string, number> = { USD: 1, EUR: 0.92, GBP: 0.79, CHF: 0.88, CAD: 1.37, AUD: 1.52, SEK: 10.6, NOK: 10.8, DKK: 6.9, PLN: 3.95, JPY: 150, INR: 84, BRL: 5.6, MXN: 19.5 };
const DAY = 86_400_000;
let rates: { at: number; perUsd: Record<string, number> } | null = null;

const cacheFile = () => join(dataDir(), ".day2-fx.json");

function load(): void {
  if (rates) return;
  try {
    if (existsSync(cacheFile())) rates = JSON.parse(readFileSync(cacheFile(), "utf-8")) as typeof rates;
  } catch {
    rates = null;
  }
}

/** Refreshes the rates if they're older than a day. Never throws. */
export async function refreshRates(doFetch: typeof fetch = fetch, now = Date.now()): Promise<void> {
  load();
  if (rates && now - rates.at < DAY) return;
  try {
    const res = await doFetch("https://api.frankfurter.app/latest?from=USD");
    if (!res.ok) return;
    const j = (await res.json()) as { rates?: Record<string, number> };
    if (!j.rates) return;
    rates = { at: now, perUsd: { USD: 1, ...j.rates } };
    try {
      writeFileSync(cacheFile(), JSON.stringify(rates));
    } catch {
      /* cache is optional */
    }
  } catch {
    /* keep the last rates */
  }
}

/** Units of `currency` per 1 USD. */
export function perUsd(currency: string): number {
  const c = currency.toUpperCase();
  const env = Number(process.env[`DAY2_FX_${c}`]);
  if (Number.isFinite(env) && env > 0) return env;
  load();
  const r = rates?.perUsd[c] ?? FALLBACK[c];
  if (!r) throw new Error(`No exchange rate for ${c}.`);
  return r;
}

export const fromUsd = (usd: number, currency: string) => Math.round(usd * perUsd(currency) * 100) / 100;
export const toUsd = (amount: number, currency: string) => Math.round((amount / perUsd(currency)) * 10_000) / 10_000;

/** For tests. */
export function setRatesForTest(perUsdTable: Record<string, number> | null): void {
  rates = perUsdTable ? { at: Date.now(), perUsd: perUsdTable } : null;
}
