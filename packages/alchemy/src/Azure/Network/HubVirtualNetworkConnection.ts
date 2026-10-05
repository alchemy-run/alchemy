import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameId } from "./common.ts";
import { networkProvider } from "./generic.ts";
import {
  hubOwnerTags,
  routingConfigurationInput,
  type HubRoutingConfiguration,
} from "./virtualHubShared.ts";

export interface HubVirtualNetworkConnectionProps {
  /** Resource group of the virtual hub. Changing it replaces the connection. */
  resourceGroup: string;
  /** Name of the parent virtual hub. Changing it replaces the connection. */
  virtualHub: string;
  /**
   * Name of the connection. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the connection.
   */
  name?: string;
  /**
   * ARM ID of the spoke virtual network. The VNet must not have its own
   * virtual network gateway. Changing it replaces the connection.
   */
  remoteVirtualNetworkId: string;
  /**
   * Route the spoke's internet traffic through the hub's secured edge
   * (firewall or security partner).
   * @default false
   */
  enableInternetSecurity?: boolean;
  /**
   * Allow transit from the hub to the spoke.
   * @default true
   */
  allowHubToRemoteVnetTransit?: boolean;
  /**
   * Let the spoke use the hub's VPN / ExpressRoute gateways.
   * @default true
   */
  allowRemoteVnetToUseHubVnetGateways?: boolean;
  /** Route-table association, propagation, and static routes. */
  routing?: HubRoutingConfiguration;
}

export interface HubVirtualNetworkConnection extends Resource<
  "Azure.Network.HubVirtualNetworkConnection",
  HubVirtualNetworkConnectionProps,
  {
    /** Name of the connection. */
    connectionName: string;
    /** ARM resource ID of the connection. */
    connectionId: string;
    /** Name of the parent virtual hub. */
    virtualHub: string;
    /** Resource group of the virtual hub. */
    resourceGroup: string;
    /** ARM ID of the spoke virtual network. */
    remoteVirtualNetworkId: string | undefined;
    /** Whether internet security is enabled. */
    enableInternetSecurity: boolean | undefined;
    /** ARM ID of the associated hub route table. */
    associatedRouteTableId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A connection between an Azure Virtual WAN hub and a spoke virtual
 * network. Requires a Standard hub; the connection itself is billed per
 * hour (about $0.05/hour) plus data processing. Connections carry no tags:
 * ownership follows the parent hub.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/virtual-wan-site-to-site-portal#vnet
 *
 * ### Connecting a VNet
 * **Example:** Spoke VNet with default routing
 * ```typescript
 * yield* Azure.Network.HubVirtualNetworkConnection("spoke", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualHub: hub.virtualHubName,
 *   remoteVirtualNetworkId: spoke.virtualNetworkId,
 * });
 * ```
 *
 * **Example:** Associate with a custom route table
 * ```typescript
 * yield* Azure.Network.HubVirtualNetworkConnection("spoke", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualHub: hub.virtualHubName,
 *   remoteVirtualNetworkId: spoke.virtualNetworkId,
 *   routing: {
 *     associatedRouteTableId: table.routeTableId,
 *     propagatedLabels: ["default"],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const HubVirtualNetworkConnection =
  Resource<HubVirtualNetworkConnection>(
    "Azure.Network.HubVirtualNetworkConnection",
  );

export const HubVirtualNetworkConnectionProvider = () =>
  Provider.succeed(
    HubVirtualNetworkConnection,
    networkProvider<HubVirtualNetworkConnection>()({
      label: "hub virtual network connection",
      nameAttr: "connectionName",
      parents: ["virtualHub"],
      tracked: false,
      slow: true,
      immutable: (news, output) =>
        output.remoteVirtualNetworkId !== undefined &&
        !sameId(news.remoteVirtualNetworkId, output.remoteVirtualNetworkId),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetHubVirtualNetworkConnection({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            virtualHubName: path.virtualHub!,
            connectionName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.HubVirtualNetworkConnectionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualHubName: path.virtualHub!,
          connectionName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteHubVirtualNetworkConnection({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualHubName: path.virtualHub!,
          connectionName: path.name,
        }),
      ownerTags: hubOwnerTags,
      body: (news) => ({
        properties: {
          remoteVirtualNetwork: { id: news.remoteVirtualNetworkId },
          enableInternetSecurity: news.enableInternetSecurity ?? false,
          allowHubToRemoteVnetTransit: news.allowHubToRemoteVnetTransit ?? true,
          allowRemoteVnetToUseHubVnetGateways:
            news.allowRemoteVnetToUseHubVnetGateways ?? true,
          routingConfiguration: routingConfigurationInput(news.routing),
        },
      }),
      toAttrs: (path, observed) => ({
        connectionName: path.name,
        connectionId: observed.id ?? "",
        virtualHub: path.virtualHub!,
        resourceGroup: path.resourceGroup,
        remoteVirtualNetworkId: observed.properties?.remoteVirtualNetwork?.id,
        enableInternetSecurity: observed.properties?.enableInternetSecurity,
        associatedRouteTableId:
          observed.properties?.routingConfiguration?.associatedRouteTable?.id,
      }),
      dependsOn: ["Azure.Network.VirtualHub", "Azure.Network.VirtualNetwork"],
    }),
  );
