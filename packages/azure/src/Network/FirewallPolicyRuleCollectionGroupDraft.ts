import * as network from "@distilled.cloud/azure/network";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { networkProvider } from "./generic.ts";

export interface FirewallPolicyRuleCollectionGroupDraftProps {
  /**
   * Resource group of the firewall policy. Changing it replaces the draft.
   */
  resourceGroup: string;
  /** Name of the parent firewall policy. Changing it replaces the draft. */
  firewallPolicy: string;
  /**
   * Name of the live rule collection group this draft stages changes for.
   * The group must already exist. Changing it replaces the draft.
   */
  ruleCollectionGroup: string;
  /** Staged priority (100-65000); lower runs first. */
  priority: number;
  /**
   * Staged rule collections, in the same shape as
   * {@link FirewallPolicyRuleCollectionGroupProps.ruleCollections}.
   */
  ruleCollections?: network.FirewallPolicyRuleCollection[];
}

export interface FirewallPolicyRuleCollectionGroupDraft extends Resource<
  "Azure.Network.FirewallPolicyRuleCollectionGroupDraft",
  FirewallPolicyRuleCollectionGroupDraftProps,
  {
    /** Name of the draft. Azure names every rule collection group draft `default`. */
    draftName: string;
    /** ARM resource ID of the draft. */
    draftId: string;
    /** Name of the parent firewall policy. */
    firewallPolicy: string;
    /** Name of the live rule collection group. */
    ruleCollectionGroup: string;
    /** Resource group of the firewall policy. */
    resourceGroup: string;
    /** Staged priority. */
    priority: number | undefined;
    /** Names of the staged rule collections. */
    ruleCollectionNames: string[];
  },
  never,
  Providers
> {}

/**
 * The draft of a rule collection group in an Azure Firewall policy
 * (`Microsoft.Network/firewallPolicies/ruleCollectionGroups/ruleCollectionGroupDrafts`)
 * — staged rule collections that do not affect traffic until someone
 * deploys the policy draft. It belongs to the policy's
 * {@link FirewallPolicyDraft}, which must exist first, and to an existing
 * {@link FirewallPolicyRuleCollectionGroup}: a draft cannot create a new
 * group. Deploying the policy draft removes this draft: the next deploy of
 * this resource recreates it. The draft carries no tags: ownership follows
 * the parent policy.
 *
 * :::caution
 * Changing `firewallPolicy`, `ruleCollectionGroup`, or `resourceGroup`
 * replaces the draft.
 * :::
 *
 * @see https://learn.microsoft.com/azure/firewall/draft-deploy
 *
 * ### Staging Rule Changes
 * **Example:** Stage a new DNS rule in an existing group
 * ```typescript
 * const draft = yield* Azure.Network.FirewallPolicyDraft("egress-draft", {
 *   firewallPolicy: policy.firewallPolicyName,
 * });
 * yield* Azure.Network.FirewallPolicyRuleCollectionGroupDraft("rules-draft", {
 *   firewallPolicy: draft.firewallPolicy,
 *   ruleCollectionGroup: rules.ruleCollectionGroupName,
 *   priority: 200,
 *   ruleCollections: [
 *     {
 *       ruleCollectionType: "FirewallPolicyFilterRuleCollection",
 *       name: "allow-dns",
 *       priority: 100,
 *       action: { type: "Allow" },
 *       rules: [
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
export const FirewallPolicyRuleCollectionGroupDraft =
  GroupedResource<FirewallPolicyRuleCollectionGroupDraft>(
    "Azure.Network.FirewallPolicyRuleCollectionGroupDraft",
  );

export const FirewallPolicyRuleCollectionGroupDraftProvider = () =>
  Provider.succeed(
    FirewallPolicyRuleCollectionGroupDraft,
    networkProvider<FirewallPolicyRuleCollectionGroupDraft>()({
      label: "firewall policy rule collection group draft",
      nameAttr: "draftName",
      parents: ["firewallPolicy", "ruleCollectionGroup"],
      tracked: false,
      physicalName: () => Effect.succeed("default"),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetFirewallPolicyRuleCollectionGroupDraft({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            firewallPolicyName: path.firewallPolicy!,
            ruleCollectionGroupName: path.ruleCollectionGroup!,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.FirewallPolicyRuleCollectionGroupDraftsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          firewallPolicyName: path.firewallPolicy!,
          ruleCollectionGroupName: path.ruleCollectionGroup!,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteFirewallPolicyRuleCollectionGroupDraft({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          firewallPolicyName: path.firewallPolicy!,
          ruleCollectionGroupName: path.ruleCollectionGroup!,
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
        draftName: path.name,
        draftId: observed.id ?? "",
        firewallPolicy: path.firewallPolicy!,
        ruleCollectionGroup: path.ruleCollectionGroup!,
        resourceGroup: path.resourceGroup,
        priority: observed.properties?.priority,
        ruleCollectionNames: (observed.properties?.ruleCollections ?? []).flatMap((collection) =>
          collection.name === undefined ? [] : [collection.name],
        ),
      }),
      dependsOn: [
        "Azure.Network.FirewallPolicyDraft",
        "Azure.Network.FirewallPolicyRuleCollectionGroup",
        "Azure.Network.FirewallPolicy",
      ],
    }),
  );
