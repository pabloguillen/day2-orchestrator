/**
 * The metric layer (docs/closed-loop-spec.md §4) — "One module owns all KPI
 * definitions. Every loop reads from it." This barrel is that one module;
 * every individual KPI function lives in the domain files it re-exports.
 */

export * from "./types";
export * from "./confidence";
export * from "./breakdown";
export * from "./core";
export * from "./ltv";
export * from "./acquisition-virality-kpis";
export * from "./activation-engagement-kpis";
export * from "./retention-kpis";
export * from "./monetization-kpis";
export * from "./quality-satisfaction-kpis";
export * from "./day2-kpis";
