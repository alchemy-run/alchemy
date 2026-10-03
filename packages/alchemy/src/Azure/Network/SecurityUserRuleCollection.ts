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

export interface SecurityUserRuleCollectionProps {
  /** Resource group of the network manager. Changing it replaces the security user rule collection. */
  resourceGroup: string;
  /** Name of the parent network manager. Changing it replaces the security user rule collection. */
  networkManager: string;
  /** Name of the parent security user configuration. Changing it replaces the security user rule collection. */
  securityUserConfiguration: string;
  /**
   * Name of the security user rule collection. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the security user rule collection.
   */
  name?: string;
  /** Description. */
  description?: string;
  /** ARM IDs of the network groups the collection applies to. */
  networkGroupIds: string[];
}

export interface SecurityUserRuleCollection extends Resource<
  "Azure.Network.SecurityUserRuleCollection",
  SecurityUserRuleCollectionProps,
  {
    /** Name of the security user rule collection. */
    ruleCollectionName: string;
    /** ARM resource ID of the security user rule collection. */
    ruleCollectionId: string;
    /** Name of the parent network manager. */
    networkManager: string;
    /** Name of the parent security user configuration. */
    securityUserConfiguration: string;
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
 * A rule collection in an Azure Virtual Network Manager security user
 * configuration — a set of {@link SecurityUserRule}s applied to network
 * groups. It carries no tags: ownership follows the network manager.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/concept-security-user-rules
 *
 * ### Creating a Rule Collection
 * **Example:** Rules for the app group
 * ```typescript
 * const rules = yield* Azure.Network.SecurityUserRuleCollection("app", {
 *   resourceGroup: group.resourceGroupName,
 *   networkManager: manager.networkManagerName,
 *   securityUserConfiguration: users.configurationName,
 *   networkGroupIds: [app.networkGroupId],
 * });
 * ```
 *
 * @resource
 */
export const SecurityUserRuleCollection = Resource<SecurityUserRuleCollection>(
  "Azure.Network.SecurityUserRuleCollection",
);

export const SecurityUserRuleCollectionProvider = () =>
  Provider.succeed(
    SecurityUserRuleCollection,
    networkProvider<SecurityUserRuleCollection>()({
      label: "security user rule collection",
      nameAttr: "ruleCollectionName",
      parents: ["networkManager", "securityUserConfiguration"],
      tracked: false,
      physicalName: networkManagerChildName,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetSecurityUserRuleCollection({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkManagerName: path.networkManager!,
            configurationName: path.securityUserConfiguration!,
            ruleCollectionName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.SecurityUserRuleCollectionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          configurationName: path.securityUserConfiguration!,
          ruleCollectionName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteSecurityUserRuleCollection({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          configurationName: path.securityUserConfiguration!,
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
        securityUserConfiguration: path.securityUserConfiguration!,
        resourceGroup: path.resourceGroup,
        description: observed.properties?.description,
        networkGroupIds: (observed.properties?.appliesToGroups ?? []).map(
          (g) => g.networkGroupId,
        ),
      }),
      dependsOn: [
        "Azure.Network.SecurityUserConfiguration",
        "Azure.Network.NetworkManager",
      ],
    }),
  );
