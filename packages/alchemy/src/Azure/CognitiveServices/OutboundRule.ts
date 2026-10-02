import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isAccountOwnedByStack } from "./Account.ts";
import {
  createChildName,
  sameArm,
  sameValue,
  whileAccountBusy,
} from "./Common.ts";
import {
  MANAGED_NETWORK_BUDGET,
  MANAGED_NETWORK_NAME,
} from "./ManagedNetwork.ts";

export interface PrivateEndpointDestination {
  /** ARM ID of the resource to reach through a private endpoint. */
  serviceResourceId: string;
  /** Private-link sub-resource, e.g. `blob`, `vault`, `searchService`. */
  subresourceTarget: string;
}

export interface ServiceTagDestination {
  /** Service tag, e.g. `AzureActiveDirectory`. */
  serviceTag: string;
  /** Protocol: `TCP`, `UDP`, `ICMP`, or `*`. */
  protocol: string;
  /** Port ranges, e.g. `"443"` or `"80,443"`. */
  portRanges: string;
  /** Rule action. */
  action?: "Allow" | "Deny";
}

export interface OutboundRuleProps {
  /** Resource group of the account. Changing it replaces the rule. */
  resourceGroup: string;
  /** Account whose managed network holds the rule. Changing it replaces the rule. */
  account: string;
  /**
   * Rule name. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the rule.
   */
  name?: string;
  /**
   * Rule type: `PrivateEndpoint` (reach an Azure resource privately),
   * `FQDN` (only with `AllowOnlyApprovedOutbound`, which deploys an Azure
   * Firewall), or `ServiceTag`.
   */
  type: "FQDN" | "PrivateEndpoint" | "ServiceTag";
  /**
   * Destination matching `type`: a domain name for `FQDN`, a
   * {@link PrivateEndpointDestination} for `PrivateEndpoint`, or a
   * {@link ServiceTagDestination} for `ServiceTag`.
   */
  destination: string | PrivateEndpointDestination | ServiceTagDestination;
  /**
   * Rule category.
   * @default "UserDefined"
   */
  category?: "UserDefined" | "Required" | "Recommended" | "Dependency";
}

export interface OutboundRule extends Resource<
  "Azure.CognitiveServices.OutboundRule",
  OutboundRuleProps,
  {
    /** Name of the rule. */
    ruleName: string;
    /** ARM resource ID of the rule. */
    outboundRuleId: string;
    /** Account whose managed network holds the rule. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Rule type. */
    type: string;
    /** Rule status (`Active`, `Inactive`, ...). */
    status: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An outbound rule of an Azure AI Foundry managed network
 * (`Microsoft.CognitiveServices/accounts/managedNetworks/default/outboundRules`,
 * preview): a private endpoint to an Azure resource, an allowed FQDN, or an
 * allowed service tag.
 *
 * With `isolationMode: "AllowInternetOutbound"` only `PrivateEndpoint`
 * rules are accepted; FQDN rules need `AllowOnlyApprovedOutbound`, which
 * deploys a billed Azure Firewall.
 *
 * @see https://learn.microsoft.com/azure/ai-foundry/how-to/managed-network
 *
 * ### Private Endpoints
 * **Example:** Reach a storage account privately
 * ```typescript
 * yield* Azure.CognitiveServices.OutboundRule("storage", {
 *   resourceGroup: group.resourceGroupName,
 *   account: network.account,
 *   type: "PrivateEndpoint",
 *   destination: {
 *     serviceResourceId: storage.storageAccountId,
 *     subresourceTarget: "blob",
 *   },
 * });
 * ```
 *
 * ### Approved FQDNs
 * **Example:** Allow PyPI
 * ```typescript
 * yield* Azure.CognitiveServices.OutboundRule("pypi", {
 *   resourceGroup: group.resourceGroupName,
 *   account: network.account,
 *   type: "FQDN",
 *   destination: "pypi.org",
 * });
 * ```
 *
 * @resource
 */
export const OutboundRule = Resource<OutboundRule>(
  "Azure.CognitiveServices.OutboundRule",
);

const getRule = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  ruleName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetOutboundRule({
      subscriptionId,
      resourceGroupName,
      accountName,
      managedNetworkName: MANAGED_NETWORK_NAME,
      ruleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  rule: cognitiveservices.GetOutboundRuleResponse,
): OutboundRule["Attributes"] => ({
  ruleName: name,
  outboundRuleId: rule.id ?? "",
  account,
  resourceGroup,
  type: rule.properties.type,
  status: rule.properties.status,
});

const normalize = (destination: unknown) =>
  typeof destination === "string"
    ? destination.toLowerCase()
    : Object.fromEntries(
        Object.entries((destination ?? {}) as Record<string, unknown>).map(
          ([k, v]) => [k, typeof v === "string" ? v.toLowerCase() : v],
        ),
      );

const destinationMatches = (observed: unknown, desired: unknown) => {
  if (typeof desired === "string")
    return normalize(observed) === normalize(desired);
  const have = normalize(observed) as Record<string, unknown>;
  return Object.entries(normalize(desired) as Record<string, unknown>).every(
    ([k, v]) => sameValue(have[k], v),
  );
};

export const OutboundRuleProvider = () =>
  Provider.succeed(OutboundRule, {
    stables: ["ruleName", "outboundRuleId", "account", "resourceGroup"],

    // Rules live inside a managed network; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.account, output.account) ||
        (news.name !== undefined && !sameArm(news.name, output.ruleName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    // Rules carry no tags; ownership follows the account.
    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.ruleName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getRule(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* isAccountOwnedByStack(
        subscriptionId,
        resourceGroup,
        account,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const { resourceGroup, account } = news;
      const name =
        news.name ?? output?.ruleName ?? (yield* createChildName(id));
      const category = news.category ?? "UserDefined";
      const get = getRule(subscriptionId, resourceGroup, account, name);

      // Observe; the PUT (LRO) upserts the rule when missing or different.
      const observed = yield* get;
      if (
        observed === undefined ||
        observed.properties.type !== news.type ||
        observed.properties.category !== category ||
        !destinationMatches(observed.properties.destination, news.destination)
      ) {
        yield* cognitiveservices
          .OutboundRuleCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            managedNetworkName: MANAGED_NETWORK_NAME,
            ruleName: name,
            properties: {
              type: news.type,
              category,
              destination: news.destination,
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
      }
      const fresh = yield* waitForProvisioned(
        `outbound rule ${name}`,
        get,
        () => undefined,
        MANAGED_NETWORK_BUDGET,
      );
      return toAttrs(resourceGroup, account, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cognitiveservices
          .DeleteOutboundRule({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            managedNetworkName: MANAGED_NETWORK_NAME,
            ruleName: output.ruleName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `outbound rule ${output.ruleName}`,
        getRule(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.ruleName,
        ),
        MANAGED_NETWORK_BUDGET,
      );
    }),
  });
