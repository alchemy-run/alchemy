/**
 * Cloudflare's published rate for the Email resources that have a real,
 * deterministic price — attached to each resource's
 * `ProviderService.pricing` (see `../../Provider.ts`, `../../Cost.ts`).
 *
 * Only outbound sending is metered. A {@link SendingSubdomain} is what
 * enables a zone to send transactional email to arbitrary recipients, and
 * that traffic bills at $0.35 per 1,000 emails with 3,000 emails/month
 * included on the Workers Paid plan. Everything else in this directory is
 * Email Routing (free on every plan — sends to verified destination
 * addresses never count toward the quota) or Email Security configuration
 * (an Enterprise contract entitlement), so those resources carry no
 * `pricing` field: absence is the representation for free and for
 * contract-billed, not a $0 line.
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-08:
 * - https://developers.cloudflare.com/email-service/platform/pricing/
 *   ("$0.35 per 1,000 emails" beyond 3,000 included per month; "Sending to
 *   arbitrary recipients requires the Workers Paid plan"; Email Routing is
 *   free on both Workers Free and Paid)
 * - https://developers.cloudflare.com/email-service/platform/limits/
 *   ("Sends to verified destination addresses are always free")
 */
import type { ResourceCost } from "../../Cost.ts";
import type { SendingSubdomainProps } from "./SendingSubdomain.ts";

/** Outbound email beyond the included monthly quota, per 1,000 emails. */
const EMAIL_SEND_USD_PER_THOUSAND = 0.35;

export const EmailSendingPricing: ResourceCost<SendingSubdomainProps> = {
  // A sending subdomain costs nothing until email is actually sent.
  floorMonthlyUsd: () => 0,
  // Sending to arbitrary recipients requires the Workers Paid plan.
  requiresPaidPlan: true,
  // Neither the zone nor the subdomain name changes the rate, so there is
  // no price-determining prop to read through `planProp` here.
  rates: () => [
    {
      label: "Email Service outbound sends",
      perUnit: EMAIL_SEND_USD_PER_THOUSAND,
      unit: "1,000 emails",
      freeIncluded:
        "3,000/mo free (sends to verified destination addresses are always free)",
    },
  ],
};
