import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameSet } from "./common.ts";
import { networkProvider } from "./generic.ts";
import { networkManagerChildName } from "./networkManagerShared.ts";

export type NetworkManagerScopeAccess =
  | "SecurityAdmin"
  | "Connectivity"
  | "Routing"
  | "SecurityUser";

export interface NetworkManagerProps {
  /** Resource group of the network manager. Changing it replaces it. */
  resourceGroup: string;
  /**
   * Name of the network manager: 1-64 letters, digits, `_`, `.`, and `-`.
   * If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the network manager.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the network manager.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Description of the network manager. */
  description?: string;
  /**
   * Subscription IDs (`/subscriptions/<id>`) the manager governs.
   * @default the current subscription (when `managementGroups` is unset)
   */
  subscriptions?: string[];
  /** Management group IDs (`/providers/Microsoft.Management/managementGroups/<id>`) the manager governs. */
  managementGroups?: string[];
  /**
   * Features enabled on the manager.
   * @default ["Connectivity", "SecurityAdmin"]
   */
  scopeAccesses?: NetworkManagerScopeAccess[];
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface NetworkManager extends Resource<
  "Azure.Network.NetworkManager",
  NetworkManagerProps,
  {
    /** Name of the network manager. */
    networkManagerName: string;
    /** ARM resource ID of the network manager. */
    networkManagerId: string;
    /** Resource group of the network manager. */
    resourceGroup: string;
    /** Location of the network manager. */
    location: string;
    /** Description. */
    description: string | undefined;
    /** Governed subscriptions. */
    subscriptions: string[];
    /** Governed management groups. */
    managementGroups: string[];
    /** Enabled features. */
    scopeAccesses: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Virtual Network Manager — central management of connectivity
 * (mesh / hub-and-spoke), security admin rules, routing, and IPAM across
 * the virtual networks in its scope. Group VNets with {@link NetworkGroup}
 * and configure them with {@link ConnectivityConfiguration} or
 * {@link SecurityAdminConfiguration}.
 *
 * Billing is per managed VNet once configurations are deployed; an
 * undeployed manager is effectively free.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/overview
 *
 * ### Creating a Network Manager
 * **Example:** Manage the current subscription
 * ```typescript
 * const manager = yield* Azure.Network.NetworkManager("avnm", {
 *   resourceGroup: group.resourceGroupName,
 *   scopeAccesses: ["Connectivity", "SecurityAdmin"],
 * });
 * ```
 *
 * @resource
 */
export const NetworkManager = Resource<NetworkManager>(
  "Azure.Network.NetworkManager",
);

export const NetworkManagerProvider = () =>
  Provider.succeed(
    NetworkManager,
    networkProvider<NetworkManager>()({
      label: "network manager",
      nameAttr: "networkManagerName",
      tracked: true,
      physicalName: networkManagerChildName,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNetworkManager({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkManagerName: path.name,
          }),
        ),
      body: (news, { location, tags, subscriptionId }) => ({
        location,
        tags,
        properties: {
          description: news.description,
          networkManagerScopes: {
            subscriptions:
              news.subscriptions ??
              (news.managementGroups === undefined
                ? [`/subscriptions/${subscriptionId}`]
                : []),
            managementGroups: news.managementGroups ?? [],
          },
          networkManagerScopeAccesses: news.scopeAccesses ?? [
            "Connectivity",
            "SecurityAdmin",
          ],
        },
      }),
      put: (subscriptionId, path, body) =>
        network.NetworkManagersCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteNetworkManager({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.name,
          force: true,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.PatchNetworkManager({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListNetworkManagerBySubscription({ subscriptionId }),
      drifted: (observed, body, news) => {
        const p = observed.properties;
        const scopes = body.properties.networkManagerScopes;
        return (
          (p?.description ?? undefined) !== news.description ||
          !sameSet(
            p?.networkManagerScopes.subscriptions,
            scopes.subscriptions,
          ) ||
          !sameSet(
            p?.networkManagerScopes.managementGroups,
            scopes.managementGroups,
          ) ||
          !sameSet(
            p?.networkManagerScopeAccesses,
            body.properties.networkManagerScopeAccesses,
          )
        );
      },
      toAttrs: (path, observed) => ({
        networkManagerName: path.name,
        networkManagerId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        description: observed.properties?.description,
        subscriptions: [
          ...(observed.properties?.networkManagerScopes.subscriptions ?? []),
        ],
        managementGroups: [
          ...(observed.properties?.networkManagerScopes.managementGroups ?? []),
        ],
        scopeAccesses: [
          ...(observed.properties?.networkManagerScopeAccesses ?? []),
        ],
        tags: userTags(observed.tags),
      }),
    }),
  );
