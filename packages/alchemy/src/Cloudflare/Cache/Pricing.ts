/**
 * Cloudflare Cache Reserve's published rates — attached to the `Reserve`
 * resource's `ProviderService.pricing` (see `../../Provider.ts`,
 * `../../Cost.ts`).
 *
 * Cache Reserve is the one billable resource in this directory: it is a
 * usage-metered add-on backed by R2, priced per GB-month of stored data
 * plus per-operation. Everything else here (Tiered Cache, Smart Tiered
 * Cache topology, cache variants, origin cloud region hints) is available
 * on every plan at no additional cost, so those resources deliberately
 * carry no `pricing` field at all.
 *
 * There is no monthly minimum — an enabled-but-empty Cache Reserve costs
 * nothing — so `floorMonthlyUsd` is `0`. Cache Reserve does require a paid
 * Cloudflare *zone* plan, but not the $5/mo Workers Paid plan that
 * `requiresPaidPlan` deduplicates, so that flag stays `false`.
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-08:
 * https://developers.cloudflare.com/cache/advanced-configuration/cache-reserve/
 *
 * Plan-time rule (same as a provider `diff`): props may still contain
 * unresolved `Output`s, so every price-determining prop is read through
 * `planProp` and degrades to a labeled default when its value is unknown.
 */
import { planProp, type ResourceCost } from "../../Cost.ts";
import type { ReserveProps } from "./Reserve.ts";

const STORAGE_USD_PER_GB_MONTH = 0.015;
const CLASS_A_USD_PER_MILLION = 4.5;
const CLASS_B_USD_PER_MILLION = 0.36;

export const CacheReservePricing: ResourceCost<ReserveProps> = {
  // Usage-billed only — an enabled Cache Reserve holding nothing bills
  // nothing.
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: false,
  rates: (props) => {
    const enabled = planProp(props, "enabled");
    // `enabled` defaults to true (see `Reserve.ts`'s `desiredValue`).
    const on = enabled.value ?? true;
    // Disabling Cache Reserve stops new writes but does NOT purge data
    // already in reserve — that storage keeps billing until it expires or
    // is cleared (`clearOnDelete`).
    const suffix = enabled.unresolved
      ? " (enabled state unresolved at plan time — enabled rates shown)"
      : on
        ? ""
        : " (disabled — data already in reserve bills until cleared)";
    return [
      {
        label: `Cache Reserve storage${suffix}`,
        perUnit: STORAGE_USD_PER_GB_MONTH,
        unit: "GB-month",
      },
      {
        label: `Cache Reserve Class A operations (writes)${suffix}`,
        perUnit: CLASS_A_USD_PER_MILLION,
        unit: "million operations",
      },
      {
        label: `Cache Reserve Class B operations (reads)${suffix}`,
        perUnit: CLASS_B_USD_PER_MILLION,
        unit: "million operations",
      },
    ];
  },
};
