/**
 * Cloudflare Images' published rates, attached to the Images variant's
 * `ProviderService.pricing` (see `../../Cost.ts`).
 *
 * Images bills three dimensions: images stored, images delivered, and
 * unique transformations. Defining a variant costs nothing on its own —
 * "defining variants will not impact your storage limit" — but a variant
 * is the delivery shape a stored image is served through, so requesting it
 * is what drives the delivered and transformed dimensions. Those are the
 * rates shown here.
 *
 * Images signing keys carry no published rate and intentionally have no
 * `pricing` field.
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-08:
 * - https://developers.cloudflare.com/images/pricing/
 *
 * No prop on a variant changes which rate applies (width/height/fit alter
 * the delivered image, not its price), so nothing here needs `planProp`.
 */
import type { ResourceCost } from "../../Cost.ts";
import type { VariantProps } from "./Variant.ts";

export const ImagesPricing: ResourceCost<VariantProps> = {
  // Nothing is charged for holding a variant definition.
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: false,
  rates: () => [
    {
      label: "Images stored",
      perUnit: 5,
      unit: "100,000 images stored/month",
    },
    {
      label: "Images delivered",
      perUnit: 1,
      unit: "100,000 images delivered/month",
    },
    {
      label: "Images transformed",
      perUnit: 0.5,
      unit: "1,000 unique transformations/month",
      freeIncluded: "5,000/mo free",
    },
  ],
};
