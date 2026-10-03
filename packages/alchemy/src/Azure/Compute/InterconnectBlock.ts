import * as compute from "@distilled.cloud/azure/compute";
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

export interface InterconnectBlockProps {
  /**
   * Resource group the interconnect block is created in. Changing it
   * replaces the block.
   */
  resourceGroup: string;
  /**
   * Name of the interconnect block. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the block.
   */
  name?: string;
  /**
   * Azure location of the block. Changing it replaces the block.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Availability zone of the block. Changing it replaces the block.
   */
  zones?: string[];
  /**
   * VM size the block reserves high-speed interconnect capacity for.
   * Changing it replaces the block.
   */
  sku: string;
  /**
   * Number of VMs in the block. Updated in place.
   */
  capacity?: number;
  /**
   * ARM ID of the interconnect group the block belongs to. Changing it
   * replaces the block.
   */
  interconnectGroupId: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface InterconnectBlock extends Resource<
  "Azure.Compute.InterconnectBlock",
  InterconnectBlockProps,
  {
    /** Name of the interconnect block. */
    interconnectBlockName: string;
    /** ARM resource ID of the block. */
    interconnectBlockResourceId: string;
    /** Unique ID Azure assigned to the block. */
    interconnectBlockId: string | undefined;
    /** Resource group that holds the block. */
    resourceGroup: string;
    /** Location of the block. */
    location: string;
    /** Zones of the block. */
    zones: string[];
    /** VM size of the block. */
    sku: string | undefined;
    /** Number of VMs in the block. */
    capacity: number | undefined;
    /** ARM IDs of the VMs associated with the block. */
    virtualMachineIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure interconnect block — a placement construct that reserves VMs on
 * a high-speed interconnect (InfiniBand / NVLink fabric) for HPC and AI
 * clusters. Interconnect blocks are a preview, allow-listed feature for
 * GPU/HPC VM sizes; other subscriptions are rejected.
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/overview
 *
 * ### Creating an Interconnect Block
 * **Example:** Block of GPU VMs in an interconnect group
 * ```typescript
 * const block = yield* Azure.Compute.InterconnectBlock("training", {
 *   resourceGroup: group.resourceGroupName,
 *   zones: ["1"],
 *   sku: "Standard_ND96isr_H100_v5",
 *   capacity: 4,
 *   interconnectGroupId: interconnectGroupId,
 * });
 * ```
 *
 * @resource
 */
export const InterconnectBlock = Resource<InterconnectBlock>(
  "Azure.Compute.InterconnectBlock",
);

type Observed = compute.GetInterconnectBlockResponse;

const getBlock = (
  subscriptionId: string,
  resourceGroupName: string,
  interconnectBlockName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetInterconnectBlock({
      subscriptionId,
      resourceGroupName,
      interconnectBlockName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  block: Observed,
): InterconnectBlock["Attributes"] => ({
  interconnectBlockName: name,
  interconnectBlockResourceId: block.id ?? "",
  interconnectBlockId: block.properties?.interconnectBlockId,
  resourceGroup,
  location: block.location,
  zones: [...(block.zones ?? [])],
  sku: block.sku?.name,
  capacity: block.sku?.capacity,
  virtualMachineIds: idsOf(block.properties?.virtualMachinesAssociated),
  tags: userTags(block.tags),
});

export const InterconnectBlockProvider = () =>
  Provider.succeed(InterconnectBlock, {
    stables: [
      "interconnectBlockName",
      "interconnectBlockResourceId",
      "interconnectBlockId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* compute
        .ListInterconnectBlockBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListInterconnectBlockBySubscription", page),
          ),
        );
      return page.value.flatMap((block) => {
        const resourceGroup = resourceGroupOf(block.id);
        return hasAnyAlchemyTag(block.tags) &&
          resourceGroup !== undefined &&
          block.name !== undefined
          ? [toAttrs(resourceGroup, block.name, block)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.interconnectBlockName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        !sameSet(news.zones, output.zones) ||
        !sameId(news.sku, output.sku) ||
        (olds !== undefined &&
          !sameId(news.interconnectGroupId, olds.interconnectGroupId))
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
        output?.interconnectBlockName ??
        olds?.name ??
        (yield* createComputeName(id));
      const observed = yield* getBlock(subscriptionId, resourceGroup, name);
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
        output?.interconnectBlockName ??
        (yield* createComputeName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        interconnectBlockName: name,
      };
      const label = `interconnect block ${name}`;
      const get = getBlock(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* compute
          .InterconnectBlocksCreateOrUpdate({
            ...where,
            location,
            tags,
            zones: news.zones,
            sku: { name: news.sku, capacity: news.capacity },
            properties: { interconnectGroup: { id: news.interconnectGroupId } },
          })
          .pipe(Effect.retry(whileComputeBusy));
      }
      observed = yield* waitComputeProvisioned(label, get);

      // Sync capacity and tags against observed state.
      const capacityChanged =
        news.capacity !== undefined && observed.sku?.capacity !== news.capacity;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (capacityChanged || tagsChanged) {
        yield* compute
          .UpdateInterconnectBlock({
            ...where,
            tags: tagsChanged ? tags : undefined,
            sku: capacityChanged
              ? { name: news.sku, capacity: news.capacity }
              : undefined,
          })
          .pipe(Effect.retry(whileComputeBusy));
        observed = yield* waitComputeProvisioned(label, get);
      }
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        compute.DeleteInterconnectBlock({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          interconnectBlockName: output.interconnectBlockName,
        }),
      ).pipe(Effect.retry(whileComputeBusy));
      yield* waitComputeGone(
        `interconnect block ${output.interconnectBlockName}`,
        getBlock(
          subscriptionId,
          output.resourceGroup,
          output.interconnectBlockName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
