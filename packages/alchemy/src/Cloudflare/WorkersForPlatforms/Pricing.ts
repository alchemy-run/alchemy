/**
 * Workers for Platforms rates, attached to the dispatch namespace
 * provider's `ProviderService.pricing` (see `../../Provider.ts`,
 * `../../Cost.ts`).
 *
 * Workers for Platforms is the one Workers-family product with a real
 * zero-usage monthly charge: the $25/mo Workers for Platforms plan, which
 * supersedes (rather than adds to) the $5/mo Workers Paid subscription.
 * That makes it a product-specific base fee — `floorMonthlyUsd`, not
 * `requiresPaidPlan` (which the CLI reserves for deduplicating the $5/mo
 * Workers Paid fee across every paid-plan resource in a plan).
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-08:
 * - https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/
 */
import type { ResourceCost } from "../../Cost.ts";
import type { DispatchNamespaceProps } from "./DispatchNamespace.ts";

/** The Workers for Platforms plan fee, in USD/month. */
export const WORKERS_FOR_PLATFORMS_MONTHLY_USD = 25;

export const DispatchNamespacePricing: ResourceCost<DispatchNamespaceProps> = {
  // The $25/mo subscription is account-level: a second namespace in the
  // same account adds no second subscription. There is no account-scoped
  // dedup hook in `ResourceCost` (only `requiresPaidPlan`, which is
  // hard-wired to the Workers Paid fee), so a plan touching two dispatch
  // namespaces overstates this floor. Stacks realistically deploy one.
  floorMonthlyUsd: () => WORKERS_FOR_PLATFORMS_MONTHLY_USD,
  requiresPaidPlan: false,
  // `name` is the namespace's identity and changes no rate — no
  // `planProp` branch is needed.
  rates: () => [
    {
      label: "Workers for Platforms requests",
      perUnit: 0.3,
      unit: "million requests",
      freeIncluded: "20M/mo included",
    },
    {
      label: "Workers for Platforms CPU time",
      perUnit: 0.02,
      unit: "million ms",
      freeIncluded: "60M ms/mo included",
    },
    {
      label: "Workers for Platforms user Workers",
      perUnit: 0.02,
      unit: "script",
      freeIncluded: "1,000 scripts included",
    },
  ],
};
