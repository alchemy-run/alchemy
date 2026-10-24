import * as network from "@distilled.cloud/azure/network";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { ref } from "./common.ts";
import { networkProvider } from "./generic.ts";

export interface FirewallPolicyDraftProps {
  /**
   * Resource group of the firewall policy. Changing it replaces the draft.
   */
  resourceGroup: string;
  /** Name of the parent firewall policy. Changing it replaces the draft. */
  firewallPolicy: string;
  /** ARM ID of a parent policy whose rules the drafted policy inherits. */
  basePolicyId?: string;
  /**
   * Threat-intelligence mode of the drafted policy.
   * @default "Alert"
   */
  threatIntelMode?: "Alert" | "Deny" | "Off";
  /** IPs and FQDNs exempt from threat intelligence. */
  threatIntelWhitelist?: network.FirewallPolicyThreatIntelWhitelist;
  /** DNS proxy and custom DNS server settings. */
  dnsSettings?: network.DnsSettings;
  /** SNAT private ranges. */
  snat?: network.FirewallPolicySNAT;
  /** SQL redirect settings. */
  sql?: network.FirewallPolicySQL;
  /** Policy analytics (insights) settings. */
  insights?: network.FirewallPolicyInsights;
  /** Explicit proxy settings. */
  explicitProxy?: network.ExplicitProxy;
  /** IDPS settings (Premium only). */
  intrusionDetection?: network.FirewallPolicyIntrusionDetection;
}

export interface FirewallPolicyDraft extends Resource<
  "Azure.Network.FirewallPolicyDraft",
  FirewallPolicyDraftProps,
  {
    /** Name of the draft. Azure names every policy draft `default`. */
    draftName: string;
    /** ARM resource ID of the draft. */
    draftId: string;
    /** Name of the parent firewall policy. */
    firewallPolicy: string;
    /** Resource group of the firewall policy. */
    resourceGroup: string;
    /** Threat-intelligence mode of the drafted policy. */
    threatIntelMode: string | undefined;
    /** ARM ID of the drafted parent policy. */
    basePolicyId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The draft of an Azure Firewall policy
 * (`Microsoft.Network/firewallPolicies/firewallPolicyDrafts`) — staged
 * policy settings that do not affect traffic until someone deploys the
 * draft. A policy holds at most one draft, always named `default`. Stage
 * rule changes with {@link FirewallPolicyRuleCollectionGroupDraft}.
 * Deploying a draft overwrites the live policy and removes the draft: the
 * next deploy of this resource recreates it. The draft carries no tags:
 * ownership follows the parent policy.
 *
 * :::caution
 * Changing `firewallPolicy` or `resourceGroup` replaces the draft.
 * :::
 *
 * @see https://learn.microsoft.com/azure/firewall/draft-deploy
 *
 * ### Staging Policy Changes
 * **Example:** Stage a switch to deny known-malicious traffic
 * ```typescript
 * const policy = yield* Azure.Network.FirewallPolicy("egress", {
 *   threatIntelMode: "Alert",
 * });
 * yield* Azure.Network.FirewallPolicyDraft("egress-draft", {
 *   firewallPolicy: policy.firewallPolicyName,
 *   threatIntelMode: "Deny",
 * });
 * ```
 *
 * @resource
 */
export const FirewallPolicyDraft = GroupedResource<FirewallPolicyDraft>(
  "Azure.Network.FirewallPolicyDraft",
);

export const FirewallPolicyDraftProvider = () =>
  Provider.succeed(
    FirewallPolicyDraft,
    networkProvider<FirewallPolicyDraft>()({
      label: "firewall policy draft",
      nameAttr: "draftName",
      parents: ["firewallPolicy"],
      tracked: false,
      physicalName: () => Effect.succeed("default"),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetFirewallPolicyDraft({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            firewallPolicyName: path.firewallPolicy!,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.FirewallPolicyDraftsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          firewallPolicyName: path.firewallPolicy!,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteFirewallPolicyDraft({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          firewallPolicyName: path.firewallPolicy!,
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
          basePolicy: ref(news.basePolicyId),
          threatIntelMode: news.threatIntelMode ?? "Alert",
          threatIntelWhitelist: news.threatIntelWhitelist,
          dnsSettings: news.dnsSettings,
          snat: news.snat,
          sql: news.sql,
          insights: news.insights,
          explicitProxy: news.explicitProxy,
          intrusionDetection: news.intrusionDetection,
        },
      }),
      toAttrs: (path, observed) => ({
        draftName: path.name,
        draftId: observed.id ?? "",
        firewallPolicy: path.firewallPolicy!,
        resourceGroup: path.resourceGroup,
        threatIntelMode: observed.properties?.threatIntelMode,
        basePolicyId: observed.properties?.basePolicy?.id,
      }),
      dependsOn: ["Azure.Network.FirewallPolicy"],
    }),
  );
