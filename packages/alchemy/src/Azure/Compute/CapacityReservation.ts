import * as compute from "@distilled.cloud/azure/compute";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
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
  waitComputeProvisioned,
  whileComputeBusy,
} from "./common.ts";

export interface CapacityReservationProps {
  /**
   * Resource group of the capacity reservation group. Changing it replaces
   * the reservation.
   */
  resourceGroup: string;
  /**
   * Name of the capacity reservation group. Changing it replaces the
   * reservation.
   */
  capacityReservationGroup: string;
  /**
   * Name of the reservation. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the reservation.
   */
  name?: string;
  /**
   * Location of the reservation.
   * @default the capacity reservation group's location
   */
  location?: string;
  /**
   * Availability zone of the reservation (at most one; must be one of the
   * group's zones). Changing it replaces the reservation.
   */
  zones?: string[];
  /**
   * VM size to reserve, e.g. `Standard_D2s_v5`. Changing it replaces the
   * reservation.
   */
  sku: string;
  /**
   * Number of VM instances to reserve. Updated in place (`0` keeps the
   * reservation without billing for capacity).
   * @default 1
   */
  capacity?: number;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface CapacityReservation extends Resource<
  "Azure.Compute.CapacityReservation",
  CapacityReservationProps,
  {
    /** Name of the reservation. */
    capacityReservationName: string;
    /** ARM resource ID of the reservation. */
    capacityReservationId: string;
    /** Unique ID Azure assigned to the reservation. */
    reservationId: string | undefined;
    /** Name of the capacity reservation group. */
    capacityReservationGroup: string;
    /** Resource group of the group. */
    resourceGroup: string;
    /** Location of the reservation. */
    location: string;
    /** Zones of the reservation. */
    zones: string[];
    /** Reserved VM size. */
    sku: string | undefined;
    /** Number of reserved instances. */
    capacity: number | undefined;
    /** ARM IDs of the VMs consuming the reservation. */
    virtualMachineIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure on-demand capacity reservation — guaranteed capacity for a
 * number of VMs of one size, inside a `CapacityReservationGroup`. The
 * reserved capacity bills at the pay-as-you-go rate whether VMs use it or
 * not, and counts against the regional vCPU quota. Free trial
 * subscriptions cannot create reservations.
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/capacity-reservation-overview
 *
 * ### Reserving Capacity
 * **Example:** Two D2s_v5 instances in zone 1
 * ```typescript
 * const reservations = yield* Azure.Compute.CapacityReservationGroup("prod", {
 *   resourceGroup: group.resourceGroupName,
 *   zones: ["1"],
 * });
 * const reservation = yield* Azure.Compute.CapacityReservation("d2", {
 *   resourceGroup: group.resourceGroupName,
 *   capacityReservationGroup: reservations.capacityReservationGroupName,
 *   sku: "Standard_D2s_v5",
 *   capacity: 2,
 *   zones: ["1"],
 * });
 * ```
 *
 * ### Pausing a Reservation
 * **Example:** Keep the reservation without reserved capacity
 * ```typescript
 * yield* Azure.Compute.CapacityReservation("d2", {
 *   resourceGroup: group.resourceGroupName,
 *   capacityReservationGroup: reservations.capacityReservationGroupName,
 *   sku: "Standard_D2s_v5",
 *   capacity: 0,
 *   zones: ["1"],
 * });
 * ```
 *
 * @resource
 */
export const CapacityReservation = Resource<CapacityReservation>(
  "Azure.Compute.CapacityReservation",
);

type Observed = compute.GetCapacityReservationResponse;

const getReservation = (
  subscriptionId: string,
  resourceGroupName: string,
  capacityReservationGroupName: string,
  capacityReservationName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetCapacityReservation({
      subscriptionId,
      resourceGroupName,
      capacityReservationGroupName,
      capacityReservationName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  groupName: string,
  name: string,
  reservation: Observed,
): CapacityReservation["Attributes"] => ({
  capacityReservationName: name,
  capacityReservationId: reservation.id ?? "",
  reservationId: reservation.properties?.reservationId,
  capacityReservationGroup: groupName,
  resourceGroup,
  location: reservation.location,
  zones: [...(reservation.zones ?? [])],
  sku: reservation.sku?.name,
  capacity: reservation.sku?.capacity,
  virtualMachineIds: idsOf(reservation.properties?.virtualMachinesAssociated),
  tags: userTags(reservation.tags),
});

export const CapacityReservationProvider = () =>
  Provider.succeed(CapacityReservation, {
    stables: [
      "capacityReservationName",
      "capacityReservationId",
      "reservationId",
      "capacityReservationGroup",
      "resourceGroup",
      "location",
    ],

    // Reservations live inside their group; the group's delete waits for
    // them, and nuke deletes the resource group.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(
          news.capacityReservationGroup,
          output.capacityReservationGroup,
        ) ||
        (news.name !== undefined &&
          !sameId(news.name, output.capacityReservationName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        !sameSet(news.zones, output.zones) ||
        !sameId(news.sku, output.sku)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const groupName =
        output?.capacityReservationGroup ?? olds?.capacityReservationGroup;
      if (resourceGroup === undefined || groupName === undefined) {
        return undefined;
      }
      const name =
        output?.capacityReservationName ??
        olds?.name ??
        (yield* createComputeName(id));
      const observed = yield* getReservation(
        subscriptionId,
        resourceGroup,
        groupName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, groupName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Compute");
      const resourceGroup = news.resourceGroup;
      const groupName = news.capacityReservationGroup;
      const name =
        news.name ??
        output?.capacityReservationName ??
        (yield* createComputeName(id));
      const groupLocation = yield* orUndefinedIfNotFound(
        compute.GetCapacityReservationGroup({
          subscriptionId,
          resourceGroupName: resourceGroup,
          capacityReservationGroupName: groupName,
        }),
      ).pipe(Effect.map((group) => group?.location));
      const location =
        news.location ?? output?.location ?? groupLocation ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const capacity = news.capacity ?? 1;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        capacityReservationGroupName: groupName,
        capacityReservationName: name,
      };
      const label = `capacity reservation ${name}`;
      const get = getReservation(
        subscriptionId,
        resourceGroup,
        groupName,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Reserving capacity is a long-running operation.
      if (observed === undefined) {
        yield* compute
          .CapacityReservationsCreateOrUpdate({
            ...where,
            location,
            tags,
            zones: news.zones,
            sku: { name: news.sku, capacity },
          })
          .pipe(Effect.retry(whileComputeBusy));
      }
      observed = yield* waitComputeProvisioned(label, get);

      // Sync capacity and tags against observed state.
      const capacityChanged = observed.sku?.capacity !== capacity;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (capacityChanged || tagsChanged) {
        yield* compute
          .UpdateCapacityReservation({
            ...where,
            tags: tagsChanged ? tags : undefined,
            sku: capacityChanged ? { name: news.sku, capacity } : undefined,
          })
          .pipe(Effect.retry(whileComputeBusy));
        observed = yield* waitComputeProvisioned(label, get);
      }
      return toAttrs(resourceGroup, groupName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        compute.DeleteCapacityReservation({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          capacityReservationGroupName: output.capacityReservationGroup,
          capacityReservationName: output.capacityReservationName,
        }),
      ).pipe(Effect.retry(whileComputeBusy));
      yield* waitComputeGone(
        `capacity reservation ${output.capacityReservationName}`,
        getReservation(
          subscriptionId,
          output.resourceGroup,
          output.capacityReservationGroup,
          output.capacityReservationName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Compute.CapacityReservationGroup",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
