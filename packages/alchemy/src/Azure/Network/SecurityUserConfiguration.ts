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

export interface SecurityUserConfigurationProps {
  /** Resource group of the network manager. Changing it replaces the security user configuration. */
  resourceGroup: string;
  /** Name of the parent network manager. Changing it replaces the security user configuration. */
  networkManager: string;
  /**
   * Name of the security user configuration. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the security user configuration.
   */
  name?: string;
  /** Description. */
  description?: string;
}

export interface SecurityUserConfiguration extends Resource<
  "Azure.Network.SecurityUserConfiguration",
  SecurityUserConfigurationProps,
  {
    /** Name of the security user configuration. */
    configurationName: string;
    /** ARM resource ID of the security user configuration. */
    configurationId: string;
    /** Name of the parent network manager. */
    networkManager: string;
    /** Resource group of the network manager. */
    resourceGroup: string;
    /** Description. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A security user configuration in an Azure Virtual Network Manager —
 * holds {@link SecurityUserRuleCollection}s of NSG-like rules that the
 * manager applies to its network groups (requires the `SecurityUser` scope
 * access). It carries no tags: ownership follows the network manager.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/concept-security-user-rules
 *
 * ### Creating a Configuration
 * **Example:** Security user configuration
 * ```typescript
 * const users = yield* Azure.Network.SecurityUserConfiguration("app", {
 *   resourceGroup: group.resourceGroupName,
 *   networkManager: manager.networkManagerName,
 * });
 * ```
 *
 * @resource
 */
export const SecurityUserConfiguration = Resource<SecurityUserConfiguration>(
  "Azure.Network.SecurityUserConfiguration",
);

export const SecurityUserConfigurationProvider = () =>
  Provider.succeed(
    SecurityUserConfiguration,
    networkProvider<SecurityUserConfiguration>()({
      label: "security user configuration",
      nameAttr: "configurationName",
      parents: ["networkManager"],
      tracked: false,
      physicalName: networkManagerChildName,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetSecurityUserConfiguration({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkManagerName: path.networkManager!,
            configurationName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.SecurityUserConfigurationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          configurationName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteSecurityUserConfiguration({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          configurationName: path.name,
          force: true,
        }),
      ownerTags: networkManagerTags,
      body: (news) => ({ properties: { description: news.description } }),
      toAttrs: (path, observed) => ({
        configurationName: path.name,
        configurationId: observed.id ?? "",
        networkManager: path.networkManager!,
        resourceGroup: path.resourceGroup,
        description: observed.properties?.description,
      }),
      dependsOn: ["Azure.Network.NetworkManager"],
    }),
  );
