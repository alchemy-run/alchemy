import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { VpcService } from "./VpcService.ts";

/**
 * Dashboard UI providers for Cloudflare VPC Service resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */

const hostLabel = (host: VpcService.Host | undefined): string | undefined => {
  if (host === undefined) return undefined;
  if ("hostname" in host) return host.hostname;
  const ipv4 = "ipv4" in host ? host.ipv4 : undefined;
  const ipv6 = "ipv6" in host ? host.ipv6 : undefined;
  return [ipv4, ipv6].filter((ip) => ip !== undefined).join(" / ");
};

export const VpcServiceUI = UIProvider.succeed<VpcService>(
  "Cloudflare.VpcService.VpcService",
  {
    displayName: "VPC Service",
    icon: "server",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.serviceName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.serviceName, copy: true },
      {
        label: "service id",
        value: ctx.attrs?.serviceId,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.serviceType },
      { label: "host", value: hostLabel(ctx.attrs?.host), mono: true },
      { label: "http port", value: ctx.attrs?.httpPort },
      { label: "https port", value: ctx.attrs?.httpsPort },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(VpcServiceUI);
