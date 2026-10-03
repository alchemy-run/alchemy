import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { ref, sameId } from "./common.ts";
import { idsOf, networkProvider } from "./generic.ts";

export interface VirtualHubProps {
  /** Resource group of the hub. Changing it replaces the hub. */
  resourceGroup: string;
  /**
   * Name of the hub: 1-80 letters, digits, `_`, `.`, and `-`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the hub.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the hub.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the virtual WAN. Omit it only for an Azure Route Server hub
   * (routed through {@link VirtualHubIpConfiguration}). Changing it
   * replaces the hub.
   */
  virtualWanId?: string;
  /**
   * Hub address prefix, at least a `/24` (e.g. `"10.100.0.0/23"`).
   * Required for WAN hubs. Changing it replaces the hub.
   */
  addressPrefix?: string;
  /**
   * Hub SKU. Must match the WAN type (`Basic` hubs only in Basic WANs).
   * @default "Standard"
   */
  sku?: "Basic" | "Standard";
  /** Allow branch-to-branch traffic through the hub. */
  allowBranchToBranchTraffic?: boolean;
  /**
   * Route preference when the hub learns the same prefix from several
   * sources.
   * @default "ExpressRoute"
   */
  hubRoutingPreference?: "ExpressRoute" | "VpnGateway" | "ASPath";
  /**
   * Minimum routing infrastructure units of the hub router (2 = 3 Gbps).
   */
  minRoutingInfrastructureUnits?: number;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface VirtualHub extends Resource<
  "Azure.Network.VirtualHub",
  VirtualHubProps,
  {
    /** Name of the hub. */
    virtualHubName: string;
    /** ARM resource ID of the hub. */
    virtualHubId: string;
    /** Resource group of the hub. */
    resourceGroup: string;
    /** Location of the hub. */
    location: string;
    /** ARM ID of the virtual WAN. */
    virtualWanId: string | undefined;
    /** Hub address prefix. */
    addressPrefix: string | undefined;
    /** Hub SKU. */
    sku: string | undefined;
    /** Routing state of the hub router (`Provisioned` when ready). */
    routingState: string | undefined;
    /** BGP ASN of the hub router. */
    virtualRouterAsn: number | undefined;
    /** IP addresses of the hub router. */
    virtualRouterIps: string[];
    /** ID of the hub's site-to-site VPN gateway, if any. */
    vpnGatewayId: string | undefined;
    /** ID of the hub's point-to-site VPN gateway, if any. */
    p2sVpnGatewayId: string | undefined;
    /** ID of the hub's ExpressRoute gateway, if any. */
    expressRouteGatewayId: string | undefined;
    /** ID of the hub's Azure Firewall, if any. */
    azureFirewallId: string | undefined;
    /** IDs of the hub's BGP connections. */
    bgpConnectionIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Virtual WAN virtual hub — a Microsoft-managed hub VNet in one
 * region that VNets, VPN sites, ExpressRoute circuits, and point-to-site
 * users connect to. A Standard hub bills about $0.25/hour and takes 15-30
 * minutes to provision its router; reconcile waits until the router's
 * routing state is `Provisioned`.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/virtual-wan-about
 *
 * ### Creating a Hub
 * **Example:** Standard hub in a WAN
 * ```typescript
 * const wan = yield* Azure.Network.VirtualWan("wan", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const hub = yield* Azure.Network.VirtualHub("hub", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualWanId: wan.virtualWanId,
 *   addressPrefix: "10.100.0.0/23",
 * });
 * ```
 *
 * @resource
 */
export const VirtualHub = Resource<VirtualHub>("Azure.Network.VirtualHub");

export const VirtualHubProvider = () =>
  Provider.succeed(
    VirtualHub,
    networkProvider<VirtualHub>()({
      label: "virtual hub",
      nameAttr: "virtualHubName",
      tracked: true,
      slow: true,
      immutable: (news, output) =>
        !sameId(news.virtualWanId, output.virtualWanId) ||
        (news.addressPrefix ?? undefined) !== output.addressPrefix,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVirtualHub({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            virtualHubName: path.name,
          }),
        ),
      // The hub is usable once its router finished provisioning.
      readyState: (observed) => {
        const state = observed.properties?.provisioningState;
        if (state !== "Succeeded") return state;
        const routing = observed.properties?.routingState;
        return routing === "Provisioning"
          ? "Provisioning"
          : routing === "Failed"
            ? "Failed"
            : "Succeeded";
      },
      put: (subscriptionId, path, body) =>
        network.VirtualHubsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualHubName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteVirtualHub({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualHubName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateVirtualHubTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualHubName: path.name,
          tags,
        }),
      listAll: (subscriptionId) => network.ListVirtualHubs({ subscriptionId }),
      // Gateway / firewall references are set by those resources: carry the
      // observed references so a hub update never detaches them.
      body: (news, { location, tags, observed }) => {
        const o = observed?.properties;
        return {
          location,
          tags,
          properties: {
            virtualWan: ref(news.virtualWanId),
            addressPrefix: news.addressPrefix,
            sku: news.sku ?? "Standard",
            allowBranchToBranchTraffic: news.allowBranchToBranchTraffic,
            hubRoutingPreference: news.hubRoutingPreference ?? "ExpressRoute",
            virtualRouterAutoScaleConfiguration:
              news.minRoutingInfrastructureUnits === undefined
                ? undefined
                : { minCapacity: news.minRoutingInfrastructureUnits },
            vpnGateway: ref(o?.vpnGateway?.id),
            p2SVpnGateway: ref(o?.p2SVpnGateway?.id),
            expressRouteGateway: ref(o?.expressRouteGateway?.id),
            azureFirewall: ref(o?.azureFirewall?.id),
            securityPartnerProvider: ref(o?.securityPartnerProvider?.id),
          },
        };
      },
      toAttrs: (path, observed) => ({
        virtualHubName: path.name,
        virtualHubId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        virtualWanId: observed.properties?.virtualWan?.id,
        addressPrefix: observed.properties?.addressPrefix,
        sku: observed.properties?.sku,
        routingState: observed.properties?.routingState,
        virtualRouterAsn: observed.properties?.virtualRouterAsn,
        virtualRouterIps: [...(observed.properties?.virtualRouterIps ?? [])],
        vpnGatewayId: observed.properties?.vpnGateway?.id,
        p2sVpnGatewayId: observed.properties?.p2SVpnGateway?.id,
        expressRouteGatewayId: observed.properties?.expressRouteGateway?.id,
        azureFirewallId: observed.properties?.azureFirewall?.id,
        bgpConnectionIds: idsOf(observed.properties?.bgpConnections),
        tags: userTags(observed.tags),
      }),
      dependsOn: ["Azure.Network.VirtualWan"],
    }),
  );
