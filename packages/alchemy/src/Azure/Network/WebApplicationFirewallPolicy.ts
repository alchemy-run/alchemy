import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { idsOf, networkProvider } from "./generic.ts";

export interface WebApplicationFirewallPolicyProps {
  /** Resource group of the policy. Changing it replaces the policy. */
  resourceGroup: string;
  /**
   * Name of the policy: up to 128 letters, digits, `_`, `.`, and `-`. If
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
   * Policy settings: `state` (`Enabled`/`Disabled`), `mode`
   * (`Prevention`/`Detection`), request body inspection and limits.
   * @default { state: "Enabled", mode: "Detection" }
   */
  policySettings?: network.PolicySettings;
  /**
   * Managed rule sets, exclusions, and exceptions.
   * @default the OWASP 3.2 rule set
   */
  managedRules?: network.ManagedRulesDefinitionInput;
  /** Custom rules, evaluated before managed rules in priority order. */
  customRules?: network.WebApplicationFirewallCustomRuleInput[];
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface WebApplicationFirewallPolicy extends Resource<
  "Azure.Network.WebApplicationFirewallPolicy",
  WebApplicationFirewallPolicyProps,
  {
    /** Name of the policy. */
    policyName: string;
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Resource group of the policy. */
    resourceGroup: string;
    /** Location of the policy. */
    location: string;
    /** Policy state (`Enabled`/`Disabled`). */
    state: string | undefined;
    /** Policy mode (`Prevention`/`Detection`). */
    mode: string | undefined;
    /** Names of the custom rules. */
    customRuleNames: string[];
    /** IDs of the application gateways using the policy. */
    applicationGatewayIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Web Application Firewall policy for Application Gateway —
 * OWASP managed rule sets plus custom match/rate-limit rules. Associate it
 * with an Application Gateway (WAF_v2), listener, or path. The policy
 * itself is free.
 *
 * @see https://learn.microsoft.com/azure/web-application-firewall/ag/policy-overview
 *
 * ### Creating a Policy
 * **Example:** OWASP 3.2 in prevention mode
 * ```typescript
 * const waf = yield* Azure.Network.WebApplicationFirewallPolicy("waf", {
 *   resourceGroup: group.resourceGroupName,
 *   policySettings: { state: "Enabled", mode: "Prevention" },
 * });
 * ```
 *
 * **Example:** Block a country with a custom rule
 * ```typescript
 * yield* Azure.Network.WebApplicationFirewallPolicy("geo", {
 *   resourceGroup: group.resourceGroupName,
 *   customRules: [
 *     {
 *       name: "blockgeo",
 *       priority: 10,
 *       ruleType: "MatchRule",
 *       action: "Block",
 *       matchConditions: [
 *         {
 *           matchVariables: [{ variableName: "RemoteAddr" }],
 *           operator: "GeoMatch",
 *           matchValues: ["XX"],
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const WebApplicationFirewallPolicy =
  Resource<WebApplicationFirewallPolicy>(
    "Azure.Network.WebApplicationFirewallPolicy",
  );

const defaultManagedRules: network.ManagedRulesDefinitionInput = {
  managedRuleSets: [{ ruleSetType: "OWASP", ruleSetVersion: "3.2" }],
};

export const WebApplicationFirewallPolicyProvider = () =>
  Provider.succeed(
    WebApplicationFirewallPolicy,
    networkProvider<WebApplicationFirewallPolicy>()({
      label: "WAF policy",
      nameAttr: "policyName",
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetWebApplicationFirewallPolicy({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            policyName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.WebApplicationFirewallPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          policyName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteWebApplicationFirewallPolicy({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          policyName: path.name,
        }),
      listAll: (subscriptionId) =>
        network.ListWebApplicationFirewallPolicyAll({ subscriptionId }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          policySettings: news.policySettings ?? {
            state: "Enabled",
            mode: "Detection",
          },
          managedRules: news.managedRules ?? defaultManagedRules,
          customRules: news.customRules ?? [],
        },
      }),
      toAttrs: (path, observed) => ({
        policyName: path.name,
        policyId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        state: observed.properties?.policySettings?.state,
        mode: observed.properties?.policySettings?.mode,
        customRuleNames: (observed.properties?.customRules ?? []).flatMap(
          (rule) => (rule.name === undefined ? [] : [rule.name]),
        ),
        applicationGatewayIds: idsOf(observed.properties?.applicationGateways),
        tags: userTags(observed.tags),
      }),
    }),
  );
