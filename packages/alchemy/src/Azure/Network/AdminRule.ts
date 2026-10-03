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

export interface AdminRuleAddress {
  /** CIDR, IP, or service tag. */
  addressPrefix: string;
  /** Whether `addressPrefix` is an IP prefix or a service tag. */
  addressPrefixType: "IPPrefix" | "ServiceTag" | "NetworkGroup";
}

export interface AdminRuleProps {
  /** Resource group of the network manager. Changing it replaces the rule. */
  resourceGroup: string;
  /** Name of the network manager. Changing it replaces the rule. */
  networkManager: string;
  /** Name of the security admin configuration. Changing it replaces the rule. */
  securityAdminConfiguration: string;
  /** Name of the parent rule collection. Changing it replaces the rule. */
  ruleCollection: string;
  /**
   * Name of the rule. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the rule.
   */
  name?: string;
  /** Description of the rule. */
  description?: string;
  /** Network protocol. */
  protocol: "Tcp" | "Udp" | "Icmp" | "Esp" | "Any" | "Ah";
  /**
   * `Allow` (NSGs can still deny), `Deny`, or `AlwaysAllow` (skips NSGs).
   */
  access: "Allow" | "Deny" | "AlwaysAllow";
  /** Priority (1-4096); lower runs first. */
  priority: number;
  /** Traffic direction. */
  direction: "Inbound" | "Outbound";
  /** Source addresses. @default any */
  sources?: AdminRuleAddress[];
  /** Destination addresses. @default any */
  destinations?: AdminRuleAddress[];
  /** Source port ranges. @default ["0-65535"] */
  sourcePortRanges?: string[];
  /** Destination port ranges, e.g. `["22", "3389"]`. @default ["0-65535"] */
  destinationPortRanges?: string[];
}

export interface AdminRule extends Resource<
  "Azure.Network.AdminRule",
  AdminRuleProps,
  {
    /** Name of the rule. */
    ruleName: string;
    /** ARM resource ID of the rule. */
    ruleId: string;
    /** Name of the network manager. */
    networkManager: string;
    /** Name of the security admin configuration. */
    securityAdminConfiguration: string;
    /** Name of the parent rule collection. */
    ruleCollection: string;
    /** Resource group of the network manager. */
    resourceGroup: string;
    /** Access. */
    access: string | undefined;
    /** Priority. */
    priority: number | undefined;
    /** Direction. */
    direction: string | undefined;
    /** Protocol. */
    protocol: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A custom security admin rule in an Azure Virtual Network Manager rule
 * collection — evaluated before NSG rules on every targeted VNet once its
 * configuration is deployed. It carries no tags: ownership follows the
 * network manager.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/concept-security-admins
 *
 * ### Creating a Rule
 * **Example:** Deny inbound RDP and SSH from the internet
 * ```typescript
 * yield* Azure.Network.AdminRule("deny-remote", {
 *   resourceGroup: group.resourceGroupName,
 *   networkManager: manager.networkManagerName,
 *   securityAdminConfiguration: admin.configurationName,
 *   ruleCollection: rules.ruleCollectionName,
 *   protocol: "Tcp",
 *   access: "Deny",
 *   priority: 100,
 *   direction: "Inbound",
 *   sources: [{ addressPrefix: "Internet", addressPrefixType: "ServiceTag" }],
 *   destinationPortRanges: ["22", "3389"],
 * });
 * ```
 *
 * @resource
 */
export const AdminRule = Resource<AdminRule>("Azure.Network.AdminRule");

const anyAddress = [{ addressPrefix: "*", addressPrefixType: "IPPrefix" }];

export const AdminRuleProvider = () =>
  Provider.succeed(
    AdminRule,
    networkProvider<AdminRule>()({
      label: "admin rule",
      nameAttr: "ruleName",
      parents: [
        "networkManager",
        "securityAdminConfiguration",
        "ruleCollection",
      ],
      tracked: false,
      physicalName: networkManagerChildName,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetAdminRule({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkManagerName: path.networkManager!,
            configurationName: path.securityAdminConfiguration!,
            ruleCollectionName: path.ruleCollection!,
            ruleName: path.name,
          }),
        ),
      body: (news) => ({
        kind: "Custom",
        properties: {
          description: news.description,
          protocol: news.protocol,
          access: news.access,
          priority: news.priority,
          direction: news.direction,
          sources: news.sources ?? anyAddress,
          destinations: news.destinations ?? anyAddress,
          sourcePortRanges: news.sourcePortRanges ?? ["0-65535"],
          destinationPortRanges: news.destinationPortRanges ?? ["0-65535"],
        },
      }),
      put: (subscriptionId, path, body) =>
        network.AdminRulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          configurationName: path.securityAdminConfiguration!,
          ruleCollectionName: path.ruleCollection!,
          ruleName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteAdminRule({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          configurationName: path.securityAdminConfiguration!,
          ruleCollectionName: path.ruleCollection!,
          ruleName: path.name,
          force: true,
        }),
      ownerTags: networkManagerTags,
      toAttrs: (path, observed) => ({
        ruleName: path.name,
        ruleId: observed.id ?? "",
        networkManager: path.networkManager!,
        securityAdminConfiguration: path.securityAdminConfiguration!,
        ruleCollection: path.ruleCollection!,
        resourceGroup: path.resourceGroup,
        access: observed.properties?.access,
        priority: observed.properties?.priority,
        direction: observed.properties?.direction,
        protocol: observed.properties?.protocol,
      }),
      dependsOn: [
        "Azure.Network.AdminRuleCollection",
        "Azure.Network.SecurityAdminConfiguration",
        "Azure.Network.NetworkManager",
      ],
    }),
  );
