/**
 * Cloudflare's published rate for the Logpush resources that have a real,
 * deterministic price — attached to each resource's
 * `ProviderService.pricing` (see `../../Provider.ts`, `../../Cost.ts`).
 *
 * Only Workers Logpush is metered per unit: pushing the
 * `workers_trace_events` dataset costs $0.05 per million request logs that
 * reach the destination after filtering/sampling, with 10 million included
 * per month, and is available only on the Workers Paid plan. Every other
 * dataset a {@link Job} can push (`http_requests`, `firewall_events`,
 * `audit_logs`, …) is an Enterprise-contract entitlement with no published
 * per-unit rate, so those jobs show no rate line at all rather than a
 * fabricated one.
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-08:
 * - https://developers.cloudflare.com/workers/platform/pricing/
 *   ("Logpush ... $0.05/million request logs, 10 million/month included,
 *   only available on the Workers Paid plan")
 *
 * Plan-time rule (same as a provider `diff`): props may still contain
 * unresolved `Output`s, so every price-determining prop is read through
 * `planProp` and degrades to a labeled default when its value is unknown.
 */
import { planProp, type ResourceCost } from "../../Cost.ts";
import type { JobProps } from "./Job.ts";

/** Per million request logs delivered to the Logpush destination. */
const WORKERS_LOGPUSH_USD_PER_MILLION = 0.05;

/**
 * The datasets Workers Logpush meters. Everything else Logpush can push is
 * billed through an Enterprise contract, not a published per-unit rate.
 */
const WORKERS_LOGPUSH_DATASETS: ReadonlySet<string> = new Set([
  "workers_trace_events",
]);

export const LogpushPricing: ResourceCost<JobProps> = {
  // A Logpush job costs nothing until logs actually flow.
  floorMonthlyUsd: () => 0,
  // Workers Logpush is gated on the Workers Paid plan.
  requiresPaidPlan: true,
  rates: (props) => {
    const dataset = planProp(props, "dataset");
    if (
      dataset.value !== undefined &&
      !WORKERS_LOGPUSH_DATASETS.has(dataset.value)
    ) {
      // Enterprise-contract dataset — no published per-unit rate exists to
      // show, and inventing the Workers rate for it would be wrong.
      return [];
    }
    return [
      {
        label: dataset.unresolved
          ? "Workers Logpush request logs (dataset unresolved at plan time — Workers Logpush rates shown)"
          : "Workers Logpush request logs",
        perUnit: WORKERS_LOGPUSH_USD_PER_MILLION,
        unit: "million request logs delivered",
        freeIncluded: "10M/mo free (after filtering and sampling)",
      },
    ];
  },
};
