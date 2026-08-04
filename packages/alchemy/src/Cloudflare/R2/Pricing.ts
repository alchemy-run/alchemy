/**
 * Rates for the R2 sub-resources that bill on their own dimensions,
 * attached to each provider's `ProviderService.pricing` (see
 * `../../Provider.ts`, `../../Cost.ts`). The bucket itself is priced by
 * `R2Pricing` in `../CloudflarePricing.ts`.
 *
 * Only R2 Data Catalog qualifies: it charges for Iceberg catalog
 * operations, and — when compaction is turned on — for the data and
 * objects compaction rewrites, all on top of the underlying bucket's
 * standard R2 storage and operation charges (already priced on the
 * bucket). R2 event notifications bill as Queue operations on the
 * destination queue, and Sippy is free beyond the standard bucket
 * operations it performs, so neither carries a rate of its own.
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-08:
 * - https://developers.cloudflare.com/r2/data-catalog/platform/pricing/
 * - https://developers.cloudflare.com/r2/pricing/
 *
 * Plan-time rule (same as a provider `diff`): props may still contain
 * unresolved `Output`s, so the compaction settings that decide whether
 * the compaction rates apply are read through `planProp` and degrade to a
 * labeled default when unknown.
 */
import { planProp, type ResourceCost } from "../../Cost.ts";
import type { DataCatalogProps } from "./DataCatalog.ts";

/** Cloudflare's default compaction target output file size, in MB. */
const DEFAULT_TARGET_SIZE_MB = "128";

export const DataCatalogPricing: ResourceCost<DataCatalogProps> = {
  // A catalog with no tables and no traffic costs nothing — every
  // dimension is metered.
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: false,
  rates: (props) => {
    const compaction = planProp(props, "compaction");
    // Compaction is opt-in: Cloudflare leaves it off until a catalog
    // enables it, so its rates only apply when the props turn it on (or
    // when the setting is unknown at plan time, where showing the rates
    // beats hiding a charge that may well apply).
    const enabled = compaction.unresolved
      ? true
      : compaction.value?.state === "enabled";
    const targetSizeMb =
      compaction.value?.targetSizeMb ?? DEFAULT_TARGET_SIZE_MB;

    const rates = [
      {
        label: "R2 Data Catalog operations",
        perUnit: 9.0,
        unit: "million operations",
        freeIncluded: "1M/mo free",
      },
    ];
    if (!enabled) return rates;

    const suffix = compaction.unresolved
      ? " (compaction unresolved at plan time — enabled rates shown)"
      : ` (compaction target ${targetSizeMb} MB)`;
    return [
      ...rates,
      {
        label: `R2 Data Catalog compaction data processed${suffix}`,
        perUnit: 0.005,
        unit: "GB processed",
        freeIncluded: "10 GB/mo free",
      },
      {
        label: `R2 Data Catalog compaction objects processed${suffix}`,
        perUnit: 2.0,
        unit: "million objects",
        freeIncluded: "1M/mo free",
      },
    ];
  },
};
