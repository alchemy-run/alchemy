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

export interface RoutePolicyProps {
  /**
   * Resource group the route policy is created in. Changing it replaces the
   * route policy.
   */
  resourceGroup: string;
  /**
   * Name of the route policy. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the route policy.
   */
  name?: string;
  /**
   * Azure location of the route policy. Changing it replaces the route policy.
   * Network Fabric resources are offered in `eastus`, `southcentralus`,
   * `westus3`, `australiaeast`, `uaenorth`, `uksouth`, and `northeurope`.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Network Fabric the policy belongs to. Changing it
   * replaces the policy.
   */
  networkFabricId: string;
  /** Address family (`IPv4` or `IPv6`). Changing it replaces the policy. */
  addressFamilyType?: mnf.RoutePolicyPropertiesInput["addressFamilyType"];
  /**
   * Ordered statements: a match condition (IP prefix, community, or
   * extended community list IDs) and the action to take.
   */
  statements: mnf.RoutePolicyPropertiesInput["statements"];
  /** Action when no statement matches (`Permit` or `Deny`). */
  defaultAction?: mnf.RoutePolicyPropertiesInput["defaultAction"];
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

export interface RoutePolicy extends Resource<
  "Azure.ManagedNetworkFabric.RoutePolicy",
  RoutePolicyProps,
  {
    /** Name of the route policy. */
    routePolicyName: string;
    /** ARM resource ID of the route policy. */
    routePolicyId: string;
    /** Resource group that holds the route policy. */
    resourceGroup: string;
    /** Location of the route policy. */
    location: string;
    /** Description of the route policy. */
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
 * An Azure Operator Nexus route policy — ordered BGP import/export
 * statements that match on IP prefix and community lists and permit, deny, or
 * rewrite routes. A route policy belongs to a Network Fabric, so it needs an
 * on-premises Operator Nexus deployment.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-route-policy
 *
 * ### Creating a Route Policy
 * **Example:** Permit routes from a prefix list
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("fabric");
 * // The Network Fabric is provisioned on Operator Nexus racks.
 * const fabricId =
 *   "/subscriptions/.../resourceGroups/nexus/providers/Microsoft.ManagedNetworkFabric/networkFabrics/fab1";
 * const prefixes = yield* Azure.ManagedNetworkFabric.IpPrefix("private", {
 *   resourceGroup: group.resourceGroupName,
 *   ipPrefixRules: [
 *     { action: "Permit", sequenceNumber: 10, networkPrefix: "10.0.0.0/8" },
 *   ],
 * });
 * const policy = yield* Azure.ManagedNetworkFabric.RoutePolicy("import", {
 *   resourceGroup: group.resourceGroupName,
 *   networkFabricId: fabricId,
 *   addressFamilyType: "IPv4",
 *   statements: [
 *     {
 *       sequenceNumber: 10,
 *       condition: { ipPrefixId: prefixes.ipPrefixId },
 *       action: { actionType: "Permit" },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const RoutePolicy = Resource<RoutePolicy>(
  "Azure.ManagedNetworkFabric.RoutePolicy",
);

type Observed = mnf.GetRoutePolicyResponse;

const getRoutePolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  routePolicyName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetRoutePolicy({ subscriptionId, resourceGroupName, routePolicyName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): RoutePolicy["Attributes"] => {
  const p = observed.properties;
  return {
    routePolicyName: name,
    routePolicyId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    annotation: p?.annotation,
    provisioningState: p?.provisioningState,
    configurationState: p?.configurationState,
    administrativeState: p?.administrativeState,
    tags: userTags(observed.tags),
  };
};

export const RoutePolicyProvider = () =>
  Provider.succeed(RoutePolicy, {
    stables: ["routePolicyName", "routePolicyId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mnf
        .ListRoutePolicyBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListRoutePolicyBySubscription", page),
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
          !sameArm(news.name, output.routePolicyName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (olds !== undefined &&
          (!sameArm(news.networkFabricId, olds.networkFabricId) ||
            differs(news.addressFamilyType, olds.addressFamilyType) ||
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
        output?.routePolicyName ?? olds?.name ?? (yield* createFabricName(id));
      const observed = yield* getRoutePolicy(
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
        news.name ?? output?.routePolicyName ?? (yield* createFabricName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        routePolicyName: name,
      };
      const label = `route policy ${name}`;
      const get = getRoutePolicy(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateRoutePolicy({
          ...where,
          location,
          tags,
          properties: {
            networkFabricId: news.networkFabricId,
            addressFamilyType: news.addressFamilyType,
            statements: news.statements,
            defaultAction: news.defaultAction,
            annotation: news.annotation,
          },
        });
      }
      observed = yield* waitFabricProvisioned(label, get);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        statements: news.statements,
        defaultAction: news.defaultAction,
      });
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* mnf.UpdateRoutePolicy({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: delta,
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
        routePolicyName: output.routePolicyName,
      };
      const label = `route policy ${output.routePolicyName}`;
      const get = getRoutePolicy(
        subscriptionId,
        output.resourceGroup,
        output.routePolicyName,
      );
      // Fabric-bound resources must be administratively disabled first.
      const current = yield* get;
      if (current?.properties?.administrativeState === "Enabled") {
        yield* mnf.UpdateRoutePolicyAdministrativeState({
          ...where,
          state: "Disable",
        });
        yield* waitFabricProvisioned(label, get);
      }
      yield* ignoreNotFound(mnf.DeleteRoutePolicy(where));
      yield* waitUntilGone(label, get, { interval: "5 seconds", times: 60 });
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
