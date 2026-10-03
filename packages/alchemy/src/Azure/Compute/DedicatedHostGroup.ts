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

export interface DedicatedHostGroupProps {
  /**
   * Resource group the host group is created in. Changing it replaces the
   * host group.
   */
  resourceGroup: string;
  /**
   * Name of the host group: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the host group.
   */
  name?: string;
  /**
   * Azure location of the host group. Changing it replaces the host group.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Availability zone to pin the group's hosts to (at most one). Changing
   * it replaces the host group.
   */
  zones?: string[];
  /**
   * Number of fault domains hosts can be spread over (1-3). Changing it
   * replaces the host group.
   * @default 1
   */
  platformFaultDomainCount?: number;
  /**
   * Let Azure pick the host for VMs that reference the group (instead of a
   * specific host). Changing it replaces the host group.
   * @default false
   */
  supportAutomaticPlacement?: boolean;
  /**
   * Allow Ultra SSD disks on VMs in the group. Changing it replaces the
   * host group.
   * @default false
   */
  ultraSSDEnabled?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface DedicatedHostGroup extends Resource<
  "Azure.Compute.DedicatedHostGroup",
  DedicatedHostGroupProps,
  {
    /** Name of the host group. */
    hostGroupName: string;
    /** ARM resource ID of the host group. */
    hostGroupId: string;
    /** Resource group that holds the host group. */
    resourceGroup: string;
    /** Location of the host group. */
    location: string;
    /** Zones of the host group. */
    zones: string[];
    /** Number of fault domains. */
    platformFaultDomainCount: number;
    /** Whether automatic placement is enabled. */
    supportAutomaticPlacement: boolean;
    /** ARM IDs of the dedicated hosts in the group. */
    hostIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure dedicated host group — a container for dedicated hosts
 * (physical servers reserved for one subscription). The empty group is
 * free; hosts bill per hour.
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/dedicated-hosts
 *
 * ### Creating a Host Group
 * **Example:** Two fault domains in zone 1
 * ```typescript
 * const hostGroup = yield* Azure.Compute.DedicatedHostGroup("isolated", {
 *   resourceGroup: group.resourceGroupName,
 *   zones: ["1"],
 *   platformFaultDomainCount: 2,
 * });
 * ```
 *
 * ### Automatic Placement
 * **Example:** VMs placed on any host in the group
 * ```typescript
 * const hostGroup = yield* Azure.Compute.DedicatedHostGroup("isolated", {
 *   resourceGroup: group.resourceGroupName,
 *   supportAutomaticPlacement: true,
 * });
 * yield* Azure.Compute.DedicatedHost("host-1", {
 *   resourceGroup: group.resourceGroupName,
 *   hostGroup: hostGroup.hostGroupName,
 *   sku: "DSv3-Type4",
 * });
 * ```
 *
 * @resource
 */
export const DedicatedHostGroup = Resource<DedicatedHostGroup>(
  "Azure.Compute.DedicatedHostGroup",
);

type Observed = compute.GetDedicatedHostGroupResponse;

const getGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  hostGroupName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetDedicatedHostGroup({
      subscriptionId,
      resourceGroupName,
      hostGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  group: Observed,
): DedicatedHostGroup["Attributes"] => ({
  hostGroupName: name,
  hostGroupId: group.id ?? "",
  resourceGroup,
  location: group.location,
  zones: [...(group.zones ?? [])],
  platformFaultDomainCount: group.properties?.platformFaultDomainCount ?? 1,
  supportAutomaticPlacement:
    group.properties?.supportAutomaticPlacement ?? false,
  hostIds: idsOf(group.properties?.hosts),
  tags: userTags(group.tags),
});

/** Delete is rejected while hosts remain (released shortly after). */
const whileHostsRemain = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "OperationNotAllowed" || e._tag === "ResourceConflict",
  schedule: Schedule.spaced("5 seconds"),
  times: 24,
} as const;

export const DedicatedHostGroupProvider = () =>
  Provider.succeed(DedicatedHostGroup, {
    stables: ["hostGroupName", "hostGroupId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* compute
        .ListDedicatedHostGroupBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListDedicatedHostGroupBySubscription", page),
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

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameId(news.name, output.hostGroupName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        !sameSet(news.zones, output.zones) ||
        (news.platformFaultDomainCount ?? 1) !==
          output.platformFaultDomainCount ||
        (news.supportAutomaticPlacement ?? false) !==
          output.supportAutomaticPlacement ||
        (olds !== undefined &&
          (news.ultraSSDEnabled ?? false) !== (olds.ultraSSDEnabled ?? false))
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
        output?.hostGroupName ?? olds?.name ?? (yield* createComputeName(id));
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
        news.name ?? output?.hostGroupName ?? (yield* createComputeName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const faultDomains = news.platformFaultDomainCount ?? 1;
      const automatic = news.supportAutomaticPlacement ?? false;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        hostGroupName: name,
      };

      // Observe.
      let observed = yield* getGroup(subscriptionId, resourceGroup, name);

      // Ensure (synchronous PUT).
      if (observed === undefined) {
        observed = yield* compute.DedicatedHostGroupsCreateOrUpdate({
          ...where,
          location,
          tags,
          zones: news.zones,
          properties: {
            platformFaultDomainCount: faultDomains,
            supportAutomaticPlacement: automatic,
            additionalCapabilities:
              news.ultraSSDEnabled === undefined
                ? undefined
                : { ultraSSDEnabled: news.ultraSSDEnabled },
          },
        });
      } else {
        // Sync tags (everything else is immutable).
        if (tagsDiffer(observed.tags, tags)) {
          observed = yield* compute.UpdateDedicatedHostGroup({
            ...where,
            tags,
          });
        }
      }
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        compute.DeleteDedicatedHostGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          hostGroupName: output.hostGroupName,
        }),
      ).pipe(Effect.retry(whileHostsRemain));
      yield* waitComputeGone(
        `dedicated host group ${output.hostGroupName}`,
        getGroup(subscriptionId, output.resourceGroup, output.hostGroupName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
