/**
 * Cloudflare's published rates for the Pages resources that have a real,
 * deterministic price — attached to each resource's
 * `ProviderService.pricing` (see `../../Provider.ts`, `../../Cost.ts`).
 *
 * Pages has no billing dimension of its own: requests to a project's
 * Functions are billed as Workers requests and CPU time, drawing on the
 * same monthly allotment, while requests to static assets are free and
 * unlimited. Those Workers rates are the only metered usage attributable
 * to a {@link Project}, so they are what the project shows.
 *
 * A {@link Deployment} carries no separate rate — its runtime traffic is
 * billed on the project, and builds are a plan-tier quota (500/mo Free,
 * 5,000/mo Pro, 20,000/mo Business) with no per-build charge. Custom
 * {@link Domain}s are free. Neither carries a `pricing` field.
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-08:
 * - https://developers.cloudflare.com/pages/functions/pricing/
 *   ("Requests to your Functions are billed as Cloudflare Workers
 *   requests"; "Requests to static assets are free and unlimited")
 * - https://developers.cloudflare.com/workers/platform/pricing/
 *   ("10 million included per month", "+$0.30 per additional million";
 *   "30 million CPU milliseconds included per month", "+$0.02 per
 *   additional million CPU milliseconds"; Free plan "100,000 per day")
 * - https://developers.cloudflare.com/pages/platform/limits/
 *   (monthly build quotas per plan)
 */
import type { ResourceCost } from "../../Cost.ts";
import type { ProjectProps } from "./Project.ts";

/** Pages Functions requests, per additional million (the Workers rate). */
const FUNCTIONS_USD_PER_MILLION_REQUESTS = 0.3;

/** Pages Functions CPU time, per additional million CPU-ms (the Workers rate). */
const FUNCTIONS_USD_PER_MILLION_CPU_MS = 0.02;

export const PagesPricing: ResourceCost<ProjectProps> = {
  // A Pages project costs nothing until it serves traffic.
  floorMonthlyUsd: () => 0,
  // Pages, including Functions, runs on the Workers Free plan too.
  requiresPaidPlan: false,
  // Nothing on a Pages project (name, branch, build config, bindings)
  // changes the rate, so there is no price-determining prop to read
  // through `planProp` here.
  rates: () => [
    {
      label: "Pages Functions requests",
      perUnit: FUNCTIONS_USD_PER_MILLION_REQUESTS,
      unit: "million requests",
      freeIncluded: "10M/mo free, shared with Workers (100k/day on Free)",
    },
    {
      label: "Pages Functions CPU time",
      perUnit: FUNCTIONS_USD_PER_MILLION_CPU_MS,
      unit: "million ms",
      freeIncluded: "30M ms/mo free, shared with Workers",
    },
    {
      label: "Pages static asset requests",
      perUnit: 0,
      unit: "request",
      freeIncluded: "always free and unlimited",
    },
  ],
};
