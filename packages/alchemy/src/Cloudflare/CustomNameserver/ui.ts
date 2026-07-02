import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { CustomNameserver } from "./CustomNameserver.ts";

/**
 * Dashboard UI providers for Cloudflare Custom Nameserver resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const CustomNameserverUI = UIProvider.succeed<CustomNameserver>(
  "Cloudflare.CustomNameserver.CustomNameserver",
  {
    displayName: "Custom Nameserver",
    icon: "server",
    color: "#F6821F",
    category: "dns",
    summary: (ctx) => ctx.attrs?.nsName,
    facts: (ctx) => [
      { label: "ns name", value: ctx.attrs?.nsName, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "ns set", value: ctx.attrs?.nsSet },
      { label: "zone tag", value: ctx.attrs?.zoneTag, mono: true, copy: true },
      {
        label: "dns records",
        value: ctx.attrs?.dnsRecords?.length
          ? ctx.attrs.dnsRecords
              .map((r) => `${r?.type ?? "?"} ${r?.value ?? "?"}`)
              .join(", ")
          : undefined,
        mono: true,
      },
      {
        label: "account id",
        value: ctx.attrs?.accountId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(CustomNameserverUI);
