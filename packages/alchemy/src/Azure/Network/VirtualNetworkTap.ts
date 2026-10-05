import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { ref } from "./common.ts";
import { idsOf, networkProvider } from "./generic.ts";

export interface VirtualNetworkTapProps {
  /** Resource group of the virtual network TAP. Changing it replaces the virtual network TAP. */
  resourceGroup: string;
  /**
   * Name of the virtual network TAP: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the virtual network TAP.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the virtual network TAP.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the collector NIC IP configuration that receives mirrored
   * traffic. Set this or `destinationLoadBalancerFrontendIpConfigurationId`.
   */
  destinationNetworkInterfaceIpConfigurationId?: string;
  /** ARM ID of the collector internal load balancer frontend. */
  destinationLoadBalancerFrontendIpConfigurationId?: string;
  /** VXLAN port on the collector (Azure accepts only 4789). @default 4789 */
  destinationPort?: number;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface VirtualNetworkTap extends Resource<
  "Azure.Network.VirtualNetworkTap",
  VirtualNetworkTapProps,
  {
    /** Name of the virtual network TAP. */
    tapName: string;
    /** ARM resource ID of the virtual network TAP. */
    tapId: string;
    /** Resource group of the virtual network TAP. */
    resourceGroup: string;
    /** Location of the virtual network TAP. */
    location: string;
    /** IDs of the NIC TAP configurations mirroring into this TAP. */
    networkInterfaceTapConfigurationIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure virtual network TAP — continuously mirrors VM network traffic
 * (via {@link NetworkInterfaceTapConfiguration}s) to a collector NIC or
 * internal load balancer as VXLAN. Virtual network TAP is a preview
 * feature available in limited regions.
 *
 * @see https://learn.microsoft.com/azure/virtual-network/virtual-network-tap-overview
 *
 * ### Creating a TAP
 * **Example:** Mirror to a collector NIC
 * ```typescript
 * const tap = yield* Azure.Network.VirtualNetworkTap("mirror", {
 *   resourceGroup: group.resourceGroupName,
 *   destinationNetworkInterfaceIpConfigurationId: `${collector.networkInterfaceId}/ipConfigurations/primary`,
 * });
 * ```
 *
 * @resource
 */
export const VirtualNetworkTap = Resource<VirtualNetworkTap>(
  "Azure.Network.VirtualNetworkTap",
);

export const VirtualNetworkTapProvider = () =>
  Provider.succeed(
    VirtualNetworkTap,
    networkProvider<VirtualNetworkTap>()({
      label: "virtual network TAP",
      nameAttr: "tapName",
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVirtualNetworkTap({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            tapName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.VirtualNetworkTapsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          tapName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteVirtualNetworkTap({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          tapName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateVirtualNetworkTapTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          tapName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListVirtualNetworkTapAll({ subscriptionId }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          destinationNetworkInterfaceIPConfiguration: ref(
            news.destinationNetworkInterfaceIpConfigurationId,
          ),
          destinationLoadBalancerFrontEndIPConfiguration: ref(
            news.destinationLoadBalancerFrontendIpConfigurationId,
          ),
          destinationPort: news.destinationPort ?? 4789,
        },
      }),
      toAttrs: (path, observed) => ({
        tapName: path.name,
        tapId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        networkInterfaceTapConfigurationIds: idsOf(
          observed.properties?.networkInterfaceTapConfigurations,
        ),
        tags: userTags(observed.tags),
      }),
    }),
  );
