import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";

export interface VirtualRouterPeeringProps {
  /** Resource group of the router. Changing it replaces the peering. */
  resourceGroup: string;
  /** Name of the parent virtual router. Changing it replaces the peering. */
  virtualRouter: string;
  /**
   * Name of the peering. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the peering.
   */
  name?: string;
  /** ASN of the BGP peer (an NVA in the virtual network). */
  peerAsn: number;
  /** IP address of the BGP peer. */
  peerIp: string;
}

export interface VirtualRouterPeering extends Resource<
  "Azure.Network.VirtualRouterPeering",
  VirtualRouterPeeringProps,
  {
    /** Name of the peering. */
    peeringName: string;
    /** ARM resource ID of the peering. */
    peeringId: string;
    /** Name of the parent virtual router. */
    virtualRouter: string;
    /** Resource group of the router. */
    resourceGroup: string;
    /** ASN of the peer. */
    peerAsn: number | undefined;
    /** IP address of the peer. */
    peerIp: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A BGP peering of an Azure {@link VirtualRouter} (Route Server) with a
 * network virtual appliance. Peerings carry no tags: ownership follows the
 * parent router.
 *
 * @see https://learn.microsoft.com/azure/route-server/quickstart-configure-route-server-portal
 *
 * ### Peering with an NVA
 * **Example:** BGP peer
 * ```typescript
 * yield* Azure.Network.VirtualRouterPeering("nva", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualRouter: router.virtualRouterName,
 *   peerAsn: 65010,
 *   peerIp: "10.0.1.4",
 * });
 * ```
 *
 * @resource
 */
export const VirtualRouterPeering = Resource<VirtualRouterPeering>(
  "Azure.Network.VirtualRouterPeering",
);

export const VirtualRouterPeeringProvider = () =>
  Provider.succeed(
    VirtualRouterPeering,
    networkProvider<VirtualRouterPeering>()({
      label: "virtual router peering",
      nameAttr: "peeringName",
      parents: ["virtualRouter"],
      tracked: false,
      slow: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVirtualRouterPeering({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            virtualRouterName: path.virtualRouter!,
            peeringName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.VirtualRouterPeeringsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualRouterName: path.virtualRouter!,
          peeringName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteVirtualRouterPeering({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualRouterName: path.virtualRouter!,
          peeringName: path.name,
        }),
      ownerTags: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVirtualRouter({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            virtualRouterName: path.virtualRouter!,
          }),
        ).pipe(Effect.map((router) => router?.tags)),
      body: (news) => ({
        properties: { peerAsn: news.peerAsn, peerIp: news.peerIp },
      }),
      toAttrs: (path, observed) => ({
        peeringName: path.name,
        peeringId: observed.id ?? "",
        virtualRouter: path.virtualRouter!,
        resourceGroup: path.resourceGroup,
        peerAsn: observed.properties?.peerAsn,
        peerIp: observed.properties?.peerIp,
      }),
      dependsOn: ["Azure.Network.VirtualRouter"],
    }),
  );
