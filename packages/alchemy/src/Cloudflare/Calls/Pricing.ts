/**
 * Cloudflare Realtime's (formerly "Calls") published rates, attached to the
 * SFU application's and TURN key's `ProviderService.pricing` (see
 * `../../Cost.ts`).
 *
 * Realtime bills a single dimension for both services: $0.05 per GB of data
 * egress, with one shared 1,000 GB monthly free tier across SFU and TURN —
 * not two independent free tiers. Only traffic leaving Cloudflare toward
 * clients is charged; traffic pushed to Cloudflare is free. Because the
 * allotment is shared, the two rate lines below are deliberately identical
 * apart from which service they name.
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-08:
 * - https://developers.cloudflare.com/realtime/pricing/
 *
 * Neither resource has a prop that changes which rate applies (both take
 * only a display `name`), so nothing here needs `planProp`.
 */
import type { ResourceCost } from "../../Cost.ts";
import type { AppProps } from "./App.ts";
import type { TurnKeyProps } from "./TurnKey.ts";

const REALTIME_EGRESS_USD_PER_GB = 0.05;
const REALTIME_FREE_TIER = "1,000 GB/mo free (shared across SFU + TURN)";

export const RealtimeSfuPricing: ResourceCost<AppProps> = {
  // Nothing is charged for an idle app — only for data actually egressed.
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: false,
  rates: () => [
    {
      label: "Realtime SFU egress",
      perUnit: REALTIME_EGRESS_USD_PER_GB,
      unit: "GB egress",
      freeIncluded: REALTIME_FREE_TIER,
    },
    {
      label: "Realtime SFU ingress",
      perUnit: 0,
      unit: "GB pushed to Cloudflare",
      freeIncluded: "always free",
    },
  ],
};

export const RealtimeTurnPricing: ResourceCost<TurnKeyProps> = {
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: false,
  rates: () => [
    {
      label: "Realtime TURN egress",
      perUnit: REALTIME_EGRESS_USD_PER_GB,
      unit: "GB egress",
      freeIncluded: REALTIME_FREE_TIER,
    },
  ],
};
