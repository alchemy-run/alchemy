import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Application } from "./Application.ts";

/**
 * Dashboard UI providers for Cloudflare Spectrum resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no SDK code reaches the dashboard bundle.
 */
export const ApplicationUI = UIProvider.succeed<Application>(
  "Cloudflare.Spectrum.Application",
  {
    displayName: "Spectrum App",
    icon: "network",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.dnsName ?? ctx.props?.dns?.name,
    facts: (ctx) => [
      { label: "hostname", value: ctx.attrs?.dnsName, copy: true },
      { label: "id", value: ctx.attrs?.appId, mono: true, copy: true },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "protocol", value: ctx.attrs?.protocol, mono: true },
      { label: "traffic type", value: ctx.attrs?.trafficType },
      {
        label: "origin",
        value:
          ctx.attrs?.originDirect?.join(", ") ?? ctx.attrs?.originDns?.name,
        mono: true,
      },
      { label: "proxy protocol", value: ctx.attrs?.proxyProtocol },
      { label: "argo smart routing", value: ctx.attrs?.argoSmartRouting },
    ],
  },
);

export const ui = () => Layer.mergeAll(ApplicationUI);
