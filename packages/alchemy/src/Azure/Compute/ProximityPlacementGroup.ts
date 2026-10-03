import * as compute from "@distilled.cloud/azure/compute";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createComputeName,
  idsOf,
  sameId,
  sameSet,
  waitComputeGone,
} from "./common.ts";

export interface ProximityPlacementGroupProps {
  /**
   * Resource group the proximity placement group is created in. Changing it
   * replaces the group.
   */
  resourceGroup: string;
  /**
   * Name of the group: 1-80 letters, digits, `_`, `.`, and `-`. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the group.
   */
  name?: string;
  /**
   * Azure location of the group. Changing it replaces the group.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Availability zone to pin the group to (at most one). Changing it
   * replaces the group.
   */
  zones?: string[];
  /**
   * Group type. Changing it replaces the group.
   * @default "Standard"
   */
  proximityPlacementGroupType?: "Standard" | "Ultra";
  /**
   * VM sizes the group intends to host; Azure uses them to pick a
   * datacenter. Can only be changed while the group is empty.
   */
  intentVmSizes?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ProximityPlacementGroup extends Resource<
  "Azure.Compute.ProximityPlacementGroup",
  ProximityPlacementGroupProps,
  {
    /** Name of the proximity placement group. */
    proximityPlacementGroupName: string;
    /** ARM resource ID of the group; pass it to VMs, scale sets, and availability sets. */
    proximityPlacementGroupId: string;
    /** Resource group that holds the group. */
    resourceGroup: string;
    /** Location of the group. */
    location: string;
    /** Group type. */
    proximityPlacementGroupType: string | undefined;
    /** Zones the group is pinned to. */
    zones: string[];
    /** ARM IDs of member VMs. */
    virtualMachineIds: string[];
    /** ARM IDs of member scale sets. */
    virtualMachineScaleSetIds: string[];
    /** ARM IDs of member availability sets. */
    availabilitySetIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure proximity placement group — a logical grouping that keeps VMs,
 * scale sets, and availability sets physically close for the lowest
 * network latency. Proximity placement groups are free.
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/co-location
 *
 * ### Creating a Proximity Placement Group
 * **Example:** Standard group
 * ```typescript
 * const ppg = yield* Azure.Compute.ProximityPlacementGroup("low-latency", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Group with a VM-size intent and a zone
 * ```typescript
 * const ppg = yield* Azure.Compute.ProximityPlacementGroup("hpc", {
 *   resourceGroup: group.resourceGroupName,
 *   zones: ["1"],
 *   intentVmSizes: ["Standard_D2s_v5"],
 * });
 * ```
 *
 * ### Using the Group
 * **Example:** Availability set in the group
 * ```typescript
 * const set = yield* Azure.Compute.AvailabilitySet("web", {
 *   resourceGroup: group.resourceGroupName,
 *   proximityPlacementGroupId: ppg.proximityPlacementGroupId,
 * });
 * ```
 *
 * @resource
 */
export const ProximityPlacementGroup = Resource<ProximityPlacementGroup>(
  "Azure.Compute.ProximityPlacementGroup",
);

type Observed = compute.GetProximityPlacementGroupResponse;

const getGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  proximityPlacementGroupName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetProximityPlacementGroup({
      subscriptionId,
      resourceGroupName,
      proximityPlacementGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  group: Observed,
): ProximityPlacementGroup["Attributes"] => ({
  proximityPlacementGroupName: name,
  proximityPlacementGroupId: group.id ?? "",
  resourceGroup,
  location: group.location,
  proximityPlacementGroupType: group.properties?.proximityPlacementGroupType,
  zones: [...(group.zones ?? [])],
  virtualMachineIds: idsOf(group.properties?.virtualMachines),
  virtualMachineScaleSetIds: idsOf(group.properties?.virtualMachineScaleSets),
  availabilitySetIds: idsOf(group.properties?.availabilitySets),
  tags: userTags(group.tags),
});

/** Delete is rejected while members remain (released shortly after). */
const whileMembersRemain = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "OperationNotAllowed" || e._tag === "ResourceConflict",
  schedule: Schedule.spaced("5 seconds"),
  times: 24,
} as const;

export const ProximityPlacementGroupProvider = () =>
  Provider.succeed(ProximityPlacementGroup, {
    stables: [
      "proximityPlacementGroupName",
      "proximityPlacementGroupId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* compute
        .ListProximityPlacementGroupBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage(
              "ListProximityPlacementGroupBySubscription",
              page,
            ),
          ),
        );
      return page.value.flatMap((group) => {
        const resourceGroup = resourceGroupOf(group.id);
        return hasAnyAlchemyTag(group.tags) &&
          resourceGroup !== undefined &&
          group.name !== undefined
          ? [toAttrs(resourceGroup, group.name, group)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.proximityPlacementGroupName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        !sameSet(news.zones, output.zones) ||
        !sameId(
          news.proximityPlacementGroupType ?? "Standard",
          output.proximityPlacementGroupType ?? "Standard",
        )
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
        output?.proximityPlacementGroupName ??
        olds?.name ??
        (yield* createComputeName(id));
      const observed = yield* getGroup(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Compute");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.proximityPlacementGroupName ??
        (yield* createComputeName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        proximityPlacementGroupName: name,
      };

      // Observe.
      let observed = yield* getGroup(subscriptionId, resourceGroup, name);

      // Ensure, or re-PUT when the intent changed (PATCH only takes tags).
      const intentChanged =
        observed !== undefined &&
        news.intentVmSizes !== undefined &&
        !sameSet(observed.properties?.intent?.vmSizes, news.intentVmSizes);
      if (observed === undefined || intentChanged) {
        observed = yield* compute.ProximityPlacementGroupsCreateOrUpdate({
          ...where,
          location,
          tags,
          zones: news.zones,
          properties: {
            proximityPlacementGroupType:
              news.proximityPlacementGroupType ?? "Standard",
            intent:
              news.intentVmSizes === undefined
                ? undefined
                : { vmSizes: news.intentVmSizes },
          },
        });
      } else if (tagsDiffer(observed.tags, tags)) {
        observed = yield* compute.UpdateProximityPlacementGroup({
          ...where,
          tags,
        });
      }
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        compute.DeleteProximityPlacementGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          proximityPlacementGroupName: output.proximityPlacementGroupName,
        }),
      ).pipe(Effect.retry(whileMembersRemain));
      yield* waitComputeGone(
        `proximity placement group ${output.proximityPlacementGroupName}`,
        getGroup(
          subscriptionId,
          output.resourceGroup,
          output.proximityPlacementGroupName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
