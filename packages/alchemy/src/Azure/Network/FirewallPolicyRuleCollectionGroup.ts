import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";

export interface FirewallPolicyRuleCollectionGroupProps {
  /** Resource group of the firewall policy. Changing it replaces the group. */
  resourceGroup: string;
  /** Name of the parent firewall policy. Changing it replaces the group. */
  firewallPolicy: string;
  /**
   * Name of the rule collection group. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces
   * the group.
   */
  name?: string;
  /** Priority (100-65000); lower runs first. Unique within the policy. */
  priority: number;
  /**
   * Rule collections. `ruleCollectionType` is
   * `FirewallPolicyFilterRuleCollection` (with `action.type` `Allow` or
   * `Deny`) or `FirewallPolicyNatRuleCollection` (`action.type` `DNAT`).
   * Each rule's `ruleType` is `ApplicationRule`, `NetworkRule`, or
   * `NatRule`.
   */
  ruleCollections?: network.FirewallPolicyRuleCollection[];
}

export interface FirewallPolicyRuleCollectionGroup extends Resource<
  "Azure.Network.FirewallPolicyRuleCollectionGroup",
  FirewallPolicyRuleCollectionGroupProps,
  {
    /** Name of the rule collection group. */
    ruleCollectionGroupName: string;
    /** ARM resource ID of the rule collection group. */
    ruleCollectionGroupId: string;
    /** Name of the parent firewall policy. */
    firewallPolicy: string;
    /** Resource group of the firewall policy. */
    resourceGroup: string;
    /** Priority of the group. */
    priority: number | undefined;
    /** Names of the group's rule collections. */
    ruleCollectionNames: string[];
  },
  never,
  Providers
> {}

/**
 * A rule collection group in an Azure Firewall policy — an ordered set of
 * filter (allow/deny) and DNAT rule collections. Rule collection groups
 * carry no tags: ownership follows the parent policy.
 *
 * @see https://learn.microsoft.com/azure/firewall/policy-rule-sets
 *
 * ### Creating Rules
 * **Example:** Allow outbound HTTPS to one FQDN and DNS to Azure
 * ```typescript
 * yield* Azure.Network.FirewallPolicyRuleCollectionGroup("egress", {
 *   resourceGroup: group.resourceGroupName,
 *   firewallPolicy: policy.firewallPolicyName,
 *   priority: 200,
 *   ruleCollections: [
 *     {
 *       ruleCollectionType: "FirewallPolicyFilterRuleCollection",
 *       name: "allow-web",
 *       priority: 100,
 *       action: { type: "Allow" },
 *       rules: [
 *         {
 *           ruleType: "ApplicationRule",
 *           name: "github",
 *           sourceAddresses: ["10.0.0.0/16"],
 *           protocols: [{ protocolType: "Https", port: 443 }],
 *           targetFqdns: ["github.com"],
 *         },
 *         {
 *           ruleType: "NetworkRule",
 *           name: "dns",
 *           ipProtocols: ["UDP"],
 *           sourceAddresses: ["10.0.0.0/16"],
 *           destinationAddresses: ["168.63.129.16"],
 *           destinationPorts: ["53"],
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const FirewallPolicyRuleCollectionGroup =
  Resource<FirewallPolicyRuleCollectionGroup>(
    "Azure.Network.FirewallPolicyRuleCollectionGroup",
  );

export const FirewallPolicyRuleCollectionGroupProvider = () =>
  Provider.succeed(
    FirewallPolicyRuleCollectionGroup,
    networkProvider<FirewallPolicyRuleCollectionGroup>()({
      label: "firewall policy rule collection group",
      nameAttr: "ruleCollectionGroupName",
      parents: ["firewallPolicy"],
      tracked: false,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetFirewallPolicyRuleCollectionGroup({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            firewallPolicyName: path.firewallPolicy!,
            ruleCollectionGroupName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.FirewallPolicyRuleCollectionGroupsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          firewallPolicyName: path.firewallPolicy!,
          ruleCollectionGroupName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteFirewallPolicyRuleCollectionGroup({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          firewallPolicyName: path.firewallPolicy!,
          ruleCollectionGroupName: path.name,
        }),
      ownerTags: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetFirewallPolicy({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            firewallPolicyName: path.firewallPolicy!,
          }),
        ).pipe(Effect.map((policy) => policy?.tags)),
      body: (news) => ({
        properties: {
          priority: news.priority,
          ruleCollections: news.ruleCollections ?? [],
        },
      }),
      toAttrs: (path, observed) => ({
        ruleCollectionGroupName: path.name,
        ruleCollectionGroupId: observed.id ?? "",
        firewallPolicy: path.firewallPolicy!,
        resourceGroup: path.resourceGroup,
        priority: observed.properties?.priority,
        ruleCollectionNames: (
          observed.properties?.ruleCollections ?? []
        ).flatMap((collection) =>
          collection.name === undefined ? [] : [collection.name],
        ),
      }),
      dependsOn: ["Azure.Network.FirewallPolicy"],
    }),
  );
