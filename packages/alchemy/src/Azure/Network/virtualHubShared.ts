import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import { orUndefinedIfNotFound } from "../Arm.ts";
import { ref } from "./common.ts";
import type { NetworkPath } from "./generic.ts";

// Shared Virtual WAN hub helpers. Internal: not exported from index.ts.

/** Tags of the parent virtual hub (ownership of tagless hub children). */
export const hubOwnerTags = (subscriptionId: string, path: NetworkPath) =>
  orUndefinedIfNotFound(
    network.GetVirtualHub({
      subscriptionId,
      resourceGroupName: path.resourceGroup,
      virtualHubName: path.virtualHub!,
    }),
  ).pipe(Effect.map((hub) => hub?.tags));

/** A static route a hub connection installs toward an NVA in the spoke. */
export interface HubStaticRoute {
  /** Name of the route. */
  name: string;
  /** Destination prefixes. */
  addressPrefixes: string[];
  /** Next-hop IP address in the connected VNet. */
  nextHopIpAddress: string;
}

/** Routing of a Virtual WAN connection (association and propagation). */
export interface HubRoutingConfiguration {
  /** ARM ID of the hub route table the connection is associated with. */
  associatedRouteTableId?: string;
  /** ARM IDs of the hub route tables the connection propagates to. */
  propagatedRouteTableIds?: string[];
  /** Route table labels the connection propagates to. */
  propagatedLabels?: string[];
  /** Static routes toward the connected network. */
  staticRoutes?: HubStaticRoute[];
  /** ARM ID of the route map applied to inbound routes. */
  inboundRouteMapId?: string;
  /** ARM ID of the route map applied to outbound routes. */
  outboundRouteMapId?: string;
}

/** Encode a routing configuration as PUT input (`undefined` when unset). */
export const routingConfigurationInput = (
  config: HubRoutingConfiguration | undefined,
) =>
  config && {
    associatedRouteTable: ref(config.associatedRouteTableId),
    propagatedRouteTables:
      config.propagatedRouteTableIds !== undefined ||
      config.propagatedLabels !== undefined
        ? {
            ids: config.propagatedRouteTableIds?.map((id) => ({ id })),
            labels: config.propagatedLabels,
          }
        : undefined,
    vnetRoutes:
      config.staticRoutes === undefined
        ? undefined
        : { staticRoutes: config.staticRoutes },
    inboundRouteMap: ref(config.inboundRouteMapId),
    outboundRouteMap: ref(config.outboundRouteMapId),
  };
