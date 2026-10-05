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

export interface SecurityAdminConfigurationProps {
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
  /**
   * Network-intent-policy-based services the rules also apply to.
   * @default ["None"]
   */
  applyOnNetworkIntentPolicyBasedServices?: (
    | "None"
    | "All"
    | "AllowRulesOnly"
  )[];
  /**
   * How member address spaces are aggregated into rules.
   * @default "None"
   */
  networkGroupAddressSpaceAggregationOption?: "None" | "Manual";
}

export interface SecurityAdminConfiguration extends Resource<
  "Azure.Network.SecurityAdminConfiguration",
  SecurityAdminConfigurationProps,
  {
    /** Name of the configuration. */
    configurationName: string;
    /** ARM resource ID of the configuration. */
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
 * A security admin configuration in an Azure Virtual Network Manager —
 * holds {@link AdminRuleCollection}s whose rules are evaluated before
 * NSG rules on every VNet in the targeted network groups once the
 * configuration is deployed. It carries no tags: ownership follows the
 * network manager.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/concept-security-admins
 *
 * ### Creating a Configuration
 * **Example:** Organization-wide security rules
 * ```typescript
 * const admin = yield* Azure.Network.SecurityAdminConfiguration("org", {
 *   resourceGroup: group.resourceGroupName,
 *   networkManager: manager.networkManagerName,
 *   description: "Org-wide deny rules",
 * });
 * ```
 *
 * @resource
 */
export const SecurityAdminConfiguration = Resource<SecurityAdminConfiguration>(
  "Azure.Network.SecurityAdminConfiguration",
);

export const SecurityAdminConfigurationProvider = () =>
  Provider.succeed(
    SecurityAdminConfiguration,
    networkProvider<SecurityAdminConfiguration>()({
      label: "security admin configuration",
      nameAttr: "configurationName",
      parents: ["networkManager"],
      tracked: false,
      physicalName: networkManagerChildName,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetSecurityAdminConfiguration({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkManagerName: path.networkManager!,
            configurationName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.SecurityAdminConfigurationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          configurationName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteSecurityAdminConfiguration({
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
          applyOnNetworkIntentPolicyBasedServices:
            news.applyOnNetworkIntentPolicyBasedServices ?? ["None"],
          networkGroupAddressSpaceAggregationOption:
            news.networkGroupAddressSpaceAggregationOption ?? "None",
        },
      }),
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
