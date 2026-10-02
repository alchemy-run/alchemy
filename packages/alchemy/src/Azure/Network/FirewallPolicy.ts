import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { ref } from "./common.ts";
import { idsOf, networkProvider } from "./generic.ts";

export interface FirewallPolicyProps {
  /** Resource group of the policy. Changing it replaces the policy. */
  resourceGroup: string;
  /**
   * Name of the policy: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the policy.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the policy.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Policy tier. Must match the tier of the firewalls that use it.
   * @default "Standard"
   */
  tier?: "Basic" | "Standard" | "Premium";
  /** ARM ID of a parent policy whose rules this policy inherits. */
  basePolicyId?: string;
  /**
   * Threat-intelligence mode.
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
  /** TLS inspection CA certificate (Premium only). */
  transportSecurity?: network.FirewallPolicyTransportSecurity;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface FirewallPolicy extends Resource<
  "Azure.Network.FirewallPolicy",
  FirewallPolicyProps,
  {
    /** Name of the policy. */
    firewallPolicyName: string;
    /** ARM resource ID of the policy. */
    firewallPolicyId: string;
    /** Resource group of the policy. */
    resourceGroup: string;
    /** Location of the policy. */
    location: string;
    /** Policy tier. */
    tier: string | undefined;
    /** Threat-intelligence mode. */
    threatIntelMode: string | undefined;
    /** ARM ID of the parent policy. */
    basePolicyId: string | undefined;
    /** IDs of the firewalls using this policy. */
    firewallIds: string[];
    /** IDs of the policies that inherit from this one. */
    childPolicyIds: string[];
    /** IDs of the policy's rule collection groups. */
    ruleCollectionGroupIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Firewall policy — the rule collection groups, threat
 * intelligence, DNS, and IDPS settings shared by one or more Azure
 * Firewalls. Attach rules with
 * {@link FirewallPolicyRuleCollectionGroup}. A policy is free unless it is
 * associated with firewalls in several regions.
 *
 * @see https://learn.microsoft.com/azure/firewall-manager/policy-overview
 *
 * ### Creating a Policy
 * **Example:** Standard policy that denies known-malicious traffic
 * ```typescript
 * const policy = yield* Azure.Network.FirewallPolicy("egress", {
 *   resourceGroup: group.resourceGroupName,
 *   threatIntelMode: "Deny",
 * });
 * ```
 *
 * **Example:** DNS proxy
 * ```typescript
 * const policy = yield* Azure.Network.FirewallPolicy("dns", {
 *   resourceGroup: group.resourceGroupName,
 *   dnsSettings: { enableProxy: true },
 * });
 * ```
 *
 * @resource
 */
export const FirewallPolicy = Resource<FirewallPolicy>(
  "Azure.Network.FirewallPolicy",
);

export const FirewallPolicyProvider = () =>
  Provider.succeed(
    FirewallPolicy,
    networkProvider<FirewallPolicy>()({
      label: "firewall policy",
      nameAttr: "firewallPolicyName",
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetFirewallPolicy({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            firewallPolicyName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.FirewallPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          firewallPolicyName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteFirewallPolicy({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          firewallPolicyName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateFirewallPolicyTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          firewallPolicyName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListFirewallPolicyAll({ subscriptionId }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          sku: { tier: news.tier ?? "Standard" },
          basePolicy: ref(news.basePolicyId),
          threatIntelMode: news.threatIntelMode ?? "Alert",
          threatIntelWhitelist: news.threatIntelWhitelist,
          dnsSettings: news.dnsSettings,
          snat: news.snat,
          sql: news.sql,
          insights: news.insights,
          explicitProxy: news.explicitProxy,
          intrusionDetection: news.intrusionDetection,
          transportSecurity: news.transportSecurity,
        },
      }),
      toAttrs: (path, observed) => ({
        firewallPolicyName: path.name,
        firewallPolicyId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        tier: observed.properties?.sku?.tier,
        threatIntelMode: observed.properties?.threatIntelMode,
        basePolicyId: observed.properties?.basePolicy?.id,
        firewallIds: idsOf(observed.properties?.firewalls),
        childPolicyIds: idsOf(observed.properties?.childPolicies),
        ruleCollectionGroupIds: idsOf(
          observed.properties?.ruleCollectionGroups,
        ),
        tags: userTags(observed.tags),
      }),
    }),
  );
