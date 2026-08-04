/**
 * Cloudflare Load Balancing's published add-on fee — attached to the
 * `LoadBalancer` resource's `ProviderService.pricing` (see
 * `../../Provider.ts`, `../../Cost.ts`).
 *
 * Load Balancing is a subscription add-on, not a usage-metered product:
 * Cloudflare publishes a flat $5/mo starting price and nothing else. The
 * granular line items an invoice shows (origins, health-check intervals,
 * health-check regions) are only quoted in the dashboard for a specific
 * configuration, so there is no publishable per-unit rate to list here —
 * `rates` is deliberately empty rather than filled with guessed numbers.
 *
 * The fee is charged once per Load Balancing subscription, and the
 * `LoadBalancer` resource is what requires that subscription (creating one
 * on an unsubscribed zone fails with `LoadBalancingNotEnabledForZone`), so
 * the fee is attributed here. A plan that creates several load balancers
 * against one subscription therefore over-reports the floor — the
 * alternative, attributing it nowhere, hides a real recurring charge.
 * `Pool`, `Monitor` and `MonitorGroup` are covered by the same
 * subscription and carry no `pricing` field, so they add nothing.
 *
 * `requiresPaidPlan` is `false`: this is not the $5/mo Workers Paid plan
 * that flag deduplicates — it is a separate, additive product fee, which
 * is why it lives in `floorMonthlyUsd`.
 *
 * Rate verified against Cloudflare's published pricing page, 2026-08:
 * https://www.cloudflare.com/plans/ (Load Balancing add-on, "$5/month")
 * https://developers.cloudflare.com/load-balancing/
 */
import type { ResourceCost } from "../../Cost.ts";
import type { Props as LoadBalancerProps } from "./LoadBalancer.ts";

/** Published starting price of the Load Balancing add-on, USD per month. */
export const LOAD_BALANCING_MONTHLY_USD = 5.0;

export const LoadBalancerPricing: ResourceCost<LoadBalancerProps> = {
  // A deployed load balancer bills its subscription fee whether or not a
  // single request is steered — a genuine zero-usage monthly charge.
  floorMonthlyUsd: () => LOAD_BALANCING_MONTHLY_USD,
  requiresPaidPlan: false,
  // Cloudflare publishes no per-unit Load Balancing rate outside the
  // dashboard; showing an invented one would be worse than showing none.
  rates: () => [],
};
