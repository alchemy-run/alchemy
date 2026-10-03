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

export interface ConnectivityConfigurationGroup {
  /** ARM ID of the network group. */
  networkGroupId: string;
  /**
   * Connectivity inside the group.
   * @default "None"
   */
  groupConnectivity?: "None" | "DirectlyConnected";
  /**
   * Whether spokes use the hub's gateway.
   * @default "False"
   */
  useHubGateway?: "True" | "False";
  /**
   * Whether the group mesh is global (cross-region).
   * @default "False"
   */
  isGlobal?: "True" | "False";
}

export interface ConnectivityConfigurationProps {
  /** Resource group of the network manager. Changing it replaces the configuration. */
  resourceGroup: string;
  /** Name of the parent network manager. Changing it replaces the configuration. */
  networkManager: string;
  /**
   * Name of the configuration. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the configuration.
   */
  name?: string;
  /** Description of the configuration. */
  description?: string;
  /** Topology: full mesh between members, or hub-and-spoke. */
  connectivityTopology: "Mesh" | "HubAndSpoke";
  /** Network groups the configuration applies to. */
  appliesToGroups: ConnectivityConfigurationGroup[];
  /** Hub virtual network IDs (`HubAndSpoke` only). */
  hubVirtualNetworkIds?: string[];
  /**
   * Whether the mesh is global (cross-region).
   * @default "False"
   */
  isGlobal?: "True" | "False";
  /**
   * Whether existing peerings are removed on deployment.
   * @default "False"
   */
  deleteExistingPeering?: "True" | "False";
}

export interface ConnectivityConfiguration extends Resource<
  "Azure.Network.ConnectivityConfiguration",
  ConnectivityConfigurationProps,
  {
    /** Name of the configuration. */
    configurationName: string;
    /** ARM resource ID of the configuration. */
    configurationId: string;
    /** Name of the parent network manager. */
    networkManager: string;
    /** Resource group of the network manager. */
    resourceGroup: string;
    /** Topology. */
    connectivityTopology: string | undefined;
    /** IDs of the network groups the configuration applies to. */
    networkGroupIds: string[];
  },
  never,
  Providers
> {}

/**
 * A connectivity configuration in an Azure Virtual Network Manager — a
 * mesh or hub-and-spoke topology across network groups. It takes effect
 * once deployed (committed) to regions; this resource manages the
 * configuration only. It carries no tags: ownership follows the network
 * manager.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/concept-connectivity-configuration
 *
 * ### Creating a Configuration
 * **Example:** Mesh between spokes
 * ```typescript
 * yield* Azure.Network.ConnectivityConfiguration("mesh", {
 *   resourceGroup: group.resourceGroupName,
 *   networkManager: manager.networkManagerName,
 *   connectivityTopology: "Mesh",
 *   appliesToGroups: [
 *     { networkGroupId: spokes.networkGroupId, groupConnectivity: "DirectlyConnected" },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const ConnectivityConfiguration = Resource<ConnectivityConfiguration>(
  "Azure.Network.ConnectivityConfiguration",
);

export const ConnectivityConfigurationProvider = () =>
  Provider.succeed(
    ConnectivityConfiguration,
    networkProvider<ConnectivityConfiguration>()({
      label: "connectivity configuration",
      nameAttr: "configurationName",
      parents: ["networkManager"],
      tracked: false,
      physicalName: networkManagerChildName,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetConnectivityConfiguration({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkManagerName: path.networkManager!,
            configurationName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.ConnectivityConfigurationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          configurationName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteConnectivityConfiguration({
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
          connectivityTopology: news.connectivityTopology,
          hubs: (news.hubVirtualNetworkIds ?? []).map((resourceId) => ({
            resourceId,
            resourceType: "Microsoft.Network/virtualNetworks",
          })),
          isGlobal: news.isGlobal ?? "False",
          deleteExistingPeering: news.deleteExistingPeering ?? "False",
          appliesToGroups: news.appliesToGroups.map((g) => ({
            networkGroupId: g.networkGroupId,
            groupConnectivity: g.groupConnectivity ?? "None",
            useHubGateway: g.useHubGateway ?? "False",
            isGlobal: g.isGlobal ?? "False",
          })),
        },
      }),
      toAttrs: (path, observed) => ({
        configurationName: path.name,
        configurationId: observed.id ?? "",
        networkManager: path.networkManager!,
        resourceGroup: path.resourceGroup,
        connectivityTopology: observed.properties?.connectivityTopology,
        networkGroupIds: (observed.properties?.appliesToGroups ?? []).map(
          (g) => g.networkGroupId,
        ),
      }),
      dependsOn: ["Azure.Network.NetworkGroup", "Azure.Network.NetworkManager"],
    }),
  );
