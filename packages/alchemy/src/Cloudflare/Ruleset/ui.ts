import * as Layer from "effect/Layer";

/**
 * Dashboard UI providers for Cloudflare Ruleset resources.
 *
 * Implemented by the dashboard UI factory — see processes/Dashboard.md for
 * the UIProvider contract. Until then this is an empty layer so the
 * aggregators and the dashboard SPA compile.
 */
export const ui = (): Layer.Layer<never> => Layer.empty;
