/**
 * Cloudflare Zaraz's published rate — attached to the `Config` resource's
 * `ProviderService.pricing` (see `../../Provider.ts`, `../../Cost.ts`).
 *
 * Zaraz is metered per *event* (a page view, a `zaraz.track` call, or
 * similar). Every account gets 1,000,000 events per month free; beyond
 * that the Zaraz Paid plan charges $5 per additional 1,000,000 events. The
 * free allotment means there is no monthly charge at zero usage, so
 * `floorMonthlyUsd` is `0`, and Zaraz does not require the $5/mo Workers
 * Paid plan that `requiresPaidPlan` deduplicates.
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-08:
 * https://developers.cloudflare.com/zaraz/pricing-info/
 *
 * Plan-time rule (same as a provider `diff`): props may still contain
 * unresolved `Output`s, so every price-determining prop is read through
 * `planProp` and degrades to a labeled default when its value is unknown.
 * Nothing in `ConfigProps` changes the per-event rate — the tool, trigger
 * and variable configuration only decides which events fire, which is
 * runtime traffic and unknowable at plan time.
 */
import type { ResourceCost } from "../../Cost.ts";
import type { ConfigProps } from "./Config.ts";

const USD_PER_MILLION_EVENTS = 5.0;

export const ZarazPricing: ResourceCost<ConfigProps> = {
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: false,
  rates: () => [
    {
      label: "Zaraz events",
      perUnit: USD_PER_MILLION_EVENTS,
      unit: "million events",
      freeIncluded: "1M/mo free (per account)",
    },
  ],
};
