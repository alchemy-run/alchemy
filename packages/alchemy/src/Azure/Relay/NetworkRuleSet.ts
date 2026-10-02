import * as relay from "@distilled.cloud/azure/relay";
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

export interface NetworkRuleSetProps {
  /** Resource group of the namespace. Changing it replaces the rule set. */
  resourceGroup: string;
  /** Relay namespace the rule set applies to. Changing it replaces the rule set. */
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
  publicNetworkAccess?: "Enabled" | "Disabled" | "SecuredByPerimeter";
  /**
   * Let trusted Microsoft services bypass the firewall.
   * @default false
   */
  trustedServiceAccessEnabled?: boolean;
  /** IP ranges allowed when `defaultAction` is `Deny`. */
  ipRules?: NetworkRuleSetIpRule[];
}

export interface NetworkRuleSet extends Resource<
  "Azure.Relay.NetworkRuleSet",
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
  },
  never,
  Providers
> {}

/**
 * The network firewall of an Azure Relay namespace (the singleton
 * `networkRuleSets/default`): default action, public access, trusted
 * services, and IP rules.
 *
 * Every namespace already has a rule set, so this resource converges the
 * existing one instead of creating it; destroying it resets the namespace
 * to allow all traffic.
 *
 * @see https://learn.microsoft.com/azure/azure-relay/ip-firewall-virtual-networks
 *
 * ### Restricting Access
 * **Example:** Allow only an office IP range
 * ```typescript
 * const ns = yield* Azure.Relay.Namespace("relay", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Relay.NetworkRuleSet("relay-firewall", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: ns.namespaceName,
 *   defaultAction: "Deny",
 *   ipRules: [{ ipMask: "203.0.113.0/24" }],
 * });
 * ```
 *
 * **Example:** Disable the public endpoint, allow trusted services
 * ```typescript
 * yield* Azure.Relay.NetworkRuleSet("relay-firewall", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: ns.namespaceName,
 *   publicNetworkAccess: "Disabled",
 *   trustedServiceAccessEnabled: true,
 * });
 * ```
 *
 * @resource
 */
export const NetworkRuleSet = Resource<NetworkRuleSet>(
  "Azure.Relay.NetworkRuleSet",
);

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  namespaceName: string;
}

const getRuleSet = (where: Where) =>
  orUndefinedIfNotFound(relay.GetNamespaceNetworkRuleSet(where));

/** Azure normalizes single IPs to `/32`; compare without the suffix. */
const normalizeMask = (mask: string | undefined) =>
  (mask ?? "").replace(/\/32$/, "").toLowerCase();

const sortedJoin = (values: ReadonlyArray<string>) =>
  [...values].sort().join(",");

const toAttrs = (
  where: Where,
  ruleSet: relay.GetNamespaceNetworkRuleSetResponse,
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
  };
};

const toDesired = (
  props: Pick<
    NetworkRuleSetProps,
    | "defaultAction"
    | "publicNetworkAccess"
    | "trustedServiceAccessEnabled"
    | "ipRules"
  >,
): relay.NetworkRuleSetProperties => ({
  defaultAction: props.defaultAction ?? "Allow",
  publicNetworkAccess: props.publicNetworkAccess ?? "Enabled",
  trustedServiceAccessEnabled: props.trustedServiceAccessEnabled ?? false,
  ipRules: (props.ipRules ?? []).map((rule) => ({
    ipMask: rule.ipMask,
    action: "Allow",
  })),
});

const ruleSetDiffers = (
  observed: relay.NetworkRuleSetProperties | undefined,
  desired: relay.NetworkRuleSetProperties,
) =>
  !sameName(observed?.defaultAction ?? "Allow", desired.defaultAction) ||
  !sameName(
    observed?.publicNetworkAccess ?? "Enabled",
    desired.publicNetworkAccess,
  ) ||
  (observed?.trustedServiceAccessEnabled ?? false) !==
    desired.trustedServiceAccessEnabled ||
  sortedJoin((observed?.ipRules ?? []).map((r) => normalizeMask(r.ipMask))) !==
    sortedJoin((desired.ipRules ?? []).map((r) => normalizeMask(r.ipMask)));

const DEFAULTS = toDesired({});

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
      yield* ensureRegistered(subscriptionId, "Microsoft.Relay");
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
        yield* relay.NamespacesCreateOrUpdateNetworkRuleSet({
          ...where,
          properties: desired,
        });
        observed = yield* relay.GetNamespaceNetworkRuleSet(where);
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
        relay.NamespacesCreateOrUpdateNetworkRuleSet({
          ...where,
          properties: DEFAULTS,
        }),
      );
    }),

    nuke: { dependsOn: ["Azure.Relay.Namespace"] },
  });
