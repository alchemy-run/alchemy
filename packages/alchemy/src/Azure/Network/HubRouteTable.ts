import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";
import { hubOwnerTags } from "./virtualHubShared.ts";

/** A static route in a hub route table. */
export interface HubRouteSpec {
  /** Name of the route, unique within the table. */
  name: string;
  /** Destination type. */
  destinationType: "CIDR" | "ResourceId" | "Service";
  /** Destinations (CIDRs, resource IDs, or service tags). */
  destinations: string[];
  /** Next-hop type (`ResourceId`: a hub connection or firewall ID). */
  nextHopType: "ResourceId";
  /** Next hop: ARM ID of a hub VNet connection or Azure Firewall. */
  nextHop: string;
}

export interface HubRouteTableProps {
  /** Resource group of the virtual hub. Changing it replaces the table. */
  resourceGroup: string;
  /** Name of the parent virtual hub. Changing it replaces the table. */
  virtualHub: string;
  /**
   * Name of the route table. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the table.
   */
  name?: string;
  /** Static routes of the table. */
  routes?: HubRouteSpec[];
  /** Labels connections can propagate to, e.g. `["spokes"]`. */
  labels?: string[];
}

export interface HubRouteTable extends Resource<
  "Azure.Network.HubRouteTable",
  HubRouteTableProps,
  {
    /** Name of the route table. */
    routeTableName: string;
    /** ARM resource ID of the route table. */
    routeTableId: string;
    /** Name of the parent virtual hub. */
    virtualHub: string;
    /** Resource group of the virtual hub. */
    resourceGroup: string;
    /** Labels of the table. */
    labels: string[];
    /** Names of the table's routes. */
    routeNames: string[];
    /** IDs of the connections associated with the table. */
    associatedConnectionIds: string[];
    /** IDs of the connections propagating to the table. */
    propagatingConnectionIds: string[];
  },
  never,
  Providers
> {}

/**
 * A route table in a Standard Azure Virtual WAN hub. Connections associate
 * with one table and propagate their routes to tables or labels. Route
 * tables carry no tags: ownership follows the parent hub.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/about-virtual-hub-routing
 *
 * ### Creating a Route Table
 * **Example:** Labeled table with a static route
 * ```typescript
 * const table = yield* Azure.Network.HubRouteTable("spokes", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualHub: hub.virtualHubName,
 *   labels: ["spokes"],
 *   routes: [
 *     {
 *       name: "to-nva",
 *       destinationType: "CIDR",
 *       destinations: ["10.50.0.0/16"],
 *       nextHopType: "ResourceId",
 *       nextHop: nvaConnection.connectionId,
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const HubRouteTable = Resource<HubRouteTable>(
  "Azure.Network.HubRouteTable",
);

export const HubRouteTableProvider = () =>
  Provider.succeed(
    HubRouteTable,
    networkProvider<HubRouteTable>()({
      label: "hub route table",
      nameAttr: "routeTableName",
      parents: ["virtualHub"],
      tracked: false,
      slow: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetHubRouteTable({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            virtualHubName: path.virtualHub!,
            routeTableName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.HubRouteTablesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualHubName: path.virtualHub!,
          routeTableName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteHubRouteTable({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualHubName: path.virtualHub!,
          routeTableName: path.name,
        }),
      ownerTags: hubOwnerTags,
      body: (news) => ({
        properties: {
          routes: news.routes ?? [],
          labels: news.labels ?? [],
        },
      }),
      toAttrs: (path, observed) => ({
        routeTableName: path.name,
        routeTableId: observed.id ?? "",
        virtualHub: path.virtualHub!,
        resourceGroup: path.resourceGroup,
        labels: [...(observed.properties?.labels ?? [])],
        routeNames: (observed.properties?.routes ?? []).map(
          (route) => route.name,
        ),
        associatedConnectionIds: [
          ...(observed.properties?.associatedConnections ?? []),
        ],
        propagatingConnectionIds: [
          ...(observed.properties?.propagatingConnections ?? []),
        ],
      }),
      dependsOn: ["Azure.Network.VirtualHub"],
    }),
  );
