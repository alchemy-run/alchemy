/**
 * AI Gateway's published rates, attached to the gateway's
 * `ProviderService.pricing` (see `../../Cost.ts`).
 *
 * AI Gateway's core features — dashboard analytics, caching, rate limiting,
 * guardrails and DLP — are free on every plan, and persistent log retention
 * is bundled into the Workers plan tier (100,000 logs total on Free,
 * 10,000,000 logs per gateway on Paid). The one metered dimension a gateway
 * can turn on is Logpush, which is Workers-Paid-only and billed at
 * $0.05/million events beyond 10 million per month — so the Logpush line is
 * emitted only when the `logpush` prop is on (or is unresolved at plan
 * time). Guardrails inference is billed through Workers AI's own token
 * rates with no gateway markup, and provider inference through Unified
 * Billing carries a 5% fee on purchased credits — neither is a per-gateway
 * unit rate.
 *
 * Nothing else in this directory is priced: gateway providers, dynamic
 * routing, datasets and evaluations are free configuration; AI Search
 * (namespaces, instances, tokens) is in open beta and free, with rates
 * promised at least 30 days before billing begins; AI Security for Apps
 * settings and custom topics are zone entitlements, not metered resources.
 * Workers AI's $0.011 / 1,000 Neurons rate has no resource to hang off —
 * Workers AI is a Worker binding here, not a provisioned resource.
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-08:
 * - https://developers.cloudflare.com/ai-gateway/reference/pricing/
 * - https://developers.cloudflare.com/workers-ai/platform/pricing/
 * - https://developers.cloudflare.com/ai-search/platform/limits-pricing/
 *
 * Plan-time rule (same as a provider `diff`): props may still contain
 * unresolved `Output`s, so every price-determining prop is read through
 * `planProp` and degrades to a labeled default when its value is unknown.
 */
import { planProp, type ResourceCost } from "../../Cost.ts";
import type { GatewayProps } from "./Gateway.ts";

const LOGPUSH_USD_PER_MILLION = 0.05;

export const AiGatewayPricing: ResourceCost<GatewayProps> = {
  // Core features are free; nothing is charged for an idle gateway.
  floorMonthlyUsd: () => 0,
  // A gateway itself deploys on the Workers Free plan — only Logpush
  // requires Workers Paid, and that is a per-gateway opt-in rather than a
  // precondition of the resource.
  requiresPaidPlan: false,
  rates: (props) => {
    const logpush = planProp(props, "logpush");
    // Unresolved reads as "might be on" — show the metered line rather
    // than silently presenting the gateway as entirely free.
    const pushes = logpush.unresolved || logpush.value === true;
    return [
      ...(pushes
        ? [
            {
              label: logpush.unresolved
                ? "AI Gateway Logpush (logpush unresolved at plan time — Logpush rates shown)"
                : "AI Gateway Logpush",
              perUnit: LOGPUSH_USD_PER_MILLION,
              unit: "million log events",
              freeIncluded: "10M/mo free (Workers Paid only)",
            },
          ]
        : []),
      {
        label: "AI Gateway requests + persistent logs",
        perUnit: 0,
        unit: "request",
        freeIncluded:
          "core features free; log retention bundled into the Workers plan (100k Free / 10M per gateway Paid)",
      },
    ];
  },
};
