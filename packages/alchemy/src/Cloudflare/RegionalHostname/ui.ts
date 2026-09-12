import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { RegionalHostname } from "./RegionalHostname.ts";

/**
 * Dashboard UI providers for Cloudflare Regional Hostname resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const RegionalHostnameUI = UIProvider.succeed<RegionalHostname>(
  "Cloudflare.RegionalHostname.RegionalHostname",
  {
    displayName: "Regional Hostname",
    icon: "map-pin",
    color: "#F6821F",
    category: "dns",
    summary: (ctx) =>
      ctx.attrs?.hostname === undefined
        ? undefined
        : `${ctx.attrs.hostname} (${ctx.attrs.regionKey ?? "?"})`,
    facts: (ctx) => [
      { label: "hostname", value: ctx.attrs?.hostname, mono: true, copy: true },
      { label: "region", value: ctx.attrs?.regionKey, mono: true },
      { label: "routing", value: ctx.attrs?.routing },
      { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "created", value: ctx.attrs?.createdOn },
    ],
  },
);

export const ui = () => Layer.mergeAll(RegionalHostnameUI);
