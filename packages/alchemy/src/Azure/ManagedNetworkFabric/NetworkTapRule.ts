import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createFabricName,
  differs,
  FABRIC_NAMESPACE,
  propertyDelta,
  sameArm,
  waitFabricProvisioned,
} from "./Common.ts";

export interface NetworkTapRuleProps {
  /**
   * Resource group the network tap rule is created in. Changing it replaces the
   * network tap rule.
   */
  resourceGroup: string;
  /**
   * Name of the network tap rule. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the network tap rule.
   */
  name?: string;
  /**
   * Azure location of the network tap rule. Changing it replaces the network tap rule.
   * Network Fabric resources are offered in `eastus`, `southcentralus`,
   * `westus3`, `australiaeast`, `uaenorth`, `uksouth`, and `northeurope`.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * `Inline` (rules in `matchConfigurations`) or `File` (rules at
   * `tapRulesUrl`). Changing it replaces the rule.
   */
  configurationType: mnf.NetworkTapRulePropertiesInput["configurationType"];
  /**
   * How often (seconds) a `File` rule polls `tapRulesUrl`. Changing it
   * replaces the rule.
   */
  pollingIntervalInSeconds?: number;
  /** URL of the tap rules file when `configurationType` is `File`. */
  tapRulesUrl?: string;
  /**
   * Inline match configurations: conditions and the tap actions (e.g.
   * `Goto`, `Redirect`, `Count`) to take when they match.
   */
  matchConfigurations?: mnf.NetworkTapRulePropertiesInput["matchConfigurations"];
  /** Named IP, VLAN, and port groups that match configurations reference. */
  dynamicMatchConfigurations?: mnf.NetworkTapRulePropertiesInput["dynamicMatchConfigurations"];
  /** Managed identity used to read `tapRulesUrl`. */
  identitySelector?: mnf.NetworkTapRulePropertiesInput["identitySelector"];
  /** Global tap rule actions, e.g. enabling match counters. */
  globalNetworkTapRuleActions?: mnf.NetworkTapRulePropertiesInput["globalNetworkTapRuleActions"];
  /** Free-form description. */
  annotation?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NetworkTapRule extends Resource<
  "Azure.ManagedNetworkFabric.NetworkTapRule",
  NetworkTapRuleProps,
  {
    /** Name of the network tap rule. */
    networkTapRuleName: string;
    /** ARM resource ID of the network tap rule. */
    networkTapRuleId: string;
    /** Resource group that holds the network tap rule. */
    resourceGroup: string;
    /** Location of the network tap rule. */
    location: string;
    /** Network tap that uses this rule. */
    networkTapId: string | undefined;
    /** Description of the network tap rule. */
    annotation: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** Configuration state on the fabric devices, e.g. `Succeeded`. */
    configurationState: string | undefined;
    /** Administrative state, e.g. `Enabled` or `Disabled`. */
    administrativeState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus network tap rule — match conditions that select
 * which mirrored packets a network tap forwards, and where.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-configure-network-tap
 *
 * ### Creating a Network Tap Rule
 * **Example:** Inline rule that counts IPv4 traffic
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("fabric");
 * const rule = yield* Azure.ManagedNetworkFabric.NetworkTapRule("count", {
 *   resourceGroup: group.resourceGroupName,
 *   configurationType: "Inline",
 *   matchConfigurations: [
 *     {
 *       matchConfigurationName: "all-ipv4",
 *       sequenceNumber: 10,
 *       ipAddressType: "IPv4",
 *       matchConditions: [{ protocolTypes: ["TCP"] }],
 *       actions: [{ type: "Count" }],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const NetworkTapRule = Resource<NetworkTapRule>(
  "Azure.ManagedNetworkFabric.NetworkTapRule",
);

type Observed = mnf.GetNetworkTapRuleResponse;

const getNetworkTapRule = (
  subscriptionId: string,
  resourceGroupName: string,
  networkTapRuleName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetNetworkTapRule({
      subscriptionId,
      resourceGroupName,
      networkTapRuleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): NetworkTapRule["Attributes"] => {
  const p = observed.properties;
  return {
    networkTapRuleName: name,
    networkTapRuleId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    networkTapId: p?.networkTapId,
    annotation: p?.annotation,
    provisioningState: p?.provisioningState,
    configurationState: p?.configurationState,
    administrativeState: p?.administrativeState,
    tags: userTags(observed.tags),
  };
};

export const NetworkTapRuleProvider = () =>
  Provider.succeed(NetworkTapRule, {
    stables: [
      "networkTapRuleName",
      "networkTapRuleId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mnf
        .ListNetworkTapRuleBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListNetworkTapRuleBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((item) => {
        const group = resourceGroupOf(item.id);
        return hasAnyAlchemyTag(item.tags) &&
          group !== undefined &&
          item.name !== undefined
          ? [toAttrs(group, item.name, item)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.networkTapRuleName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (olds !== undefined &&
          (differs(news.configurationType, olds.configurationType) ||
            differs(
              news.pollingIntervalInSeconds,
              olds.pollingIntervalInSeconds,
            )))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.networkTapRuleName ??
        olds?.name ??
        (yield* createFabricName(id));
      const observed = yield* getNetworkTapRule(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, FABRIC_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.networkTapRuleName ??
        (yield* createFabricName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        networkTapRuleName: name,
      };
      const label = `network tap rule ${name}`;
      const get = getNetworkTapRule(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateNetworkTapRule({
          ...where,
          location,
          tags,
          properties: {
            configurationType: news.configurationType,
            pollingIntervalInSeconds: news.pollingIntervalInSeconds,
            tapRulesUrl: news.tapRulesUrl,
            matchConfigurations: news.matchConfigurations,
            dynamicMatchConfigurations: news.dynamicMatchConfigurations,
            identitySelector: news.identitySelector,
            globalNetworkTapRuleActions: news.globalNetworkTapRuleActions,
            annotation: news.annotation,
          },
        });
      }
      observed = yield* waitFabricProvisioned(label, get);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        tapRulesUrl: news.tapRulesUrl,
        matchConfigurations: news.matchConfigurations,
        dynamicMatchConfigurations: news.dynamicMatchConfigurations,
        identitySelector: news.identitySelector,
        globalNetworkTapRuleActions: news.globalNetworkTapRuleActions,
        annotation: news.annotation,
      });
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* mnf.UpdateNetworkTapRule({
          ...where,
          tags: tagsChanged ? tags : undefined,
          // The service rejects a PATCH without `configurationType`.
          properties: {
            ...delta,
            configurationType: news.configurationType,
          },
        });
        observed = yield* waitFabricProvisioned(label, get);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        networkTapRuleName: output.networkTapRuleName,
      };
      const label = `network tap rule ${output.networkTapRuleName}`;
      const get = getNetworkTapRule(
        subscriptionId,
        output.resourceGroup,
        output.networkTapRuleName,
      );
      // Fabric-bound resources must be administratively disabled first.
      const current = yield* get;
      if (current?.properties?.administrativeState === "Enabled") {
        yield* mnf.UpdateNetworkTapRuleAdministrativeState({
          ...where,
          state: "Disable",
        });
        yield* waitFabricProvisioned(label, get);
      }
      yield* ignoreNotFound(mnf.DeleteNetworkTapRule(where));
      yield* waitUntilGone(label, get, { interval: "5 seconds", times: 60 });
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
