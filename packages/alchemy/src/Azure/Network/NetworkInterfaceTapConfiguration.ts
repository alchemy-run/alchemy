import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";
import * as Effect from "effect/Effect";

export interface NetworkInterfaceTapConfigurationProps {
  /** Resource group of the network interface. Changing it replaces the NIC TAP configuration. */
  resourceGroup: string;
  /** Name of the parent network interface. Changing it replaces the NIC TAP configuration. */
  networkInterface: string;
  /**
   * Name of the NIC TAP configuration. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the NIC TAP configuration.
   */
  name?: string;
  /** ARM ID of the virtual network TAP the NIC mirrors into. */
  virtualNetworkTapId: string;
}

export interface NetworkInterfaceTapConfiguration extends Resource<
  "Azure.Network.NetworkInterfaceTapConfiguration",
  NetworkInterfaceTapConfigurationProps,
  {
    /** Name of the NIC TAP configuration. */
    tapConfigurationName: string;
    /** ARM resource ID of the NIC TAP configuration. */
    tapConfigurationId: string;
    /** Name of the parent network interface. */
    networkInterface: string;
    /** Resource group of the network interface. */
    resourceGroup: string;
    /** ARM ID of the virtual network TAP. */
    virtualNetworkTapId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A TAP configuration on an Azure network interface — mirrors the NIC's
 * traffic into a {@link VirtualNetworkTap}. Virtual network TAP is a
 * preview feature. It carries no tags: ownership follows the network
 * interface.
 *
 * @see https://learn.microsoft.com/azure/virtual-network/tutorial-tap-virtual-network-cli
 *
 * ### Mirroring a NIC
 * **Example:** Mirror a VM's NIC
 * ```typescript
 * yield* Azure.Network.NetworkInterfaceTapConfiguration("mirror", {
 *   resourceGroup: group.resourceGroupName,
 *   networkInterface: nic.networkInterfaceName,
 *   virtualNetworkTapId: tap.tapId,
 * });
 * ```
 *
 * @resource
 */
export const NetworkInterfaceTapConfiguration =
  Resource<NetworkInterfaceTapConfiguration>(
    "Azure.Network.NetworkInterfaceTapConfiguration",
  );

export const NetworkInterfaceTapConfigurationProvider = () =>
  Provider.succeed(
    NetworkInterfaceTapConfiguration,
    networkProvider<NetworkInterfaceTapConfiguration>()({
      label: "NIC TAP configuration",
      nameAttr: "tapConfigurationName",
      parents: ["networkInterface"],
      tracked: false,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNetworkInterfaceTapConfiguration({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkInterfaceName: path.networkInterface!,
            tapConfigurationName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.NetworkInterfaceTapConfigurationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkInterfaceName: path.networkInterface!,
          tapConfigurationName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteNetworkInterfaceTapConfiguration({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkInterfaceName: path.networkInterface!,
          tapConfigurationName: path.name,
        }),
      ownerTags: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNetworkInterface({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkInterfaceName: path.networkInterface!,
          }),
        ).pipe(Effect.map((nic) => nic?.tags)),
      body: (news) => ({
        properties: { virtualNetworkTap: { id: news.virtualNetworkTapId } },
      }),
      drifted: (observed, _body, news) =>
        observed.properties?.virtualNetworkTap?.id?.toLowerCase() !==
        news.virtualNetworkTapId.toLowerCase(),
      toAttrs: (path, observed) => ({
        tapConfigurationName: path.name,
        tapConfigurationId: observed.id ?? "",
        networkInterface: path.networkInterface!,
        resourceGroup: path.resourceGroup,
        virtualNetworkTapId: observed.properties?.virtualNetworkTap?.id,
      }),
      dependsOn: [
        "Azure.Network.NetworkInterface",
        "Azure.Network.VirtualNetworkTap",
      ],
    }),
  );
