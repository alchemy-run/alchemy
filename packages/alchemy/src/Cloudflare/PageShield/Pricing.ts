/**
 * Page Shield's published rate, attached to the zone-level
 * {@link SettingsProvider} (see `../../Cost.ts`, `../../Provider.ts`).
 *
 * Page Shield is sold as the "Client-Side Security" add-on, the one
 * application-security product in this group with a real published
 * per-unit meter: `$0.099/1k requests`. Basic script monitoring ships with
 * every plan tier at no extra charge; the metered add-on adds malicious
 * script/connection detection, advanced cookie fields, and content
 * security rules.
 *
 * The meter is zone-wide, so it attaches to `PageShield.Settings` (the
 * singleton that turns the product on for a zone) and NOT to
 * `PageShield.Policy` — a policy is a Content Security Policy rule inside
 * an already-metered zone and carries no independent billing dimension.
 * Pricing it too would double-count the same requests once per rule.
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-08:
 * - https://www.cloudflare.com/plans/ ("Client-Side Security — $0.099/1k requests")
 * - https://developers.cloudflare.com/client-side-security/ (per-plan feature availability)
 *
 * Plan-time rule (same as a provider `diff`): props may still contain
 * unresolved `Output`s, so every price-determining prop is read through
 * `planProp` and degrades to a labeled default when its value is unknown.
 */
import { planProp, type ResourceCost } from "../../Cost.ts";
import type { SettingsProps } from "./Settings.ts";

/** USD per 1,000 requests scanned by Client-Side Security. */
const PAGE_SHIELD_USD_PER_1K_REQUESTS = 0.099;

export const PageShieldPricing: ResourceCost<SettingsProps> = {
  // Purely usage-metered — a zone with the product enabled and no traffic
  // is charged nothing.
  floorMonthlyUsd: () => 0,
  // Page Shield is a zone add-on, unrelated to the Workers Paid plan.
  requiresPaidPlan: false,
  rates: (props) => {
    const enabled = planProp(props, "enabled");
    // The resource exists to turn the feature on, so an absent `enabled`
    // means enabled (see `SettingsProps.enabled`).
    if (enabled.value === false) {
      // Explicitly disabled — nothing is scanned, so nothing is metered.
      return [];
    }
    return [
      {
        label: enabled.unresolved
          ? "Client-Side Security requests (enabled unresolved at plan time — metered rates shown)"
          : "Client-Side Security requests",
        perUnit: PAGE_SHIELD_USD_PER_1K_REQUESTS,
        unit: "1k requests",
        freeIncluded: "basic script monitoring included on all plan tiers",
      },
    ];
  },
};
