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

export interface CapacityReservationGroupProps {
  /**
   * Resource group the capacity reservation group is created in. Changing
   * it replaces the group.
   */
  resourceGroup: string;
  /**
   * Name of the group: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the group.
   */
  name?: string;
  /**
   * Azure location of the group. Changing it replaces the group.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Availability zones reservations in the group may use. Changing them
   * replaces the group.
   */
  zones?: string[];
  /**
   * `Targeted` reservations are consumed only by VMs that reference the
   * group; `Block` reservations hold GPU capacity blocks. Changing it
   * replaces the group.
   * @default "Targeted"
   */
  reservationType?: "Targeted" | "Block";
  /**
   * Other subscriptions allowed to consume the group's reservations.
   */
  sharedSubscriptionIds?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface CapacityReservationGroup extends Resource<
  "Azure.Compute.CapacityReservationGroup",
  CapacityReservationGroupProps,
  {
    /** Name of the group. */
    capacityReservationGroupName: string;
    /** ARM resource ID of the group; reference it from VMs. */
    capacityReservationGroupId: string;
    /** Resource group that holds the group. */
    resourceGroup: string;
    /** Location of the group. */
    location: string;
    /** Zones of the group. */
    zones: string[];
    /** Reservation type. */
    reservationType: string | undefined;
    /** ARM IDs of the capacity reservations in the group. */
    capacityReservationIds: string[];
    /** ARM IDs of the VMs associated with the group. */
    virtualMachineIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure capacity reservation group — a container for on-demand
 * capacity reservations that VMs draw guaranteed capacity from. The empty
 * group is free; reservations bill at the pay-as-you-go VM rate whether
 * used or not.
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/capacity-reservation-overview
 *
 * ### Creating a Group
 * **Example:** Zonal capacity reservation group
 * ```typescript
 * const reservations = yield* Azure.Compute.CapacityReservationGroup("prod", {
 *   resourceGroup: group.resourceGroupName,
 *   zones: ["1"],
 * });
 * ```
 *
 * ### Reserving Capacity
 * **Example:** Reserve two D2s_v5 VMs and use one
 * ```typescript
 * yield* Azure.Compute.CapacityReservation("d2", {
 *   resourceGroup: group.resourceGroupName,
 *   capacityReservationGroup: reservations.capacityReservationGroupName,
 *   sku: "Standard_D2s_v5",
 *   capacity: 2,
 *   zones: ["1"],
 * });
 * const vm = yield* Azure.Compute.VirtualMachine("api", {
 *   resourceGroup: group.resourceGroupName,
 *   vmSize: "Standard_D2s_v5",
 *   zones: ["1"],
 *   capacityReservationGroupId: reservations.capacityReservationGroupId,
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 * });
 * ```
 *
 * @resource
 */
export const CapacityReservationGroup = Resource<CapacityReservationGroup>(
  "Azure.Compute.CapacityReservationGroup",
);

type Observed = compute.GetCapacityReservationGroupResponse;

const getGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  capacityReservationGroupName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetCapacityReservationGroup({
      subscriptionId,
      resourceGroupName,
      capacityReservationGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  group: Observed,
): CapacityReservationGroup["Attributes"] => ({
  capacityReservationGroupName: name,
  capacityReservationGroupId: group.id ?? "",
  resourceGroup,
  location: group.location,
  zones: [...(group.zones ?? [])],
  reservationType: group.properties?.reservationType,
  capacityReservationIds: idsOf(group.properties?.capacityReservations),
  virtualMachineIds: idsOf(group.properties?.virtualMachinesAssociated),
  tags: userTags(group.tags),
});

const sharedIds = (group: Observed) =>
  (group.properties?.sharingProfile?.subscriptionIds ?? []).flatMap((s) =>
    s.id ? [s.id] : [],
  );

const sharingProfile = (ids: string[] | undefined) =>
  ids === undefined
    ? undefined
    : {
        subscriptionIds: ids.map((subscription) => ({
          id: subscription.startsWith("/")
            ? subscription
            : `/subscriptions/${subscription}`,
        })),
      };

/** Delete is rejected while reservations or VMs remain. */
const whileMembersRemain = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "OperationNotAllowed" || e._tag === "ResourceConflict",
  schedule: Schedule.spaced("5 seconds"),
  times: 24,
} as const;

export const CapacityReservationGroupProvider = () =>
  Provider.succeed(CapacityReservationGroup, {
    stables: [
      "capacityReservationGroupName",
      "capacityReservationGroupId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* compute
        .ListCapacityReservationGroupBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage(
              "ListCapacityReservationGroupBySubscription",
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
          !sameId(news.name, output.capacityReservationGroupName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        !sameSet(news.zones, output.zones) ||
        !sameId(
          news.reservationType ?? "Targeted",
          output.reservationType ?? "Targeted",
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
        output?.capacityReservationGroupName ??
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
        output?.capacityReservationGroupName ??
        (yield* createComputeName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        capacityReservationGroupName: name,
      };

      // Observe.
      let observed = yield* getGroup(subscriptionId, resourceGroup, name);

      // Ensure (synchronous PUT).
      if (observed === undefined) {
        observed = yield* compute.CapacityReservationGroupsCreateOrUpdate({
          ...where,
          location,
          tags,
          zones: news.zones,
          properties: {
            reservationType: news.reservationType,
            sharingProfile: sharingProfile(news.sharedSubscriptionIds),
          },
        });
      } else {
        // Sync sharing and tags against observed state.
        const sharingChanged =
          news.sharedSubscriptionIds !== undefined &&
          !sameSet(
            sharedIds(observed),
            sharingProfile(news.sharedSubscriptionIds)?.subscriptionIds.map(
              (s) => s.id,
            ),
          );
        const tagsChanged = tagsDiffer(observed.tags, tags);
        if (sharingChanged || tagsChanged) {
          observed = yield* compute.UpdateCapacityReservationGroup({
            ...where,
            tags: tagsChanged ? tags : undefined,
            properties: sharingChanged
              ? { sharingProfile: sharingProfile(news.sharedSubscriptionIds) }
              : undefined,
          });
        }
      }
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        compute.DeleteCapacityReservationGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          capacityReservationGroupName: output.capacityReservationGroupName,
        }),
      ).pipe(Effect.retry(whileMembersRemain));
      yield* waitComputeGone(
        `capacity reservation group ${output.capacityReservationGroupName}`,
        getGroup(
          subscriptionId,
          output.resourceGroup,
          output.capacityReservationGroupName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
