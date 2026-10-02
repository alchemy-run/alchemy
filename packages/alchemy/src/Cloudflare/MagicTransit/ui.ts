import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { MagicApp } from "./App.ts";
import type { GreTunnel } from "./GreTunnel.ts";
import type { IpsecTunnel } from "./IpsecTunnel.ts";
import type { MagicSite } from "./Site.ts";
import type { MagicSiteAcl } from "./SiteAcl.ts";
import type { MagicSiteLan } from "./SiteLan.ts";
import type { MagicSiteWan } from "./SiteWan.ts";
import type { MagicStaticRoute } from "./StaticRoute.ts";

/**
 * Dashboard UI providers for Cloudflare MagicTransit resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const MagicAppUI = UIProvider.succeed<MagicApp>(
  "Cloudflare.MagicTransit.App",
  {
    displayName: "Magic App",
    icon: "app-window",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
    facts: (ctx) => [
      { label: "app id", value: ctx.attrs?.appId, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name ?? ctx.props?.name },
      { label: "type", value: ctx.attrs?.type ?? ctx.props?.type },
      {
        label: "hostnames",
        value: ctx.attrs?.hostnames?.length
          ? ctx.attrs.hostnames.join(", ")
          : undefined,
        mono: true,
      },
      {
        label: "ip subnets",
        value: ctx.attrs?.ipSubnets?.length
          ? ctx.attrs.ipSubnets.join(", ")
          : undefined,
        mono: true,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
    ],
  },
);

export const MagicSiteUI = UIProvider.succeed<MagicSite>(
  "Cloudflare.MagicTransit.Site",
  {
    displayName: "Magic Site",
    icon: "map-pin",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
    facts: (ctx) => [
      { label: "site id", value: ctx.attrs?.siteId, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name ?? ctx.props?.name },
      { label: "description", value: ctx.attrs?.description },
      {
        label: "connector",
        value: ctx.attrs?.connectorId,
        mono: true,
        copy: true,
      },
      {
        label: "secondary connector",
        value: ctx.attrs?.secondaryConnectorId,
        mono: true,
        copy: true,
      },
      { label: "ha mode", value: ctx.attrs?.haMode },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
    ],
  },
);

export const MagicSiteLanUI = UIProvider.succeed<MagicSiteLan>(
  "Cloudflare.MagicTransit.SiteLan",
  {
    displayName: "Magic Site LAN",
    icon: "network",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
    facts: (ctx) => [
      { label: "lan id", value: ctx.attrs?.lanId, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name ?? ctx.props?.name },
      { label: "site", value: ctx.attrs?.siteId, mono: true, copy: true },
      {
        label: "physport",
        value: ctx.attrs?.physport ?? ctx.props?.physport,
        mono: true,
      },
      { label: "vlan tag", value: ctx.attrs?.vlanTag, mono: true },
      { label: "ha link", value: ctx.attrs?.haLink },
    ],
  },
);

export const MagicSiteWanUI = UIProvider.succeed<MagicSiteWan>(
  "Cloudflare.MagicTransit.SiteWan",
  {
    displayName: "Magic Site WAN",
    icon: "cable",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
    facts: (ctx) => [
      { label: "wan id", value: ctx.attrs?.wanId, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name ?? ctx.props?.name },
      { label: "site", value: ctx.attrs?.siteId, mono: true, copy: true },
      {
        label: "physport",
        value: ctx.attrs?.physport ?? ctx.props?.physport,
        mono: true,
      },
      { label: "priority", value: ctx.attrs?.priority },
      { label: "vlan tag", value: ctx.attrs?.vlanTag, mono: true },
      { label: "health check rate", value: ctx.attrs?.healthCheckRate },
    ],
  },
);

export const MagicSiteAclUI = UIProvider.succeed<MagicSiteAcl>(
  "Cloudflare.MagicTransit.SiteAcl",
  {
    displayName: "Magic Site ACL",
    icon: "shield",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
    facts: (ctx) => [
      { label: "acl id", value: ctx.attrs?.aclId, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name ?? ctx.props?.name },
      { label: "site", value: ctx.attrs?.siteId, mono: true, copy: true },
      {
        label: "protocols",
        value: ctx.attrs?.protocols?.length
          ? ctx.attrs.protocols.join(", ")
          : undefined,
        mono: true,
      },
      { label: "forward locally", value: ctx.attrs?.forwardLocally },
      { label: "unidirectional", value: ctx.attrs?.unidirectional },
    ],
  },
);

export const MagicStaticRouteUI = UIProvider.succeed<MagicStaticRoute>(
  "Cloudflare.MagicTransit.StaticRoute",
  {
    displayName: "Magic Static Route",
    icon: "route",
    color: "#F6821F",
    category: "network",
    summary: (ctx) =>
      ctx.attrs?.prefix !== undefined && ctx.attrs?.nexthop !== undefined
        ? `${ctx.attrs.prefix} → ${ctx.attrs.nexthop}`
        : (ctx.attrs?.prefix ?? ctx.props?.prefix),
    facts: (ctx) => [
      { label: "route id", value: ctx.attrs?.routeId, mono: true, copy: true },
      {
        label: "prefix",
        value: ctx.attrs?.prefix ?? ctx.props?.prefix,
        mono: true,
        copy: true,
      },
      {
        label: "nexthop",
        value: ctx.attrs?.nexthop ?? ctx.props?.nexthop,
        mono: true,
        copy: true,
      },
      { label: "priority", value: ctx.attrs?.priority },
      { label: "weight", value: ctx.attrs?.weight },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const GreTunnelUI = UIProvider.succeed<GreTunnel>(
  "Cloudflare.MagicTransit.GreTunnel",
  {
    displayName: "Magic GRE Tunnel",
    icon: "waypoints",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
    facts: (ctx) => [
      {
        label: "tunnel id",
        value: ctx.attrs?.tunnelId,
        mono: true,
        copy: true,
      },
      { label: "name", value: ctx.attrs?.name ?? ctx.props?.name },
      {
        label: "cloudflare endpoint",
        value:
          ctx.attrs?.cloudflareGreEndpoint ?? ctx.props?.cloudflareGreEndpoint,
        mono: true,
        copy: true,
      },
      {
        label: "customer endpoint",
        value: ctx.attrs?.customerGreEndpoint ?? ctx.props?.customerGreEndpoint,
        mono: true,
        copy: true,
      },
      {
        label: "interface address",
        value: ctx.attrs?.interfaceAddress ?? ctx.props?.interfaceAddress,
        mono: true,
      },
      { label: "ttl", value: ctx.attrs?.ttl },
      { label: "mtu", value: ctx.attrs?.mtu },
    ],
  },
);

export const IpsecTunnelUI = UIProvider.succeed<IpsecTunnel>(
  "Cloudflare.MagicTransit.IpsecTunnel",
  {
    displayName: "Magic IPsec Tunnel",
    icon: "lock",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
    facts: (ctx) => [
      {
        label: "tunnel id",
        value: ctx.attrs?.tunnelId,
        mono: true,
        copy: true,
      },
      { label: "name", value: ctx.attrs?.name ?? ctx.props?.name },
      {
        label: "cloudflare endpoint",
        value: ctx.attrs?.cloudflareEndpoint ?? ctx.props?.cloudflareEndpoint,
        mono: true,
        copy: true,
      },
      {
        label: "customer endpoint",
        value: ctx.attrs?.customerEndpoint ?? ctx.props?.customerEndpoint,
        mono: true,
        copy: true,
      },
      {
        label: "interface address",
        value: ctx.attrs?.interfaceAddress ?? ctx.props?.interfaceAddress,
        mono: true,
      },
      { label: "replay protection", value: ctx.attrs?.replayProtection },
      { label: "null cipher", value: ctx.attrs?.allowNullCipher },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    MagicAppUI,
    MagicSiteUI,
    MagicSiteLanUI,
    MagicSiteWanUI,
    MagicSiteAclUI,
    MagicStaticRouteUI,
    GreTunnelUI,
    IpsecTunnelUI,
  );
