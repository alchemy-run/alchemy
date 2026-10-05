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
  sameArm,
  waitFabricProvisioned,
} from "./Common.ts";

export interface InternetGatewayRuleProps {
  /**
   * Resource group the internet gateway rule is created in. Changing it replaces the
   * internet gateway rule.
   */
  resourceGroup: string;
  /**
   * Name of the internet gateway rule. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the internet gateway rule.
   */
  name?: string;
  /**
   * Azure location of the internet gateway rule. Changing it replaces the internet gateway rule.
   * Network Fabric resources are offered in `eastus`, `southcentralus`,
   * `westus3`, `australiaeast`, `uaenorth`, `uksouth`, and `northeurope`.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Allow/deny rule (IPv4 addresses, DNS names, or wildcard expressions,
   * optionally with ports), e.g. `{ action: "Allow", addressList: ["10.0.0.1"] }`.
   * Azure cannot update it in place, so changing it replaces the rule.
   */
  ruleProperties: mnf.InternetGatewayRulePropertiesInput["ruleProperties"];
  /**
   * Free-form description. Azure cannot update it in place, so changing
   * it replaces the resource.
   */
  annotation?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface InternetGatewayRule extends Resource<
  "Azure.ManagedNetworkFabric.InternetGatewayRule",
  InternetGatewayRuleProps,
  {
    /** Name of the internet gateway rule. */
    internetGatewayRuleName: string;
    /** ARM resource ID of the internet gateway rule. */
    internetGatewayRuleId: string;
    /** Resource group that holds the internet gateway rule. */
    resourceGroup: string;
    /** Location of the internet gateway rule. */
    location: string;
    /** Internet gateways that use this rule. */
    internetGatewayIds: string[];
    /** Description of the internet gateway rule. */
    annotation: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus internet gateway rule — the allow/deny address
 * list an internet gateway of a Network Fabric Controller enforces.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/concepts-network-fabric-controller
 *
 * ### Creating an Internet Gateway Rule
 * **Example:** Allow one address range
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("fabric");
 * const rule = yield* Azure.ManagedNetworkFabric.InternetGatewayRule("egress", {
 *   resourceGroup: group.resourceGroupName,
 *   ruleProperties: { action: "Allow", addressList: ["10.0.0.1", "*.example.com"] },
 * });
 * ```
 *
 * @resource
 */
export const InternetGatewayRule = Resource<InternetGatewayRule>(
  "Azure.ManagedNetworkFabric.InternetGatewayRule",
);

type Observed = mnf.GetInternetGatewayRuleResponse;

const getInternetGatewayRule = (
  subscriptionId: string,
  resourceGroupName: string,
  internetGatewayRuleName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetInternetGatewayRule({
      subscriptionId,
      resourceGroupName,
      internetGatewayRuleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): InternetGatewayRule["Attributes"] => {
  const p = observed.properties;
  return {
    internetGatewayRuleName: name,
    internetGatewayRuleId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    internetGatewayIds: [...(p?.internetGatewayIds ?? [])],
    annotation: p?.annotation,
    provisioningState: p?.provisioningState,
    tags: userTags(observed.tags),
  };
};

export const InternetGatewayRuleProvider = () =>
  Provider.succeed(InternetGatewayRule, {
    stables: [
      "internetGatewayRuleName",
      "internetGatewayRuleId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mnf
        .ListInternetGatewayRuleBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListInternetGatewayRuleBySubscription", page),
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
          !sameArm(news.name, output.internetGatewayRuleName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (olds !== undefined &&
          (differs(news.ruleProperties, olds.ruleProperties) ||
            differs(news.annotation, olds.annotation)))
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
        output?.internetGatewayRuleName ??
        olds?.name ??
        (yield* createFabricName(id));
      const observed = yield* getInternetGatewayRule(
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
        output?.internetGatewayRuleName ??
        (yield* createFabricName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        internetGatewayRuleName: name,
      };
      const label = `internet gateway rule ${name}`;
      const get = getInternetGatewayRule(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateInternetGatewayRule({
          ...where,
          location,
          tags,
          properties: {
            ruleProperties: news.ruleProperties,
            annotation: news.annotation,
          },
        });
      }
      observed = yield* waitFabricProvisioned(label, get);

      // Sync mutable aspects against observed state; send only the delta.
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (tagsChanged) {
        yield* mnf.UpdateInternetGatewayRule({
          ...where,
          tags: tagsChanged ? tags : undefined,
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
        internetGatewayRuleName: output.internetGatewayRuleName,
      };
      const label = `internet gateway rule ${output.internetGatewayRuleName}`;
      const get = getInternetGatewayRule(
        subscriptionId,
        output.resourceGroup,
        output.internetGatewayRuleName,
      );
      yield* ignoreNotFound(mnf.DeleteInternetGatewayRule(where));
      yield* waitUntilGone(label, get, { interval: "5 seconds", times: 60 });
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
