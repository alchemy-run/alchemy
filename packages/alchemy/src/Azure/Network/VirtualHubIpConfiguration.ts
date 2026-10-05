import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { ref, sameId } from "./common.ts";
import { networkProvider } from "./generic.ts";
import { hubOwnerTags } from "./virtualHubShared.ts";

export interface VirtualHubIpConfigurationProps {
  /** Resource group of the virtual hub. Changing it replaces the configuration. */
  resourceGroup: string;
  /** Name of the parent virtual hub. Changing it replaces the configuration. */
  virtualHub: string;
  /**
   * Name of the IP configuration. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the
   * configuration.
   */
  name?: string;
  /**
   * ARM ID of the subnet hosting the hub router (a `RouteServerSubnet` of
   * at least `/27`). Changing it replaces the configuration.
   */
  subnetId: string;
  /**
   * Static private IP address in the subnet; dynamic when omitted.
   * Changing it replaces the configuration.
   */
  privateIpAddress?: string;
  /**
   * ARM ID of a Standard public IP for the router. Changing it replaces
   * the configuration.
   */
  publicIpAddressId?: string;
}

export interface VirtualHubIpConfiguration extends Resource<
  "Azure.Network.VirtualHubIpConfiguration",
  VirtualHubIpConfigurationProps,
  {
    /** Name of the IP configuration. */
    ipConfigurationName: string;
    /** ARM resource ID of the IP configuration. */
    ipConfigurationId: string;
    /** Name of the parent virtual hub. */
    virtualHub: string;
    /** Resource group of the virtual hub. */
    resourceGroup: string;
    /** ARM ID of the subnet. */
    subnetId: string | undefined;
    /** Private IP address of the router instance. */
    privateIpAddress: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An IP configuration of a virtual hub — places the hub's router in a
 * subnet. This is how Azure Route Server is deployed on the virtual hub
 * API (`sku: "Standard"` hub without a virtual WAN). IP configurations
 * carry no tags: ownership follows the parent hub.
 *
 * @see https://learn.microsoft.com/azure/route-server/overview
 *
 * ### Creating an IP Configuration
 * **Example:** Route Server router in a RouteServerSubnet
 * ```typescript
 * yield* Azure.Network.VirtualHubIpConfiguration("router", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualHub: hub.virtualHubName,
 *   subnetId: routeServerSubnet.subnetId,
 *   publicIpAddressId: ip.publicIpAddressId,
 * });
 * ```
 *
 * @resource
 */
export const VirtualHubIpConfiguration = Resource<VirtualHubIpConfiguration>(
  "Azure.Network.VirtualHubIpConfiguration",
);

export const VirtualHubIpConfigurationProvider = () =>
  Provider.succeed(
    VirtualHubIpConfiguration,
    networkProvider<VirtualHubIpConfiguration>()({
      label: "virtual hub IP configuration",
      nameAttr: "ipConfigurationName",
      parents: ["virtualHub"],
      tracked: false,
      slow: true,
      deleteFirst: true,
      immutable: (news, output) =>
        output.subnetId !== undefined && !sameId(news.subnetId, output.subnetId),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVirtualHubIpConfiguration({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            virtualHubName: path.virtualHub!,
            ipConfigName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.VirtualHubIpConfigurationCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualHubName: path.virtualHub!,
          ipConfigName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteVirtualHubIpConfiguration({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualHubName: path.virtualHub!,
          ipConfigName: path.name,
        }),
      ownerTags: hubOwnerTags,
      body: (news) => ({
        properties: {
          subnet: { id: news.subnetId },
          privateIPAddress: news.privateIpAddress,
          privateIPAllocationMethod:
            news.privateIpAddress === undefined ? "Dynamic" : "Static",
          publicIPAddress: ref(news.publicIpAddressId),
        },
      }),
      // Every field is immutable once created.
      drifted: () => false,
      toAttrs: (path, observed) => ({
        ipConfigurationName: path.name,
        ipConfigurationId: observed.id ?? "",
        virtualHub: path.virtualHub!,
        resourceGroup: path.resourceGroup,
        subnetId: observed.properties?.subnet?.id,
        privateIpAddress: observed.properties?.privateIPAddress,
      }),
      dependsOn: ["Azure.Network.VirtualHub", "Azure.Network.Subnet"],
    }),
  );
