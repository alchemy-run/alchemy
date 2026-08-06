/**
 * Cost model for Cloudflare for SaaS custom hostnames.
 *
 * A custom hostname is one of the few Cloudflare resources billed per
 * *resource instance* rather than per unit of traffic: each onboarded
 * hostname costs $0.10/month beyond the first 100. `FallbackOrigin` is a
 * zone-level setting with no charge of its own — the hostnames pointed at it
 * are what bill — so it has no pricing model (see the scoping docstring in
 * `../CloudflarePricing.ts`).
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-08:
 * - https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/
 *   — "$0.10" per additional hostname on Free/Pro/Business, 100 hostnames
 *   included, 50,000 maximum; Enterprise is "Custom pricing".
 * - https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/
 *   — feature availability table: SNI rewrites and custom metadata are
 *   Enterprise-only; a custom origin server is available on every plan.
 */
import { planProp, type ResourceCost } from "../../Cost.ts";
import type { Props as CustomHostnameProps } from "./CustomHostname.ts";

/** Published pay-as-you-go rate per custom hostname per month, in USD. */
export const CUSTOM_HOSTNAME_USD_PER_MONTH = 0.1;

/** Hostnames included at no charge on the Free, Pro, and Business plans. */
export const CUSTOM_HOSTNAME_FREE_INCLUDED = 100;

/**
 * Props that Cloudflare only honors with the Enterprise Cloudflare for SaaS
 * entitlement. Setting any of them means this zone is on an Enterprise
 * contract, where hostname pricing is custom-quoted rather than the published
 * $0.10 pay-as-you-go rate.
 *
 * `customOriginServer` is deliberately NOT in this list: the plans page lists
 * "Custom origin" as available on Free, Pro, Business and Enterprise — only
 * the SNI rewrite (`customOriginSni`) and custom metadata are Enterprise-only.
 */
const ENTERPRISE_ONLY_PROPS = [
  "customOriginSni",
  "customMetadata",
] as const satisfies readonly (keyof CustomHostnameProps)[];

/**
 * Cloudflare for SaaS custom hostnames — $0.10 per hostname per month after
 * the 100 included on Free/Pro/Business.
 *
 * The floor is `0`: a deployment well inside the free 100 costs nothing, and
 * a resource-local model cannot know how many hostnames the account already
 * has, so charging every hostname a deterministic $0.10 would be wrong for
 * the common case. The per-hostname price is reported as a rate line with its
 * free allotment instead.
 *
 * The one price-relevant branch is the Enterprise entitlement: configuring a
 * custom origin SNI (SNI rewrite) or custom metadata puts the zone on an
 * Enterprise contract whose hostname pricing Cloudflare does not publish.
 * Those props are read through `planProp` so a value still unresolved at plan
 * time degrades to a labeled default rather than being read as "absent".
 */
export const CustomHostnamePricing: ResourceCost<CustomHostnameProps> = {
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: false,
  rates: (props) => {
    const entitlement = ENTERPRISE_ONLY_PROPS.map((key) =>
      planProp(props, key),
    );
    const enterpriseConfigured = entitlement.some((p) => p.value !== undefined);
    const enterpriseUnresolved = entitlement.some((p) => p.unresolved);

    // A known-set Enterprise prop is decisive; only fall back to the
    // "unresolved" wording when nothing is known either way.
    const label = enterpriseConfigured
      ? "Cloudflare for SaaS custom hostname (Enterprise-only options configured — Enterprise pricing is custom-quoted; pay-as-you-go rate shown)"
      : enterpriseUnresolved
        ? "Cloudflare for SaaS custom hostname (Enterprise options unresolved at plan time — pay-as-you-go rates shown)"
        : "Cloudflare for SaaS custom hostname";

    return [
      {
        label,
        perUnit: CUSTOM_HOSTNAME_USD_PER_MONTH,
        unit: "hostname-month",
        freeIncluded: `${CUSTOM_HOSTNAME_FREE_INCLUDED} hostnames free (Free/Pro/Business)`,
      },
    ];
  },
};
