import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Hostname } from "./Hostname.ts";

/**
 * Dashboard UI providers for Cloudflare Web3 resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const HostnameUI = UIProvider.succeed<Hostname>(
  "Cloudflare.Web3.Hostname",
  {
    displayName: "Web3 Hostname",
    icon: "link",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
    link: (ctx) => (ctx.attrs?.name ? `https://${ctx.attrs.name}` : undefined),
    facts: (ctx) => [
      { label: "hostname", value: ctx.attrs?.name, copy: true },
      {
        label: "hostname id",
        value: ctx.attrs?.hostnameId,
        mono: true,
        copy: true,
      },
      { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "target", value: ctx.attrs?.target },
      { label: "status", value: ctx.attrs?.status },
      { label: "dnslink", value: ctx.attrs?.dnslink, mono: true },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const ui = () => Layer.mergeAll(HostnameUI);
