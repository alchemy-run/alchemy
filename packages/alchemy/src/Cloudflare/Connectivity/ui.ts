import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { DirectoryService } from "./DirectoryService.ts";

/**
 * Dashboard UI providers for Cloudflare Connectivity resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */

const hostLabel = (
  host: DirectoryService.HostAttributes | undefined,
): string | undefined => {
  if (host === undefined) return undefined;
  if ("hostname" in host) return host.hostname;
  const ipv4 = "ipv4" in host ? host.ipv4 : undefined;
  const ipv6 = "ipv6" in host ? host.ipv6 : undefined;
  return [ipv4, ipv6].filter((ip) => ip !== undefined).join(" / ");
};

export const DirectoryServiceUI = UIProvider.succeed<DirectoryService>(
  "Cloudflare.Connectivity.DirectoryService",
  {
    displayName: "Directory Service",
    icon: "folder-tree",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "service id",
        value: ctx.attrs?.serviceId,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.type },
      { label: "host", value: hostLabel(ctx.attrs?.host), mono: true },
      { label: "tcp port", value: ctx.attrs?.tcpPort },
      { label: "http port", value: ctx.attrs?.httpPort },
      { label: "https port", value: ctx.attrs?.httpsPort },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(DirectoryServiceUI);
