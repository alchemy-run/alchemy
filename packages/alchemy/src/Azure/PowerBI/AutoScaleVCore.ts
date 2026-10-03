import * as powerbidedicated from "@distilled.cloud/azure/powerbidedicated";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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

export interface AutoScaleVCoreProps {
  /**
   * Resource group the auto scale v-core resource is created in. Changing
   * it replaces the resource.
   */
  resourceGroup: string;
  /**
   * Name of the auto scale v-core resource: 3-63 lowercase letters and
   * digits, starting with a letter. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the resource.
   */
  name?: string;
  /**
   * Azure location. Must match the region of the Power BI Premium
   * capacity. Changing it replaces the resource.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Object ID of the Power BI Premium Gen2 capacity that autoscales onto
   * this resource. Changing it replaces the resource.
   */
  capacityObjectId: string;
  /**
   * Maximum number of v-cores the capacity may autoscale to.
   */
  capacityLimit?: number;
  /**
   * Number of v-cores provisioned for the SKU.
   * @default 0
   */
  skuCapacity?: number;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AutoScaleVCore extends Resource<
  "Azure.PowerBI.AutoScaleVCore",
  AutoScaleVCoreProps,
  {
    /** Name of the auto scale v-core resource. */
    vcoreName: string;
    /** ARM resource ID of the auto scale v-core resource. */
    vcoreId: string;
    /** Resource group that holds the resource. */
    resourceGroup: string;
    /** Location of the resource. */
    location: string;
    /** Object ID of the associated Power BI Premium capacity. */
    capacityObjectId: string;
    /** Maximum autoscale v-cores. */
    capacityLimit: number | undefined;
    /** Number of v-cores provisioned for the SKU. */
    skuCapacity: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * Power BI Premium autoscale v-cores — the Azure resource that bills the
 * extra v-cores a Power BI Premium Gen2 capacity scales onto under load.
 * The Premium capacity itself is purchased through Microsoft 365 and
 * referenced by its object ID.
 *
 * @see https://learn.microsoft.com/power-bi/enterprise/service-premium-auto-scale
 *
 * ### Enabling Autoscale
 * **Example:** Autoscale a Premium capacity by up to 4 v-cores
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("analytics");
 * const vcores = yield* Azure.PowerBI.AutoScaleVCore("autoscale", {
 *   resourceGroup: group.resourceGroupName,
 *   capacityObjectId: "00000000-0000-0000-0000-000000000000",
 *   capacityLimit: 4,
 * });
 * ```
 *
 * @resource
 */
export const AutoScaleVCore = Resource<AutoScaleVCore>(
  "Azure.PowerBI.AutoScaleVCore",
);

type ObservedVCore = powerbidedicated.GetAutoScaleVCoreResponse;

const createVCoreName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 63,
    lowercase: true,
    delimiter: "",
  });
  const cleaned = name.replace(/[^a-z0-9]/g, "");
  return /^[a-z]/.test(cleaned) ? cleaned : `v${cleaned}`.slice(0, 63);
});

const getVCore = (
  subscriptionId: string,
  resourceGroupName: string,
  vcoreName: string,
) =>
  orUndefinedIfNotFound(
    powerbidedicated.GetAutoScaleVCore({
      subscriptionId,
      resourceGroupName,
      vcoreName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  vcore: ObservedVCore,
): AutoScaleVCore["Attributes"] => ({
  vcoreName: name,
  vcoreId: vcore.id ?? "",
  resourceGroup,
  location: vcore.location,
  capacityObjectId: vcore.properties?.capacityObjectId ?? "",
  capacityLimit: vcore.properties?.capacityLimit,
  skuCapacity: vcore.sku.capacity,
  tags: userTags(vcore.tags),
});

const lower = (value: string | undefined) =>
  value?.toLowerCase().replace(/\s/g, "");

export const AutoScaleVCoreProvider = () =>
  Provider.succeed(AutoScaleVCore, {
    stables: [
      "vcoreName",
      "vcoreId",
      "resourceGroup",
      "location",
      "capacityObjectId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* powerbidedicated
        .ListAutoScaleVCoreBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAutoScaleVCoreBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((vcore) => {
        const group = resourceGroupOf(vcore.id);
        return hasAnyAlchemyTag(vcore.tags) &&
          group !== undefined &&
          vcore.name !== undefined
          ? [toAttrs(group, vcore.name, vcore)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.vcoreName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        lower(news.capacityObjectId) !== lower(output.capacityObjectId)
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
        output?.vcoreName ?? olds?.name ?? (yield* createVCoreName(id));
      const observed = yield* getVCore(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.PowerBIDedicated");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.vcoreName ?? (yield* createVCoreName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = {
        name: "AutoScale",
        tier: "AutoScale",
        capacity: news.skuCapacity ?? 0,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        vcoreName: name,
      };

      // Observe.
      let observed = yield* getVCore(subscriptionId, resourceGroup, name);

      // Ensure. The PUT is synchronous.
      if (observed === undefined) {
        observed = yield* powerbidedicated.CreateAutoScaleVCore({
          ...where,
          location,
          sku,
          tags,
          properties: {
            capacityObjectId: news.capacityObjectId,
            capacityLimit: news.capacityLimit,
          },
        });
      }

      // Sync the limit, SKU capacity, and tags against observed state.
      const limitChanged =
        news.capacityLimit !== undefined &&
        observed.properties?.capacityLimit !== news.capacityLimit;
      const skuChanged = (observed.sku.capacity ?? 0) !== sku.capacity;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (limitChanged || skuChanged || tagsChanged) {
        observed = yield* powerbidedicated.UpdateAutoScaleVCore({
          ...where,
          sku: skuChanged ? sku : undefined,
          tags: tagsChanged ? tags : undefined,
          properties: limitChanged
            ? { capacityLimit: news.capacityLimit }
            : undefined,
        });
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        powerbidedicated.DeleteAutoScaleVCore({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vcoreName: output.vcoreName,
        }),
      );
      yield* waitUntilGone(
        `Power BI auto scale v-core ${output.vcoreName}`,
        getVCore(subscriptionId, output.resourceGroup, output.vcoreName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
