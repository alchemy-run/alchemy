import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Integration } from "./Integration.ts";

/**
 * Dashboard UI providers for Cloudflare Zero Trust Risk Scoring resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const IntegrationUI = UIProvider.succeed<Integration>(
  "Cloudflare.RiskScoring.Integration",
  {
    displayName: "Risk Scoring Integration",
    icon: "shield-alert",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.tenantUrl,
    facts: (ctx) => [
      { label: "type", value: ctx.attrs?.integrationType },
      {
        label: "tenant url",
        value: ctx.attrs?.tenantUrl,
        href: ctx.attrs?.tenantUrl,
        copy: true,
      },
      {
        label: "integration id",
        value: ctx.attrs?.integrationId,
        mono: true,
        copy: true,
      },
      { label: "reference id", value: ctx.attrs?.referenceId, mono: true },
      { label: "active", value: ctx.attrs?.active },
      {
        label: "well-known url",
        value: ctx.attrs?.wellKnownUrl,
        href: ctx.attrs?.wellKnownUrl,
        mono: true,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(IntegrationUI);
