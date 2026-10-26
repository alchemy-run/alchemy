import * as servicebus from "@distilled.cloud/azure/servicebus";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { sameName } from "./internal.ts";

/** One IPv4 range allowed through the namespace firewall. */
export interface NetworkRuleSetIpRule {
  /** IPv4 address or CIDR range, e.g. `203.0.113.0/24` or `198.51.100.7`. */
  ipMask: string;
}

/** One subnet allowed through the namespace firewall (Premium only). */
export interface NetworkRuleSetVirtualNetworkRule {
  /**
   * ARM resource ID of the subnet allowed to reach the namespace, e.g.
   * `subnet.subnetId` of an `Azure.Network.Subnet`.
   */
  subnetId: string;
  /**
   * Accept the rule even if the subnet lacks the `Microsoft.ServiceBus`
   * service endpoint.
   * @default false
   */
  ignoreMissingVnetServiceEndpoint?: boolean;
}

export interface NetworkRuleSetProps {
  /**
   * Resource group of the namespace.
   *
   * :::caution
   * Changing it replaces the rule set.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the namespace the rule set applies to, e.g. `bus.namespaceName`
   * of an `Azure.ServiceBus.Namespace`.
   *
   * :::caution
   * Changing it replaces the rule set.
   * :::
   */
  namespace: string;
  /**
   * Action for traffic that matches no rule: `Allow` or `Deny`. With
   * `Deny`, only `ipRules` and `virtualNetworkRules` get through.
   * @default "Allow"
   */
  defaultAction?: "Allow" | "Deny";
  /**
   * Whether the public endpoint accepts traffic at all: `Enabled` or
   * `Disabled`. With `Disabled`, clients need a private endpoint.
   * @default "Enabled"
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Let trusted Microsoft services (e.g. Event Grid, Azure Monitor) bypass
   * the firewall.
   * @default false
   */
  trustedServiceAccessEnabled?: boolean;
  /**
   * IPv4 ranges allowed when `defaultAction` is `Deny`.
   * @default []
   */
  ipRules?: NetworkRuleSetIpRule[];
  /**
   * Subnets allowed when `defaultAction` is `Deny`. Premium only.
   * @default []
   */
  virtualNetworkRules?: NetworkRuleSetVirtualNetworkRule[];
}

export interface NetworkRuleSet extends Resource<
  "Azure.ServiceBus.NetworkRuleSet",
  NetworkRuleSetProps,
  {
    /** ARM resource ID of the rule set (`.../networkRuleSets/default`). */
    networkRuleSetId: string;
    /** Name of the namespace the rule set applies to. */
    namespaceName: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Action for traffic that matches no rule: `Allow` or `Deny`. */
    defaultAction: string;
    /** Whether the public endpoint accepts traffic: `Enabled` or `Disabled`. */
    publicNetworkAccess: string;
    /** Whether trusted Microsoft services bypass the firewall. */
    trustedServiceAccessEnabled: boolean;
    /** Allowed IPv4 ranges, as Azure returns them (a single IP may come back as `x.x.x.x/32`). */
    ipRules: string[];
    /** ARM resource IDs of the allowed subnets. */
    virtualNetworkRules: string[];
  },
  never,
  Providers
> {}

/**
 * The network firewall of a Service Bus namespace
 * (`Microsoft.ServiceBus/namespaces/networkRuleSets`, always named
 * `default`): the default action, public access, trusted services, IP
 * rules, and (Premium) virtual network rules.
 *
 * Every namespace already has a rule set, so Alchemy updates the existing
 * one instead of creating it. Destroying the resource resets the namespace
 * to allow all traffic.
 *
 * :::caution[Changing `namespace` or `resourceGroup` replaces the rule set]
 * Alchemy resets the old namespace's firewall to allow all traffic and
 * applies the rules to the new namespace.
 * :::
 *
 * :::caution[Virtual network rules need Premium]
 * `virtualNetworkRules` need a namespace with `sku: "Premium"`.
 * :::
 *
 * :::caution[`Deny` without rules locks clients out]
 * With `defaultAction: "Deny"` and no `ipRules` or `virtualNetworkRules`,
 * no client can send or receive over the public endpoint. Add every range
 * your clients use.
 * :::
 *
 * @see https://learn.microsoft.com/azure/service-bus-messaging/service-bus-ip-filtering
 *
 * ### Restricting Access
 * **Example:** Allow only an office IP range
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus");
 * yield* Azure.ServiceBus.NetworkRuleSet("bus-firewall", {
 *   namespace: bus.namespaceName,
 *   defaultAction: "Deny",
 *   ipRules: [{ ipMask: "203.0.113.0/24" }],
 * });
 * ```
 *
 * **Example:** Disable the public endpoint, allow trusted services
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", { sku: "Premium" });
 * yield* Azure.ServiceBus.NetworkRuleSet("bus-firewall", {
 *   namespace: bus.namespaceName,
 *   publicNetworkAccess: "Disabled",
 *   trustedServiceAccessEnabled: true,
 * });
 * ```
 *
 * ### Allowing a Virtual Network
 * The subnet needs the `Microsoft.ServiceBus` service endpoint.
 *
 * **Example:** Allow one subnet on a Premium namespace
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("app", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   serviceEndpoints: [{ service: "Microsoft.ServiceBus" }],
 * });
 * const bus = yield* Azure.ServiceBus.Namespace("bus", { sku: "Premium" });
 * yield* Azure.ServiceBus.NetworkRuleSet("bus-firewall", {
 *   namespace: bus.namespaceName,
 *   defaultAction: "Deny",
 *   virtualNetworkRules: [{ subnetId: subnet.subnetId }],
 * });
 * ```
 *
 * @resource
 */
export const NetworkRuleSet = GroupedResource<NetworkRuleSet>("Azure.ServiceBus.NetworkRuleSet");

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  namespaceName: string;
}

const getRuleSet = (where: Where) =>
  orUndefinedIfNotFound(servicebus.GetNamespaceNetworkRuleSet(where));

/** Azure normalizes single IPs to `/32`; compare without the suffix. */
const normalizeMask = (mask: string | undefined) => (mask ?? "").replace(/\/32$/, "").toLowerCase();

const sortedJoin = (values: ReadonlyArray<string>) => [...values].sort().join(",");

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
    ipRules: (props.ipRules ?? []).flatMap((rule) => (rule.ipMask ? [rule.ipMask] : [])),
    virtualNetworkRules: (props.virtualNetworkRules ?? []).flatMap((rule) =>
      rule.subnet?.id ? [rule.subnet.id] : [],
    ),
  };
};

const toDesired = (props: NetworkRuleSetProps): servicebus.NetworkRuleSetProperties => ({
  defaultAction: props.defaultAction ?? "Allow",
  publicNetworkAccess: props.publicNetworkAccess ?? "Enabled",
  trustedServiceAccessEnabled: props.trustedServiceAccessEnabled ?? false,
  ipRules: (props.ipRules ?? []).map((rule) => ({
    ipMask: rule.ipMask,
    action: "Allow",
  })),
  virtualNetworkRules: (props.virtualNetworkRules ?? []).map((rule) => ({
    subnet: { id: rule.subnetId },
    ignoreMissingVnetServiceEndpoint: rule.ignoreMissingVnetServiceEndpoint ?? false,
  })),
});

const ruleSetDiffers = (
  observed: servicebus.NetworkRuleSetProperties | undefined,
  desired: servicebus.NetworkRuleSetProperties,
) =>
  !sameName(observed?.defaultAction ?? "Allow", desired.defaultAction) ||
  !sameName(observed?.publicNetworkAccess ?? "Enabled", desired.publicNetworkAccess) ||
  (observed?.trustedServiceAccessEnabled ?? false) !== desired.trustedServiceAccessEnabled ||
  sortedJoin((observed?.ipRules ?? []).map((r) => normalizeMask(r.ipMask))) !==
    sortedJoin((desired.ipRules ?? []).map((r) => normalizeMask(r.ipMask))) ||
  sortedJoin(
    (observed?.virtualNetworkRules ?? []).map(
      (r) => `${r.subnet?.id?.toLowerCase()}|${r.ignoreMissingVnetServiceEndpoint ?? false}`,
    ),
  ) !==
    sortedJoin(
      (desired.virtualNetworkRules ?? []).map(
        (r) => `${r.subnet?.id?.toLowerCase()}|${r.ignoreMissingVnetServiceEndpoint ?? false}`,
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
      if (observed === undefined || ruleSetDiffers(observed.properties, desired)) {
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
      if (observed === undefined || !ruleSetDiffers(observed.properties, DEFAULTS)) {
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
