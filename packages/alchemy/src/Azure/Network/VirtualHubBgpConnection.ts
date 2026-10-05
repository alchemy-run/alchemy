import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { ref, sameId } from "./common.ts";
import { networkProvider } from "./generic.ts";
import { hubOwnerTags } from "./virtualHubShared.ts";

export interface VirtualHubBgpConnectionProps {
  /** Resource group of the virtual hub. Changing it replaces the peering. */
  resourceGroup: string;
  /** Name of the parent virtual hub. Changing it replaces the peering. */
  virtualHub: string;
  /**
   * Name of the BGP connection. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the peering.
   */
  name?: string;
  /**
   * ASN of the BGP peer (an NVA in a connected spoke VNet). Azure cannot
   * update it in place: changing it replaces the peering.
   */
  peerAsn: number;
  /** IP address of the BGP peer. */
  peerIp: string;
  /**
   * ARM ID of the hub VNet connection of the spoke hosting the peer.
   * Changing it replaces the peering.
   */
  hubVirtualNetworkConnectionId: string;
}

export interface VirtualHubBgpConnection extends Resource<
  "Azure.Network.VirtualHubBgpConnection",
  VirtualHubBgpConnectionProps,
  {
    /** Name of the BGP connection. */
    connectionName: string;
    /** ARM resource ID of the BGP connection. */
    connectionId: string;
    /** Name of the parent virtual hub. */
    virtualHub: string;
    /** Resource group of the virtual hub. */
    resourceGroup: string;
    /** ASN of the peer. */
    peerAsn: number | undefined;
    /** IP address of the peer. */
    peerIp: string | undefined;
    /** ARM ID of the hub VNet connection. */
    hubVirtualNetworkConnectionId: string | undefined;
    /** BGP session state (`Connected` once the peer is up). */
    connectionState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A BGP peering between an Azure Virtual WAN hub router and a network
 * virtual appliance in a connected spoke VNet. Requires a Standard hub.
 * BGP connections carry no tags: ownership follows the parent hub.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/scenario-bgp-peering-hub
 *
 * ### Peering with an NVA
 * **Example:** BGP peer in a spoke
 * ```typescript
 * yield* Azure.Network.VirtualHubBgpConnection("nva", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualHub: hub.virtualHubName,
 *   peerAsn: 65010,
 *   peerIp: "10.1.0.4",
 *   hubVirtualNetworkConnectionId: spokeConnection.connectionId,
 * });
 * ```
 *
 * @resource
 */
export const VirtualHubBgpConnection = Resource<VirtualHubBgpConnection>(
  "Azure.Network.VirtualHubBgpConnection",
);

export const VirtualHubBgpConnectionProvider = () =>
  Provider.succeed(
    VirtualHubBgpConnection,
    networkProvider<VirtualHubBgpConnection>()({
      label: "virtual hub BGP connection",
      nameAttr: "connectionName",
      parents: ["virtualHub"],
      tracked: false,
      slow: true,
      // The old session is removed first: Azure peers one session per
      // peer IP on a hub.
      deleteFirst: true,
      immutable: (news, output) =>
        (output.peerAsn !== undefined && news.peerAsn !== output.peerAsn) ||
        (output.hubVirtualNetworkConnectionId !== undefined &&
          !sameId(
            news.hubVirtualNetworkConnectionId,
            output.hubVirtualNetworkConnectionId,
          )),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVirtualHubBgpConnection({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            virtualHubName: path.virtualHub!,
            connectionName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.VirtualHubBgpConnectionCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualHubName: path.virtualHub!,
          connectionName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteVirtualHubBgpConnection({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualHubName: path.virtualHub!,
          connectionName: path.name,
        }),
      ownerTags: hubOwnerTags,
      body: (news) => ({
        properties: {
          peerAsn: news.peerAsn,
          peerIp: news.peerIp,
          hubVirtualNetworkConnection: ref(news.hubVirtualNetworkConnectionId),
        },
      }),
      toAttrs: (path, observed) => ({
        connectionName: path.name,
        connectionId: observed.id ?? "",
        virtualHub: path.virtualHub!,
        resourceGroup: path.resourceGroup,
        peerAsn: observed.properties?.peerAsn,
        peerIp: observed.properties?.peerIp,
        hubVirtualNetworkConnectionId:
          observed.properties?.hubVirtualNetworkConnection?.id,
        connectionState: observed.properties?.connectionState,
      }),
      dependsOn: [
        "Azure.Network.VirtualHub",
        "Azure.Network.HubVirtualNetworkConnection",
      ],
    }),
  );
