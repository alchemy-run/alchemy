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

export interface AdminRuleCollectionProps {
  /** Resource group of the network manager. Changing it replaces the collection. */
  resourceGroup: string;
  /** Name of the network manager. Changing it replaces the collection. */
  networkManager: string;
  /**
   * Name of the parent security admin configuration. Changing it replaces
   * the collection.
   */
  securityAdminConfiguration: string;
  /**
   * Name of the rule collection. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces it.
   */
  name?: string;
  /** Description of the collection. */
  description?: string;
  /** ARM IDs of the network groups the collection's rules apply to. */
  networkGroupIds: string[];
}

export interface AdminRuleCollection extends Resource<
  "Azure.Network.AdminRuleCollection",
  AdminRuleCollectionProps,
  {
    /** Name of the rule collection. */
    ruleCollectionName: string;
    /** ARM resource ID of the rule collection. */
    ruleCollectionId: string;
    /** Name of the network manager. */
    networkManager: string;
    /** Name of the parent security admin configuration. */
    securityAdminConfiguration: string;
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
 * A rule collection in an Azure Virtual Network Manager security admin
 * configuration — a set of {@link AdminRule}s applied to network groups.
 * It carries no tags: ownership follows the network manager.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/concept-security-admins
 *
 * ### Creating a Rule Collection
 * **Example:** Rules for the spokes group
 * ```typescript
 * const rules = yield* Azure.Network.AdminRuleCollection("deny-risky", {
 *   resourceGroup: group.resourceGroupName,
 *   networkManager: manager.networkManagerName,
 *   securityAdminConfiguration: admin.configurationName,
 *   networkGroupIds: [spokes.networkGroupId],
 * });
 * ```
 *
 * @resource
 */
export const AdminRuleCollection = Resource<AdminRuleCollection>(
  "Azure.Network.AdminRuleCollection",
);

export const AdminRuleCollectionProvider = () =>
  Provider.succeed(
    AdminRuleCollection,
    networkProvider<AdminRuleCollection>()({
      label: "admin rule collection",
      nameAttr: "ruleCollectionName",
      parents: ["networkManager", "securityAdminConfiguration"],
      tracked: false,
      physicalName: networkManagerChildName,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetAdminRuleCollection({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkManagerName: path.networkManager!,
            configurationName: path.securityAdminConfiguration!,
            ruleCollectionName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.AdminRuleCollectionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          configurationName: path.securityAdminConfiguration!,
          ruleCollectionName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteAdminRuleCollection({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          configurationName: path.securityAdminConfiguration!,
          ruleCollectionName: path.name,
          force: true,
        }),
      ownerTags: networkManagerTags,
      body: (news) => ({
        properties: {
          description: news.description,
          appliesToGroups: news.networkGroupIds.map((networkGroupId) => ({
            networkGroupId,
          })),
        },
      }),
      drifted: (observed, _body, news) =>
        (observed.properties?.description ?? undefined) !== news.description ||
        !sameSet(
          (observed.properties?.appliesToGroups ?? []).map(
            (g) => g.networkGroupId,
          ),
          news.networkGroupIds,
        ),
      toAttrs: (path, observed) => ({
        ruleCollectionName: path.name,
        ruleCollectionId: observed.id ?? "",
        networkManager: path.networkManager!,
        securityAdminConfiguration: path.securityAdminConfiguration!,
        resourceGroup: path.resourceGroup,
        description: observed.properties?.description,
        networkGroupIds: (observed.properties?.appliesToGroups ?? []).map(
          (g) => g.networkGroupId,
        ),
      }),
      dependsOn: [
        "Azure.Network.SecurityAdminConfiguration",
        "Azure.Network.NetworkManager",
      ],
    }),
  );
