import * as servicebus from "@distilled.cloud/azure/servicebus";
import * as Effect from "effect/Effect";
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
import { sameName } from "./internal.ts";

export interface NetworkRuleSetIpRule {
  /** IPv4 address or CIDR range, e.g. `203.0.113.0/24`. */
  ipMask: string;
}

export interface NetworkRuleSetVirtualNetworkRule {
  /** ARM ID of the subnet allowed to reach the namespace. */
  subnetId: string;
  /**
   * Accept the rule even if the subnet lacks the `Microsoft.ServiceBus`
   * service endpoint.
   * @default false
   */
  ignoreMissingVnetServiceEndpoint?: boolean;
}

export interface NetworkRuleSetProps {
  /** Resource group of the namespace. Changing it replaces the rule set. */
  resourceGroup: string;
  /** Namespace the rule set applies to. Changing it replaces the rule set. */
  namespace: string;
  /**
   * Action for traffic that matches no rule.
   * @default "Allow"
   */
  defaultAction?: "Allow" | "Deny";
  /**
   * Whether the public endpoint accepts traffic at all.
   * @default "Enabled"
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Let trusted Microsoft services bypass the firewall.
   * @default false
   */
  trustedServiceAccessEnabled?: boolean;
  /** IP ranges allowed when `defaultAction` is `Deny`. */
  ipRules?: NetworkRuleSetIpRule[];
  /** Subnets allowed when `defaultAction` is `Deny` (Premium only). */
  virtualNetworkRules?: NetworkRuleSetVirtualNetworkRule[];
}

export interface NetworkRuleSet extends Resource<
  "Azure.ServiceBus.NetworkRuleSet",
  NetworkRuleSetProps,
  {
    /** ARM resource ID of the rule set (`.../networkRuleSets/default`). */
    networkRuleSetId: string;
    /** Namespace the rule set applies to. */
    namespaceName: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Action for traffic that matches no rule. */
    defaultAction: string;
    /** Whether the public endpoint accepts traffic. */
    publicNetworkAccess: string;
    /** Whether trusted Microsoft services bypass the firewall. */
    trustedServiceAccessEnabled: boolean;
    /** Allowed IP ranges. */
    ipRules: string[];
    /** Allowed subnet IDs. */
    virtualNetworkRules: string[];
  },
  never,
  Providers
> {}

/**
 * The network firewall of a Service Bus namespace (the singleton
 * `networkRuleSets/default`): default action, public access, trusted
 * services, IP rules, and (Premium) virtual network rules.
 *
 * Every namespace already has a rule set, so this resource converges the
 * existing one instead of creating it; destroying it resets the namespace
 * to allow all traffic.
 *
 * @see https://learn.microsoft.com/azure/service-bus-messaging/service-bus-ip-filtering
 *
 * ### Restricting Access
 * **Example:** Allow only an office IP range
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.ServiceBus.NetworkRuleSet("bus-firewall", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 *   defaultAction: "Deny",
 *   ipRules: [{ ipMask: "203.0.113.0/24" }],
 * });
 * ```
 *
 * **Example:** Disable the public endpoint, allow trusted services
 * ```typescript
 * yield* Azure.ServiceBus.NetworkRuleSet("bus-firewall", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 *   publicNetworkAccess: "Disabled",
 *   trustedServiceAccessEnabled: true,
 * });
 * ```
 *
 * @resource
 */
export const NetworkRuleSet = Resource<NetworkRuleSet>(
  "Azure.ServiceBus.NetworkRuleSet",
);

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  namespaceName: string;
}

const getRuleSet = (where: Where) =>
  orUndefinedIfNotFound(servicebus.GetNamespaceNetworkRuleSet(where));

/** Azure normalizes single IPs to `/32`; compare without the suffix. */
const normalizeMask = (mask: string | undefined) =>
  (mask ?? "").replace(/\/32$/, "").toLowerCase();

const sortedJoin = (values: ReadonlyArray<string>) =>
  [...values].sort().join(",");

const toAttrs = (
  where: Where,
  ruleSet: servicebus.GetNamespaceNetworkRuleSetResponse,
): NetworkRuleSet["Attributes"] => {
  const props = ruleSet.properties ?? {};
  return {
    networkRuleSetId: ruleSet.id ?? "",
    namespaceName: where.namespaceName,
    resourceGroup: where.resourceGroupName,
    defaultAction: props.defaultAction ?? "Allow",
    publicNetworkAccess: props.publicNetworkAccess ?? "Enabled",
    trustedServiceAccessEnabled: props.trustedServiceAccessEnabled ?? false,
    ipRules: (props.ipRules ?? []).flatMap((rule) =>
      rule.ipMask ? [rule.ipMask] : [],
    ),
    virtualNetworkRules: (props.virtualNetworkRules ?? []).flatMap((rule) =>
      rule.subnet?.id ? [rule.subnet.id] : [],
    ),
  };
};

const toDesired = (
  props: NetworkRuleSetProps,
): servicebus.NetworkRuleSetProperties => ({
  defaultAction: props.defaultAction ?? "Allow",
  publicNetworkAccess: props.publicNetworkAccess ?? "Enabled",
  trustedServiceAccessEnabled: props.trustedServiceAccessEnabled ?? false,
  ipRules: (props.ipRules ?? []).map((rule) => ({
    ipMask: rule.ipMask,
    action: "Allow",
  })),
  virtualNetworkRules: (props.virtualNetworkRules ?? []).map((rule) => ({
    subnet: { id: rule.subnetId },
    ignoreMissingVnetServiceEndpoint:
      rule.ignoreMissingVnetServiceEndpoint ?? false,
  })),
});

const ruleSetDiffers = (
  observed: servicebus.NetworkRuleSetProperties | undefined,
  desired: servicebus.NetworkRuleSetProperties,
) =>
  !sameName(observed?.defaultAction ?? "Allow", desired.defaultAction) ||
  !sameName(
    observed?.publicNetworkAccess ?? "Enabled",
    desired.publicNetworkAccess,
  ) ||
  (observed?.trustedServiceAccessEnabled ?? false) !==
    desired.trustedServiceAccessEnabled ||
  sortedJoin((observed?.ipRules ?? []).map((r) => normalizeMask(r.ipMask))) !==
    sortedJoin((desired.ipRules ?? []).map((r) => normalizeMask(r.ipMask))) ||
  sortedJoin(
    (observed?.virtualNetworkRules ?? []).map(
      (r) =>
        `${r.subnet?.id?.toLowerCase()}|${r.ignoreMissingVnetServiceEndpoint ?? false}`,
    ),
  ) !==
    sortedJoin(
      (desired.virtualNetworkRules ?? []).map(
        (r) =>
          `${r.subnet?.id?.toLowerCase()}|${r.ignoreMissingVnetServiceEndpoint ?? false}`,
      ),
    );

const DEFAULTS = toDesired({ resourceGroup: "", namespace: "" });

export const NetworkRuleSetProvider = () =>
  Provider.succeed(NetworkRuleSet, {
    stables: ["networkRuleSetId", "namespaceName", "resourceGroup"],

    // The rule set is part of its namespace; nothing to nuke separately.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    // Every namespace has exactly one rule set; declaring it means managing
    // it, so an existing rule set is always adopted (never `Unowned`).
    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const namespaceName = output?.namespaceName ?? olds?.namespace;
      if (resourceGroupName === undefined || namespaceName === undefined) {
        return undefined;
      }
      const where = { subscriptionId, resourceGroupName, namespaceName };
      const observed = yield* getRuleSet(where);
      return observed === undefined ? undefined : toAttrs(where, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceBus");
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        namespaceName: news.namespace,
      };
      const desired = toDesired(news);

      // Observe, then PUT the full rule set only when it differs.
      let observed = yield* getRuleSet(where);
      if (
        observed === undefined ||
        ruleSetDiffers(observed.properties, desired)
      ) {
        yield* servicebus.NamespacesCreateOrUpdateNetworkRuleSet({
          ...where,
          properties: desired,
        });
        observed = yield* servicebus.GetNamespaceNetworkRuleSet(where);
      }
      return toAttrs(where, observed);
    }),

    // There is no DELETE: reset the rule set to allow all traffic. A
    // namespace that is already gone took its rule set with it.
    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        namespaceName: output.namespaceName,
      };
      const observed = yield* getRuleSet(where);
      if (
        observed === undefined ||
        !ruleSetDiffers(observed.properties, DEFAULTS)
      ) {
        return;
      }
      yield* ignoreNotFound(
        servicebus.NamespacesCreateOrUpdateNetworkRuleSet({
          ...where,
          properties: DEFAULTS,
        }),
      );
    }),

    nuke: { dependsOn: ["Azure.ServiceBus.Namespace"] },
  });
