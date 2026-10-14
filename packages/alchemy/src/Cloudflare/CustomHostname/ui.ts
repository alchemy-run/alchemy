import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { CustomHostname } from "./CustomHostname.ts";
import type { FallbackOrigin } from "./FallbackOrigin.ts";

/**
 * Dashboard UI providers for Cloudflare for SaaS Custom Hostname resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const CustomHostnameUI = UIProvider.succeed<CustomHostname>(
  "Cloudflare.CustomHostname.CustomHostname",
  {
    displayName: "Custom Hostname",
    icon: "globe-lock",
    color: "#F6821F",
    category: "dns",
    summary: (ctx) => ctx.attrs?.hostname,
    link: (ctx) =>
      ctx.attrs?.hostname === undefined || ctx.attrs?.status !== "active"
        ? undefined
        : `https://${ctx.attrs.hostname}`,
    facts: (ctx) => [
      { label: "hostname", value: ctx.attrs?.hostname, copy: true },
      {
        label: "hostname id",
        value: ctx.attrs?.customHostnameId,
        mono: true,
        copy: true,
      },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "ssl status", value: ctx.attrs?.sslStatus },
      {
        label: "ownership TXT",
        value: ctx.attrs?.ownershipVerification?.name,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const FallbackOriginUI = UIProvider.succeed<FallbackOrigin>(
  "Cloudflare.CustomHostname.FallbackOrigin",
  {
    displayName: "Fallback Origin",
    icon: "server",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.origin,
    facts: (ctx) => [
      { label: "origin", value: ctx.attrs?.origin, mono: true, copy: true },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ui = () => Layer.mergeAll(CustomHostnameUI, FallbackOriginUI);
