import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";
import {
  networkManagerChildName,
  networkManagerTags,
} from "./networkManagerShared.ts";

export interface RoutingRuleProps {
  /** Resource group of the network manager. Changing it replaces the routing rule. */
  resourceGroup: string;
  /** Name of the parent network manager. Changing it replaces the routing rule. */
  networkManager: string;
  /** Name of the parent routing configuration. Changing it replaces the routing rule. */
  routingConfiguration: string;
  /** Name of the parent rule collection. Changing it replaces the routing rule. */
  ruleCollection: string;
  /**
   * Name of the routing rule. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the routing rule.
   */
  name?: string;
  /** Description. */
  description?: string;
  /** Route destination: an address prefix or service tag. */
  destination: {
    /** Destination kind. */
    type: "AddressPrefix" | "ServiceTag";
    /** CIDR or service tag. */
    destinationAddress: string;
  };
  /** Next hop of the route. */
  nextHop: {
    /** Next hop kind. */
    nextHopType:
      | "Internet"
      | "NoNextHop"
      | "VirtualAppliance"
      | "VirtualNetworkGateway"
      | "VnetLocal";
    /** Next hop IP (`VirtualAppliance` only). */
    nextHopAddress?: string;
  };
}

export interface RoutingRule extends Resource<
  "Azure.Network.RoutingRule",
  RoutingRuleProps,
  {
    /** Name of the routing rule. */
    ruleName: string;
    /** ARM resource ID of the routing rule. */
    ruleId: string;
    /** Name of the parent network manager. */
    networkManager: string;
    /** Name of the parent routing configuration. */
    routingConfiguration: string;
    /** Name of the parent rule collection. */
    ruleCollection: string;
    /** Resource group of the network manager. */
    resourceGroup: string;
    /** Description. */
    description: string | undefined;
    /** Destination address. */
    destinationAddress: string | undefined;
    /** Next hop type. */
    nextHopType: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A routing rule in an Azure Virtual Network Manager rule collection — a
 * user-defined route programmed into every targeted subnet once the
 * configuration is deployed. It carries no tags: ownership follows the
 * network manager.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/concept-user-defined-route
 *
 * ### Creating a Rule
 * **Example:** Default route through a firewall
 * ```typescript
 * yield* Azure.Network.RoutingRule("default", {
 *   resourceGroup: group.resourceGroupName,
 *   networkManager: manager.networkManagerName,
 *   routingConfiguration: routing.configurationName,
 *   ruleCollection: routes.ruleCollectionName,
 *   destination: { type: "AddressPrefix", destinationAddress: "0.0.0.0/0" },
 *   nextHop: { nextHopType: "VirtualAppliance", nextHopAddress: "10.0.0.4" },
 * });
 * ```
 *
 * @resource
 */
export const RoutingRule = Resource<RoutingRule>("Azure.Network.RoutingRule");

export const RoutingRuleProvider = () =>
  Provider.succeed(
    RoutingRule,
    networkProvider<RoutingRule>()({
      label: "routing rule",
      nameAttr: "ruleName",
      parents: ["networkManager", "routingConfiguration", "ruleCollection"],
      tracked: false,
      physicalName: networkManagerChildName,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetRoutingRule({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkManagerName: path.networkManager!,
            configurationName: path.routingConfiguration!,
            ruleCollectionName: path.ruleCollection!,
            ruleName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.RoutingRulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          configurationName: path.routingConfiguration!,
          ruleCollectionName: path.ruleCollection!,
          ruleName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteRoutingRule({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          configurationName: path.routingConfiguration!,
          ruleCollectionName: path.ruleCollection!,
          ruleName: path.name,
          force: true,
        }),
      ownerTags: networkManagerTags,
      body: (news) => ({
        properties: {
          description: news.description,
          destination: news.destination,
          nextHop: news.nextHop,
        },
      }),
      toAttrs: (path, observed) => ({
        ruleName: path.name,
        ruleId: observed.id ?? "",
        networkManager: path.networkManager!,
        routingConfiguration: path.routingConfiguration!,
        ruleCollection: path.ruleCollection!,
        resourceGroup: path.resourceGroup,
        description: observed.properties?.description,
        destinationAddress: observed.properties?.destination.destinationAddress,
        nextHopType: observed.properties?.nextHop.nextHopType,
      }),
      dependsOn: [
        "Azure.Network.RoutingRuleCollection",
        "Azure.Network.RoutingConfiguration",
        "Azure.Network.NetworkManager",
      ],
    }),
  );
