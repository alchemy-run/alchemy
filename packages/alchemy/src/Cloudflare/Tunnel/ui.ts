import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Configuration } from "./Configuration.ts";
import type { HostnameRoute } from "./HostnameRoute.ts";
import type { Route } from "./Route.ts";
import type { Tunnel } from "./Tunnel.ts";
import type { VirtualNetwork } from "./VirtualNetwork.ts";
import type { WarpConnector } from "./WarpConnector.ts";

/**
 * Dashboard UI providers for Cloudflare Tunnel resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const TunnelUI = UIProvider.succeed<Tunnel>("Cloudflare.Tunnel.Tunnel", {
  displayName: "Tunnel",
  icon: "waypoints",
  color: "#F6821F",
  category: "network",
  summary: (ctx) => ctx.attrs?.tunnelName,
  consoleUrl: (ctx) =>
    ctx.attrs?.accountId === undefined
      ? undefined
      : `https://one.dash.cloudflare.com/${ctx.attrs.accountId}/networks/tunnels`,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.tunnelName, copy: true },
    { label: "tunnel id", value: ctx.attrs?.tunnelId, mono: true, copy: true },
    { label: "account", value: ctx.attrs?.accountId, mono: true },
    { label: "config source", value: ctx.attrs?.configSrc },
    { label: "created", value: ctx.attrs?.createdAt },
  ],
});

export const RouteUI = UIProvider.succeed<Route>("Cloudflare.Tunnel.Route", {
  displayName: "Tunnel Route",
  icon: "route",
  color: "#F6821F",
  category: "network",
  summary: (ctx) => ctx.attrs?.network ?? ctx.props?.network,
  facts: (ctx) => [
    { label: "network", value: ctx.attrs?.network, mono: true, copy: true },
    { label: "route id", value: ctx.attrs?.routeId, mono: true, copy: true },
    { label: "tunnel id", value: ctx.attrs?.tunnelId, mono: true },
    {
      label: "virtual network",
      value: ctx.attrs?.virtualNetworkId,
      mono: true,
    },
    { label: "comment", value: ctx.attrs?.comment },
    { label: "created", value: ctx.attrs?.createdAt },
  ],
});

export const HostnameRouteUI = UIProvider.succeed<HostnameRoute>(
  "Cloudflare.Tunnel.HostnameRoute",
  {
    displayName: "Tunnel Hostname Route",
    icon: "signpost",
    color: "#F6821F",
    category: "dns",
    summary: (ctx) => ctx.attrs?.hostname ?? ctx.props?.hostname,
    facts: (ctx) => [
      { label: "hostname", value: ctx.attrs?.hostname, copy: true },
      {
        label: "route id",
        value: ctx.attrs?.hostnameRouteId,
        mono: true,
        copy: true,
      },
      { label: "tunnel id", value: ctx.attrs?.tunnelId, mono: true },
      { label: "comment", value: ctx.attrs?.comment },
      { label: "created", value: ctx.attrs?.createdAt },
    ],
  },
);

export const VirtualNetworkUI = UIProvider.succeed<VirtualNetwork>(
  "Cloudflare.Tunnel.VirtualNetwork",
  {
    displayName: "Tunnel Virtual Network",
    icon: "network",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "virtual network id",
        value: ctx.attrs?.virtualNetworkId,
        mono: true,
        copy: true,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
      { label: "default network", value: ctx.attrs?.isDefaultNetwork },
      { label: "comment", value: ctx.attrs?.comment },
      { label: "created", value: ctx.attrs?.createdAt },
    ],
  },
);

export const WarpConnectorUI = UIProvider.succeed<WarpConnector>(
  "Cloudflare.Tunnel.WarpConnector",
  {
    displayName: "WARP Connector",
    icon: "plug-zap",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "tunnel id",
        value: ctx.attrs?.tunnelId,
        mono: true,
        copy: true,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "created", value: ctx.attrs?.createdAt },
    ],
  },
);

export const ConfigurationUI = UIProvider.succeed<Configuration>(
  "Cloudflare.Tunnel.Configuration",
  {
    displayName: "Tunnel Configuration",
    icon: "settings-2",
    color: "#F6821F",
    category: "config",
    summary: (ctx) => ctx.attrs?.tunnelId,
    facts: (ctx) => [
      {
        label: "tunnel id",
        value: ctx.attrs?.tunnelId,
        mono: true,
        copy: true,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
      { label: "version", value: ctx.attrs?.version },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    TunnelUI,
    RouteUI,
    HostnameRouteUI,
    VirtualNetworkUI,
    WarpConnectorUI,
    ConfigurationUI,
  );
