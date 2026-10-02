import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import type { AdminRuleAddress } from "./AdminRule.ts";
import { networkProvider } from "./generic.ts";
import {
  networkManagerChildName,
  networkManagerTags,
} from "./networkManagerShared.ts";

export interface SecurityUserRuleProps {
  /** Resource group of the network manager. Changing it replaces the security user rule. */
  resourceGroup: string;
  /** Name of the parent network manager. Changing it replaces the security user rule. */
  networkManager: string;
  /** Name of the parent security user configuration. Changing it replaces the security user rule. */
  securityUserConfiguration: string;
  /** Name of the parent rule collection. Changing it replaces the security user rule. */
  ruleCollection: string;
  /**
   * Name of the security user rule. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the security user rule.
   */
  name?: string;
  /** Description. */
  description?: string;
  /** Network protocol. */
  protocol: "Tcp" | "Udp" | "Icmp" | "Esp" | "Any" | "Ah";
  /** Traffic direction. */
  direction: "Inbound" | "Outbound";
  /** Source addresses. @default any */
  sources?: AdminRuleAddress[];
  /** Destination addresses. @default any */
  destinations?: AdminRuleAddress[];
  /** Source port ranges. @default ["0-65535"] */
  sourcePortRanges?: string[];
  /** Destination port ranges. @default ["0-65535"] */
  destinationPortRanges?: string[];
}

export interface SecurityUserRule extends Resource<
  "Azure.Network.SecurityUserRule",
  SecurityUserRuleProps,
  {
    /** Name of the security user rule. */
    ruleName: string;
    /** ARM resource ID of the security user rule. */
    ruleId: string;
    /** Name of the parent network manager. */
    networkManager: string;
    /** Name of the parent security user configuration. */
    securityUserConfiguration: string;
    /** Name of the parent rule collection. */
    ruleCollection: string;
    /** Resource group of the network manager. */
    resourceGroup: string;
    /** Description. */
    description: string | undefined;
    /** Direction. */
    direction: string | undefined;
    /** Protocol. */
    protocol: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A security user rule in an Azure Virtual Network Manager rule
 * collection — an allow rule applied like an NSG rule to every targeted
 * VNet once deployed. It carries no tags: ownership follows the network
 * manager.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/concept-security-user-rules
 *
 * ### Creating a Rule
 * **Example:** Allow HTTPS inbound
 * ```typescript
 * yield* Azure.Network.SecurityUserRule("https", {
 *   resourceGroup: group.resourceGroupName,
 *   networkManager: manager.networkManagerName,
 *   securityUserConfiguration: users.configurationName,
 *   ruleCollection: rules.ruleCollectionName,
 *   protocol: "Tcp",
 *   direction: "Inbound",
 *   destinationPortRanges: ["443"],
 * });
 * ```
 *
 * @resource
 */
export const SecurityUserRule = Resource<SecurityUserRule>(
  "Azure.Network.SecurityUserRule",
);

const anyAddress = [{ addressPrefix: "*", addressPrefixType: "IPPrefix" }];

export const SecurityUserRuleProvider = () =>
  Provider.succeed(
    SecurityUserRule,
    networkProvider<SecurityUserRule>()({
      label: "security user rule",
      nameAttr: "ruleName",
      parents: [
        "networkManager",
        "securityUserConfiguration",
        "ruleCollection",
      ],
      tracked: false,
      physicalName: networkManagerChildName,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetSecurityUserRule({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkManagerName: path.networkManager!,
            configurationName: path.securityUserConfiguration!,
            ruleCollectionName: path.ruleCollection!,
            ruleName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.SecurityUserRulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          configurationName: path.securityUserConfiguration!,
          ruleCollectionName: path.ruleCollection!,
          ruleName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteSecurityUserRule({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          configurationName: path.securityUserConfiguration!,
          ruleCollectionName: path.ruleCollection!,
          ruleName: path.name,
          force: true,
        }),
      ownerTags: networkManagerTags,
      body: (news) => ({
        properties: {
          description: news.description,
          protocol: news.protocol,
          direction: news.direction,
          sources: news.sources ?? anyAddress,
          destinations: news.destinations ?? anyAddress,
          sourcePortRanges: news.sourcePortRanges ?? ["0-65535"],
          destinationPortRanges: news.destinationPortRanges ?? ["0-65535"],
        },
      }),
      toAttrs: (path, observed) => ({
        ruleName: path.name,
        ruleId: observed.id ?? "",
        networkManager: path.networkManager!,
        securityUserConfiguration: path.securityUserConfiguration!,
        ruleCollection: path.ruleCollection!,
        resourceGroup: path.resourceGroup,
        description: observed.properties?.description,
        direction: observed.properties?.direction,
        protocol: observed.properties?.protocol,
      }),
      dependsOn: [
        "Azure.Network.SecurityUserRuleCollection",
        "Azure.Network.SecurityUserConfiguration",
        "Azure.Network.NetworkManager",
      ],
    }),
  );
