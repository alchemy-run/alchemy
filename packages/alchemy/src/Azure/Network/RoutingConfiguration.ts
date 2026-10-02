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

export interface RoutingConfigurationProps {
  /** Resource group of the network manager. Changing it replaces the routing configuration. */
  resourceGroup: string;
  /** Name of the parent network manager. Changing it replaces the routing configuration. */
  networkManager: string;
  /**
   * Name of the routing configuration. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the routing configuration.
   */
  name?: string;
  /** Description. */
  description?: string;
  /**
   * Whether the manager creates its own route tables or reuses existing ones.
   * @default "ManagedOnly"
   */
  routeTableUsageMode?: "ManagedOnly" | "UseExisting";
}

export interface RoutingConfiguration extends Resource<
  "Azure.Network.RoutingConfiguration",
  RoutingConfigurationProps,
  {
    /** Name of the routing configuration. */
    configurationName: string;
    /** ARM resource ID of the routing configuration. */
    configurationId: string;
    /** Name of the parent network manager. */
    networkManager: string;
    /** Resource group of the network manager. */
    resourceGroup: string;
    /** Description. */
    description: string | undefined;
    /** Route table usage mode. */
    routeTableUsageMode: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A routing configuration in an Azure Virtual Network Manager — holds
 * {@link RoutingRuleCollection}s of user-defined routes the manager
 * programs into its network groups' subnets (requires the `Routing` scope
 * access). It carries no tags: ownership follows the network manager.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/concept-user-defined-route
 *
 * ### Creating a Configuration
 * **Example:** Routing configuration
 * ```typescript
 * const routing = yield* Azure.Network.RoutingConfiguration("egress", {
 *   resourceGroup: group.resourceGroupName,
 *   networkManager: manager.networkManagerName,
 * });
 * ```
 *
 * @resource
 */
export const RoutingConfiguration = Resource<RoutingConfiguration>(
  "Azure.Network.RoutingConfiguration",
);

export const RoutingConfigurationProvider = () =>
  Provider.succeed(
    RoutingConfiguration,
    networkProvider<RoutingConfiguration>()({
      label: "routing configuration",
      nameAttr: "configurationName",
      parents: ["networkManager"],
      tracked: false,
      physicalName: networkManagerChildName,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNetworkManagerRoutingConfiguration({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkManagerName: path.networkManager!,
            configurationName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.NetworkManagerRoutingConfigurationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          configurationName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteNetworkManagerRoutingConfiguration({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          configurationName: path.name,
          force: true,
        }),
      ownerTags: networkManagerTags,
      body: (news) => ({
        properties: {
          description: news.description,
          routeTableUsageMode: news.routeTableUsageMode ?? "ManagedOnly",
        },
      }),
      toAttrs: (path, observed) => ({
        configurationName: path.name,
        configurationId: observed.id ?? "",
        networkManager: path.networkManager!,
        resourceGroup: path.resourceGroup,
        description: observed.properties?.description,
        routeTableUsageMode: observed.properties?.routeTableUsageMode,
      }),
      dependsOn: ["Azure.Network.NetworkManager"],
    }),
  );
