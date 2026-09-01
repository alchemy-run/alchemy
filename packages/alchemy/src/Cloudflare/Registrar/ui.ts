import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Domain } from "./Domain.ts";

/**
 * Dashboard UI providers for Cloudflare Registrar resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const DomainUI = UIProvider.succeed<Domain>(
  "Cloudflare.Registrar.Domain",
  {
    displayName: "Registrar Domain",
    icon: "globe-lock",
    color: "#F6821F",
    category: "dns",
    summary: (ctx) => ctx.attrs?.domainName ?? ctx.props?.domainName,
    link: (ctx) =>
      ctx.attrs?.domainName ? `https://${ctx.attrs.domainName}` : undefined,
    facts: (ctx) => [
      { label: "domain", value: ctx.attrs?.domainName, copy: true },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
      { label: "registrar", value: ctx.attrs?.currentRegistrar },
      { label: "expires", value: ctx.attrs?.expiresAt },
      { label: "auto renew", value: ctx.attrs?.autoRenew },
      { label: "locked", value: ctx.attrs?.locked },
      { label: "privacy", value: ctx.attrs?.privacy },
      {
        label: "registry statuses",
        value: ctx.attrs?.registryStatuses,
        mono: true,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(DomainUI);
