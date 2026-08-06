/**
 * Cost model for the SSL/TLS resources that carry a real published price.
 *
 * Only {@link CertificatePackPricing} exists here. A certificate pack is an
 * **Advanced Certificate Manager** order, and ACM is a paid add-on — the one
 * resource in this directory that costs money. `UniversalSsl` is free on
 * every plan and therefore has no pricing model at all: absence of a
 * `pricing` field, not a `$0` entry, is how a free resource is represented
 * (see the scoping docstring in `../CloudflarePricing.ts`).
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-08:
 * - https://www.cloudflare.com/plans/ — "Advanced Certificate Manager $10/mo"
 * - https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/
 * - https://developers.cloudflare.com/ssl/reference/all-features/ — Universal
 *   SSL free on all plans; ACM a paid add-on on all plans.
 */
import { type ResourceCost } from "../../Cost.ts";
import type { CertificatePackProps } from "./CertificatePack.ts";

/**
 * The Advanced Certificate Manager subscription fee, in USD per month.
 * Billed **per zone**, not per certificate pack.
 */
export const ACM_MONTHLY_USD = 10;

/**
 * Advanced Certificate Manager — a flat $10/mo subscription that a zone must
 * hold before it can order certificate packs at all, so it is a genuine
 * zero-usage floor rather than a metered rate.
 *
 * Nothing about a pack's props moves the price: the certificate authority,
 * validation method, validity period, and host count (up to the 50-host pack
 * limit) are all covered by the same subscription. There is consequently no
 * `planProp` guard here — an unresolved prop cannot mis-price this resource.
 *
 * Attribution caveat, deliberate: Cloudflare bills ACM once per **zone**,
 * while alchemy attributes cost per resource. A plan containing several
 * certificate packs in one zone therefore overstates the subscription — the
 * rate line below says so, since a bare floor number cannot.
 */
export const CertificatePackPricing: ResourceCost<CertificatePackProps> = {
  // A zone pays the ACM subscription whether or not the pack ever serves a
  // byte, so unlike Cloudflare's serverless products this floor is nonzero.
  floorMonthlyUsd: () => ACM_MONTHLY_USD,
  // ACM is an SSL/TLS add-on sold against the zone, available even on the
  // Free plan — it does not imply the $5/mo Workers Paid plan.
  requiresPaidPlan: false,
  rates: () => [
    {
      label:
        "Advanced Certificate Manager subscription (billed per zone — several packs in one zone are billed once)",
      perUnit: ACM_MONTHLY_USD,
      unit: "zone-month",
    },
  ],
};
