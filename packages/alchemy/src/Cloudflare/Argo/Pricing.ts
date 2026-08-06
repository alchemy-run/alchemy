/**
 * Cloudflare's published rates for the Argo resources that have a real,
 * deterministic price — attached to each resource's
 * `ProviderService.pricing` (see `../../Provider.ts`, `../../Cost.ts`).
 *
 * Only {@link ArgoSmartRoutingPricing} is modeled. Tiered Caching is not:
 * the generic Tiered Cache toggle carries no separate published rate — it
 * is bundled into the Argo subscription and, standalone, gated on a plan
 * tier rather than metered. Absence of a `pricing` field is the correct
 * representation for that, not a $0 entry.
 *
 * Argo is the unusual Cloudflare product that DOES cost money at zero
 * usage: enabling Smart Routing on a zone subscribes it to a flat
 * $5/month, on top of $0.10 per GB of Argo data transfer beyond the
 * first GB, which the subscription includes. The $5 is a
 * product-specific monthly fee, so it lives in `floorMonthlyUsd` — not
 * `requiresPaidPlan`, which is reserved for the $5/mo Workers Paid plan
 * the CLI dedupes once per plan.
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-08:
 * - https://www.cloudflare.com/plans/ ("Argo Smart Routing — Starting at $5/mo")
 * - https://developers.cloudflare.com/billing/understand/how-charges-accrue/
 *   ("Metered per GB transferred between Cloudflare and your origin.
 *   First 1 GB included.") — the current first-party statement of both
 *   the metered dimension and the included allotment.
 * - https://blog.cloudflare.com/argo/ ("$5/domain monthly, plus $0.10 per GB
 *   of transfer") — the per-GB number, which the billing docs describe
 *   but do not quote.
 * - https://developers.cloudflare.com/argo-smart-routing/ (paid add-on,
 *   usage-based billing)
 *
 * Plan-time rule (same as a provider `diff`): props may still contain
 * unresolved `Output`s, so every price-determining prop is read through
 * `planProp` and degrades to a labeled default when its value is unknown.
 */
import { planProp, type ResourceCost } from "../../Cost.ts";
import type { SmartRoutingProps } from "./SmartRouting.ts";

/** Flat monthly Argo subscription fee, charged per zone with Smart Routing on. */
const ARGO_MONTHLY_USD = 5;

/** Argo data transfer, per GB beyond the included first GB. */
const ARGO_USD_PER_GB = 0.1;

/**
 * Allotment bundled into the $5/mo subscription — Cloudflare bills Argo
 * data transfer only past the first GB each month.
 */
const ARGO_FREE_INCLUDED = "1 GB/mo";

/**
 * Argo Smart Routing — $5/mo per zone plus $0.10/GB of data transfer
 * past the first GB, which the subscription includes.
 *
 * `enabled: false` turns Smart Routing off on the zone, so the
 * subscription fee does not apply; anything else (including the default,
 * and an unresolved plan-time `Output`) prices as enabled.
 */
export const ArgoSmartRoutingPricing: ResourceCost<SmartRoutingProps> = {
  // Unlike Cloudflare's serverless products, Argo bills the moment it is
  // switched on — the $5/mo is owed at zero traffic.
  floorMonthlyUsd: (props) => {
    const enabled = planProp(props, "enabled");
    // Absent means the resource's own default (`true`); unresolved reads
    // the same way, since an unknown toggle most likely enables Argo.
    return enabled.value === false ? 0 : ARGO_MONTHLY_USD;
  },
  // Argo is its own paid add-on, not the Workers Paid plan.
  requiresPaidPlan: false,
  rates: (props) => {
    const enabled = planProp(props, "enabled");
    const label =
      enabled.value === false
        ? "Argo Smart Routing data transfer (disabled on this zone)"
        : enabled.unresolved
          ? "Argo Smart Routing data transfer (enabled unresolved at plan time — enabled rates shown)"
          : "Argo Smart Routing data transfer";
    return [
      {
        label,
        perUnit: ARGO_USD_PER_GB,
        unit: "GB transferred between Cloudflare and origin",
        freeIncluded: ARGO_FREE_INCLUDED,
      },
    ];
  },
};
