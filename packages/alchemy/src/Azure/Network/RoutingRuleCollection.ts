import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameSet } from "./common.ts";
import { networkProvider } from "./generic.ts";
import {
  networkManagerChildName,
  networkManagerTags,
} from "./networkManagerShared.ts";

export interface RoutingRuleCollectionProps {
  /** Resource group of the network manager. Changing it replaces the routing rule collection. */
  resourceGroup: string;
  /** Name of the parent network manager. Changing it replaces the routing rule collection. */
  networkManager: string;
  /** Name of the parent routing configuration. Changing it replaces the routing rule collection. */
  routingConfiguration: string;
  /**
   * Name of the routing rule collection. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the routing rule collection.
   */
  name?: string;
  /** Description. */
  description?: string;
  /** ARM IDs of the network groups the collection applies to. */
  networkGroupIds: string[];
  /**
   * Whether BGP route propagation is disabled on the managed route tables.
   * @default "False"
   */
  disableBgpRoutePropagation?: "True" | "False";
}

export interface RoutingRuleCollection extends Resource<
  "Azure.Network.RoutingRuleCollection",
  RoutingRuleCollectionProps,
  {
    /** Name of the routing rule collection. */
    ruleCollectionName: string;
    /** ARM resource ID of the routing rule collection. */
    ruleCollectionId: string;
    /** Name of the parent network manager. */
    networkManager: string;
    /** Name of the parent routing configuration. */
    routingConfiguration: string;
    /** Resource group of the network manager. */
    resourceGroup: string;
    /** Description. */
    description: string | undefined;
    /** Targeted network group IDs. */
    networkGroupIds: string[];
  },
  never,
  Providers
> {}

/**
 * A rule collection in an Azure Virtual Network Manager routing
 * configuration — a set of {@link RoutingRule}s applied to network
 * groups. It carries no tags: ownership follows the network manager.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/concept-user-defined-route
 *
 * ### Creating a Rule Collection
 * **Example:** Routes for the spokes
 * ```typescript
 * const routes = yield* Azure.Network.RoutingRuleCollection("spokes", {
 *   resourceGroup: group.resourceGroupName,
 *   networkManager: manager.networkManagerName,
 *   routingConfiguration: routing.configurationName,
 *   networkGroupIds: [spokes.networkGroupId],
 * });
 * ```
 *
 * @resource
 */
export const RoutingRuleCollection = Resource<RoutingRuleCollection>(
  "Azure.Network.RoutingRuleCollection",
);

export const RoutingRuleCollectionProvider = () =>
  Provider.succeed(
    RoutingRuleCollection,
    networkProvider<RoutingRuleCollection>()({
      label: "routing rule collection",
      nameAttr: "ruleCollectionName",
      parents: ["networkManager", "routingConfiguration"],
      tracked: false,
      physicalName: networkManagerChildName,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetRoutingRuleCollection({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkManagerName: path.networkManager!,
            configurationName: path.routingConfiguration!,
            ruleCollectionName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.RoutingRuleCollectionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          configurationName: path.routingConfiguration!,
          ruleCollectionName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteRoutingRuleCollection({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          configurationName: path.routingConfiguration!,
          ruleCollectionName: path.name,
          force: true,
        }),
      ownerTags: networkManagerTags,
      body: (news) => ({
        properties: {
          description: news.description,
          appliesTo: news.networkGroupIds.map((networkGroupId) => ({
            networkGroupId,
          })),
          disableBgpRoutePropagation:
            news.disableBgpRoutePropagation ?? "False",
        },
      }),
      drifted: (observed, _body, news) =>
        (observed.properties?.description ?? undefined) !== news.description ||
        (observed.properties?.disableBgpRoutePropagation ?? "False") !==
          (news.disableBgpRoutePropagation ?? "False") ||
        !sameSet(
          (observed.properties?.appliesTo ?? []).map((g) => g.networkGroupId),
          news.networkGroupIds,
        ),
      toAttrs: (path, observed) => ({
        ruleCollectionName: path.name,
        ruleCollectionId: observed.id ?? "",
        networkManager: path.networkManager!,
        routingConfiguration: path.routingConfiguration!,
        resourceGroup: path.resourceGroup,
        description: observed.properties?.description,
        networkGroupIds: (observed.properties?.appliesTo ?? []).map(
          (g) => g.networkGroupId,
        ),
      }),
      dependsOn: [
        "Azure.Network.RoutingConfiguration",
        "Azure.Network.NetworkManager",
      ],
    }),
  );
