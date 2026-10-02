import * as eventhub from "@distilled.cloud/azure/eventhub";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { namespaceOwnedByStage } from "./Common.ts";

export interface NetworkRuleSetIpRule {
  /** IPv4 address or CIDR range, e.g. `203.0.113.0/24`. */
  ipMask: string;
  /**
   * Action for matching traffic (only `Allow` is supported).
   * @default "Allow"
   */
  action?: "Allow";
}

export interface NetworkRuleSetVirtualNetworkRule {
  /**
   * ARM ID of a subnet with the `Microsoft.EventHub` service endpoint
   * enabled.
   */
  subnetId: string;
  /**
   * Accept the rule even if the subnet has no `Microsoft.EventHub` service
   * endpoint yet.
   * @default false
   */
  ignoreMissingVnetServiceEndpoint?: boolean;
}

export interface NetworkRuleSetProps {
  /** Resource group of the namespace. Changing it replaces the rule set. */
  resourceGroup: string;
  /** Namespace the firewall applies to. Changing it replaces the rule set. */
  namespace: string;
  /**
   * What happens to traffic that matches no rule. Use `Deny` with `ipRules`
   * or `virtualNetworkRules` to restrict access.
   * @default "Allow"
   */
  defaultAction?: "Allow" | "Deny";
  /**
   * Whether the public endpoint accepts traffic. Shared with the namespace's
   * `publicNetworkAccess`.
   * @default the namespace's current value
   */
  publicNetworkAccess?: "Enabled" | "Disabled" | "SecuredByPerimeter";
  /**
   * Let trusted Microsoft services bypass the firewall.
   * @default false
   */
  trustedServiceAccessEnabled?: boolean;
  /** IP addresses or ranges that may connect. */
  ipRules?: NetworkRuleSetIpRule[];
  /** Subnets that may connect. */
  virtualNetworkRules?: NetworkRuleSetVirtualNetworkRule[];
}

export interface NetworkRuleSet extends Resource<
  "Azure.EventHub.NetworkRuleSet",
  NetworkRuleSetProps,
  {
    /** ARM resource ID of the rule set (`.../networkRuleSets/default`). */
    networkRuleSetId: string;
    /** Namespace the firewall applies to. */
    namespace: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Action for traffic that matches no rule. */
    defaultAction: string | undefined;
    /** Whether the public endpoint accepts traffic. */
    publicNetworkAccess: string | undefined;
    /** Whether trusted Microsoft services bypass the firewall. */
    trustedServiceAccessEnabled: boolean | undefined;
    /** Allowed IP addresses or ranges. */
    ipRules: string[];
    /** Allowed subnet IDs. */
    virtualNetworkRules: string[];
  },
  never,
  Providers
> {}

/**
 * The IP firewall and virtual network rules of an Event Hubs namespace.
 *
 * Every namespace has exactly one rule set (`default`), so this resource
 * configures it rather than creating it; deleting the resource resets the
 * firewall to allow all traffic. IP and virtual network rules need a
 * `Standard` (or higher) namespace.
 *
 * @see https://learn.microsoft.com/azure/event-hubs/network-security
 *
 * ### Restricting Access
 * **Example:** Allow only one office range
 * ```typescript
 * yield* Azure.EventHub.NetworkRuleSet("firewall", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   defaultAction: "Deny",
 *   ipRules: [{ ipMask: "203.0.113.0/24" }],
 * });
 * ```
 *
 * **Example:** Allow a subnet and trusted Azure services
 * ```typescript
 * yield* Azure.EventHub.NetworkRuleSet("firewall", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   defaultAction: "Deny",
 *   trustedServiceAccessEnabled: true,
 *   virtualNetworkRules: [{ subnetId: subnet.subnetId }],
 * });
 * ```
 *
 * @resource
 */
export const NetworkRuleSet = Resource<NetworkRuleSet>(
  "Azure.EventHub.NetworkRuleSet",
);

const getRuleSet = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
) =>
  orUndefinedIfNotFound(
    eventhub.GetNamespaceNetworkRuleSet({
      subscriptionId,
      resourceGroupName,
      namespaceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespace: string,
  ruleSet: eventhub.GetNamespaceNetworkRuleSetResponse,
): NetworkRuleSet["Attributes"] => ({
  networkRuleSetId: ruleSet.id ?? "",
  namespace,
  resourceGroup,
  defaultAction: ruleSet.properties?.defaultAction,
  publicNetworkAccess: ruleSet.properties?.publicNetworkAccess,
  trustedServiceAccessEnabled: ruleSet.properties?.trustedServiceAccessEnabled,
  ipRules: (ruleSet.properties?.ipRules ?? []).flatMap((rule) =>
    rule.ipMask ? [rule.ipMask] : [],
  ),
  virtualNetworkRules: (ruleSet.properties?.virtualNetworkRules ?? []).flatMap(
    (rule) => (rule.subnet?.id ? [rule.subnet.id] : []),
  ),
});

const ipKey = (rules: ReadonlyArray<eventhub.NWRuleSetIpRules>) =>
  rules
    .map((rule) => `${rule.ipMask}|${rule.action ?? "Allow"}`.toLowerCase())
    .sort()
    .join(",");

const vnetKey = (rules: ReadonlyArray<eventhub.NWRuleSetVirtualNetworkRules>) =>
  rules
    .map((rule) =>
      `${rule.subnet?.id}|${rule.ignoreMissingVnetServiceEndpoint ?? false}`.toLowerCase(),
    )
    .sort()
    .join(",");

const sameRuleSet = (
  observed: eventhub.NetworkRuleSetProperties,
  desired: eventhub.NetworkRuleSetProperties,
) =>
  (observed.defaultAction ?? "Allow") === desired.defaultAction &&
  observed.publicNetworkAccess === desired.publicNetworkAccess &&
  (observed.trustedServiceAccessEnabled ?? false) ===
    desired.trustedServiceAccessEnabled &&
  ipKey(observed.ipRules ?? []) === ipKey(desired.ipRules ?? []) &&
  vnetKey(observed.virtualNetworkRules ?? []) ===
    vnetKey(desired.virtualNetworkRules ?? []);

export const NetworkRuleSetProvider = () =>
  Provider.succeed(NetworkRuleSet, {
    stables: ["networkRuleSetId", "namespace", "resourceGroup"],

    // Every namespace has exactly one rule set; nothing to enumerate.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.namespace.toLowerCase() !== output.namespace.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const namespace = output?.namespace ?? olds?.namespace;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its namespace.
      if (resourceGroup === undefined || namespace === undefined) {
        return undefined;
      }
      const observed = yield* getRuleSet(
        subscriptionId,
        resourceGroup,
        namespace,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, observed);
      return (yield* namespaceOwnedByStage(
        subscriptionId,
        resourceGroup,
        namespace,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventHub");
      const { resourceGroup, namespace } = news;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        namespaceName: namespace,
      };

      // Observe. The `default` rule set always exists with its namespace.
      const observed = yield* getRuleSet(
        subscriptionId,
        resourceGroup,
        namespace,
      );
      const current = observed?.properties ?? {};
      const desired: eventhub.NetworkRuleSetProperties = {
        defaultAction: news.defaultAction ?? "Allow",
        publicNetworkAccess:
          news.publicNetworkAccess ?? current.publicNetworkAccess ?? "Enabled",
        trustedServiceAccessEnabled: news.trustedServiceAccessEnabled ?? false,
        ipRules: (news.ipRules ?? []).map((rule) => ({
          ipMask: rule.ipMask,
          action: rule.action ?? "Allow",
        })),
        virtualNetworkRules: (news.virtualNetworkRules ?? []).map((rule) => ({
          subnet: { id: rule.subnetId },
          ignoreMissingVnetServiceEndpoint:
            rule.ignoreMissingVnetServiceEndpoint ?? false,
        })),
      };

      // Sync: the PUT replaces the whole rule set; skip it when it matches.
      if (observed === undefined || !sameRuleSet(current, desired)) {
        const written = yield* eventhub.NamespacesCreateOrUpdateNetworkRuleSet({
          ...where,
          properties: desired,
        });
        return toAttrs(resourceGroup, namespace, written);
      }
      return toAttrs(resourceGroup, namespace, observed);
    }),

    // There is no DELETE: reset the firewall to allow all traffic.
    delete: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const observed = yield* getRuleSet(
        subscriptionId,
        output.resourceGroup,
        output.namespace,
      );
      // The namespace (and with it the rule set) is already gone.
      if (observed === undefined) return;
      yield* ignoreNotFound(
        eventhub.NamespacesCreateOrUpdateNetworkRuleSet({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespace,
          properties: {
            defaultAction: "Allow",
            publicNetworkAccess:
              olds?.publicNetworkAccess !== undefined
                ? "Enabled"
                : observed.properties?.publicNetworkAccess,
            trustedServiceAccessEnabled: false,
            ipRules: [],
            virtualNetworkRules: [],
          },
        }),
      );
    }),

    nuke: { singleton: true },
  });
