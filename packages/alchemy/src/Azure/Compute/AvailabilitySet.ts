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
  ref,
  sameId,
  waitComputeGone,
} from "./common.ts";

export interface AvailabilitySetProps {
  /**
   * Resource group the availability set is created in. Changing it replaces
   * the availability set.
   */
  resourceGroup: string;
  /**
   * Name of the availability set: 1-80 letters, digits, `_`, `.`, and `-`.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the availability set.
   */
  name?: string;
  /**
   * Azure location of the availability set. Changing it replaces the
   * availability set.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * `Aligned` for VMs with managed disks, `Classic` for unmanaged disks.
   * Changing it replaces the availability set.
   * @default "Aligned"
   */
  sku?: "Aligned" | "Classic";
  /**
   * Number of fault domains (1-3, region dependent). Changing it replaces
   * the availability set.
   * @default 2
   */
  platformFaultDomainCount?: number;
  /**
   * Number of update domains (1-20). Changing it replaces the availability
   * set.
   * @default 5
   */
  platformUpdateDomainCount?: number;
  /**
   * ARM ID of a proximity placement group to place the set in. Can only be
   * changed while the set has no VMs.
   */
  proximityPlacementGroupId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AvailabilitySet extends Resource<
  "Azure.Compute.AvailabilitySet",
  AvailabilitySetProps,
  {
    /** Name of the availability set. */
    availabilitySetName: string;
    /** ARM resource ID of the availability set; pass it to a VM. */
    availabilitySetId: string;
    /** Resource group that holds the availability set. */
    resourceGroup: string;
    /** Location of the availability set. */
    location: string;
    /** SKU (`Aligned` or `Classic`). */
    sku: string;
    /** Number of fault domains. */
    platformFaultDomainCount: number | undefined;
    /** Number of update domains. */
    platformUpdateDomainCount: number | undefined;
    /** ARM ID of the proximity placement group, if any. */
    proximityPlacementGroupId: string | undefined;
    /** ARM IDs of the VMs in the set. */
    virtualMachineIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure availability set — a logical grouping that spreads VMs across
 * fault and update domains so a hardware failure or planned maintenance
 * does not take all of them down. Availability sets are free.
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/availability-set-overview
 *
 * ### Creating an Availability Set
 * **Example:** Two fault domains, five update domains
 * ```typescript
 * const set = yield* Azure.Compute.AvailabilitySet("web", {
 *   resourceGroup: group.resourceGroupName,
 *   platformFaultDomainCount: 2,
 *   platformUpdateDomainCount: 5,
 * });
 * ```
 *
 * ### Placing VMs in the Set
 * **Example:** VM in an availability set
 * ```typescript
 * const vm = yield* Azure.Compute.VirtualMachine("web-1", {
 *   resourceGroup: group.resourceGroupName,
 *   availabilitySetId: set.availabilitySetId,
 *   vmSize: "Standard_B1s",
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 * });
 * ```
 *
 * @resource
 */
export const AvailabilitySet = Resource<AvailabilitySet>(
  "Azure.Compute.AvailabilitySet",
);

type Observed = compute.GetAvailabilitySetResponse;

const getSet = (
  subscriptionId: string,
  resourceGroupName: string,
  availabilitySetName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetAvailabilitySet({
      subscriptionId,
      resourceGroupName,
      availabilitySetName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  set: Observed,
): AvailabilitySet["Attributes"] => ({
  availabilitySetName: name,
  availabilitySetId: set.id ?? "",
  resourceGroup,
  location: set.location,
  sku: set.sku?.name ?? "",
  platformFaultDomainCount: set.properties?.platformFaultDomainCount,
  platformUpdateDomainCount: set.properties?.platformUpdateDomainCount,
  proximityPlacementGroupId: set.properties?.proximityPlacementGroup?.id,
  virtualMachineIds: idsOf(set.properties?.virtualMachines),
  tags: userTags(set.tags),
});

/** Delete is rejected while VMs are still members (released shortly after). */
const whileMembersRemain = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "OperationNotAllowed" || e._tag === "ResourceConflict",
  schedule: Schedule.spaced("5 seconds"),
  times: 24,
} as const;

export const AvailabilitySetProvider = () =>
  Provider.succeed(AvailabilitySet, {
    stables: [
      "availabilitySetName",
      "availabilitySetId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* compute
        .ListAvailabilitySetBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAvailabilitySetBySubscription", page),
          ),
        );
      return page.value.flatMap((set) => {
        const resourceGroup = resourceGroupOf(set.id);
        return hasAnyAlchemyTag(set.tags) &&
          resourceGroup !== undefined &&
          set.name !== undefined
          ? [toAttrs(resourceGroup, set.name, set)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.availabilitySetName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        !sameId(news.sku ?? "Aligned", output.sku) ||
        (news.platformFaultDomainCount ?? 2) !==
          output.platformFaultDomainCount ||
        (news.platformUpdateDomainCount ?? 5) !==
          output.platformUpdateDomainCount
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
        output?.availabilitySetName ??
        olds?.name ??
        (yield* createComputeName(id));
      const observed = yield* getSet(subscriptionId, resourceGroup, name);
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
        output?.availabilitySetName ??
        (yield* createComputeName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        availabilitySetName: name,
      };

      // Observe.
      let observed = yield* getSet(subscriptionId, resourceGroup, name);

      // Ensure (synchronous PUT).
      if (observed === undefined) {
        observed = yield* compute.AvailabilitySetsCreateOrUpdate({
          ...where,
          location,
          tags,
          sku: { name: news.sku ?? "Aligned" },
          properties: {
            platformFaultDomainCount: news.platformFaultDomainCount ?? 2,
            platformUpdateDomainCount: news.platformUpdateDomainCount ?? 5,
            proximityPlacementGroup: ref(news.proximityPlacementGroupId),
          },
        });
      } else {
        // Sync tags and proximity placement group against observed state.
        const ppgChanged =
          news.proximityPlacementGroupId !== undefined &&
          !sameId(
            observed.properties?.proximityPlacementGroup?.id,
            news.proximityPlacementGroupId,
          );
        const tagsChanged = tagsDiffer(observed.tags, tags);
        if (ppgChanged || tagsChanged) {
          observed = yield* compute.UpdateAvailabilitySet({
            ...where,
            tags: tagsChanged ? tags : undefined,
            properties: ppgChanged
              ? {
                  proximityPlacementGroup: ref(news.proximityPlacementGroupId),
                }
              : undefined,
          });
        }
      }
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        compute.DeleteAvailabilitySet({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          availabilitySetName: output.availabilitySetName,
        }),
      ).pipe(Effect.retry(whileMembersRemain));
      yield* waitComputeGone(
        `availability set ${output.availabilitySetName}`,
        getSet(
          subscriptionId,
          output.resourceGroup,
          output.availabilitySetName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
