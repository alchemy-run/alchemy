import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  createFabricName,
  FABRIC_NAMESPACE,
  propertyDelta,
  sameArm,
  waitFabricProvisioned,
} from "./Common.ts";

export interface NeighborGroupProps {
  /**
   * Resource group the neighbor group is created in. Changing it replaces the
   * neighbor group.
   */
  resourceGroup: string;
  /**
   * Name of the neighbor group. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the neighbor group.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the neighbor group. Changing it replaces the neighbor group.
   * Network Fabric resources are offered in `eastus`, `southcentralus`,
   * `westus3`, `australiaeast`, `uaenorth`, `uksouth`, and `northeurope`.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Destination addresses, e.g. `{ ipv4Addresses: ["10.10.10.10"] }`. */
  destination: mnf.NeighborGroupPropertiesInput["destination"];
  /**
   * Free-form description.
   * @default none
   */
  annotation?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface NeighborGroup extends Resource<
  "Azure.ManagedNetworkFabric.NeighborGroup",
  NeighborGroupProps,
  {
    /** Name of the neighbor group. */
    neighborGroupName: string;
    /** ARM resource ID of the neighbor group. */
    neighborGroupId: string;
    /** Resource group that holds the neighbor group. */
    resourceGroup: string;
    /** Location of the neighbor group. */
    location: string;
    /** Network taps that send traffic to this group. */
    networkTapIds: string[];
    /** Network tap rules that reference this group. */
    networkTapRuleIds: string[];
    /** Description of the neighbor group. */
    annotation: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** Configuration state on the fabric devices, e.g. `Succeeded`. */
    configurationState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus neighbor group — a named set of IPv4/IPv6
 * destinations that network tap rules and ACL actions forward traffic to.
 *
 * ARM type: `Microsoft.ManagedNetworkFabric/neighborGroups`.
 * See the [Azure documentation](https://learn.microsoft.com/azure/operator-nexus/howto-configure-network-tap).
 *
 * :::caution
 * Changing `resourceGroup`, `name`, or `location` replaces the group.
 * :::
 *
 * ### Creating a Neighbor Group
 * **Example:** Group of collector addresses
 * ```typescript
 * const collectors = yield* Azure.ManagedNetworkFabric.NeighborGroup("collectors", {
 *   destination: { ipv4Addresses: ["10.10.10.10", "10.10.10.11"] },
 * });
 * ```
 *
 * @resource
 */
export const NeighborGroup = GroupedResource<NeighborGroup>(
  "Azure.ManagedNetworkFabric.NeighborGroup",
);

type Observed = mnf.GetNeighborGroupResponse;

const getNeighborGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  neighborGroupName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetNeighborGroup({
      subscriptionId,
      resourceGroupName,
      neighborGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): NeighborGroup["Attributes"] => {
  const p = observed.properties;
  return {
    neighborGroupName: name,
    neighborGroupId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    networkTapIds: [...(p?.networkTapIds ?? [])],
    networkTapRuleIds: [...(p?.networkTapRuleIds ?? [])],
    annotation: p?.annotation,
    provisioningState: p?.provisioningState,
    configurationState: p?.configurationState,
    tags: userTags(observed.tags),
  };
};

export const NeighborGroupProvider = () =>
  Provider.succeed(NeighborGroup, {
    stables: ["neighborGroupName", "neighborGroupId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(mnf.ListNeighborGroupBySubscription, { subscriptionId });
      return (page.value ?? []).flatMap((item) => {
        const group = resourceGroupOf(item.id);
        return hasAnyAlchemyTag(item.tags) && group !== undefined && item.name !== undefined
          ? [toAttrs(group, item.name, item)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameArm(news.name, output.neighborGroupName)) ||
        (news.location !== undefined && !sameArm(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.neighborGroupName ?? olds?.name ?? (yield* createFabricName(id));
      const observed = yield* getNeighborGroup(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, FABRIC_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.neighborGroupName ?? (yield* createFabricName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        neighborGroupName: name,
      };
      const label = `neighbor group ${name}`;
      const get = getNeighborGroup(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateNeighborGroup({
          ...where,
          location,
          tags,
          properties: {
            destination: news.destination,
            annotation: news.annotation,
          },
        });
      }
      observed = yield* waitFabricProvisioned(label, get);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        destination: news.destination,
        annotation: news.annotation,
      });
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* mnf.UpdateNeighborGroup({
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
        neighborGroupName: output.neighborGroupName,
      };
      const label = `neighbor group ${output.neighborGroupName}`;
      const get = getNeighborGroup(subscriptionId, output.resourceGroup, output.neighborGroupName);
      yield* ignoreNotFound(mnf.DeleteNeighborGroup(where));
      yield* waitUntilGone(label, get, { interval: "5 seconds", times: 60 });
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
