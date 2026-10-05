import * as elasticsan from "@distilled.cloud/azure/elasticsan";
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
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createSanName, getElasticSan, lower } from "./Common.ts";

export type ElasticSanSkuName = "Premium_LRS" | "Premium_ZRS";

/** Automatic capacity scale-up settings of an Elastic SAN. */
export interface ElasticSanScaleUpProperties {
  /** Unused capacity (TiB) that triggers a scale-up when reached. */
  unusedSizeTiB?: number;
  /** Capacity (TiB) added on each scale-up. */
  increaseCapacityUnitByTiB?: number;
  /** Upper limit (TiB) the SAN may scale up to. */
  capacityUnitScaleUpLimitTiB?: number;
  /** Whether automatic scale-up is enabled. */
  autoScalePolicyEnforcement?: "None" | "Enabled" | "Disabled";
}

export interface ElasticSanProps {
  /** Resource group the SAN is created in. Changing it replaces the SAN. */
  resourceGroup: string;
  /**
   * SAN name: 3-24 lowercase letters, digits, hyphens and underscores,
   * starting and ending with a letter or digit. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the SAN.
   */
  name?: string;
  /**
   * Azure location of the SAN. Elastic SAN is available in a subset of
   * regions. Changing it replaces the SAN.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Redundancy SKU. Redundancy cannot be changed in place; changing it
   * replaces the SAN.
   * @default "Premium_LRS"
   */
  sku?: ElasticSanSkuName;
  /**
   * Availability zone (LRS only), e.g. `["1"]`. Changing it replaces the
   * SAN.
   */
  availabilityZones?: string[];
  /**
   * Base capacity in TiB. Base capacity provisions performance (IOPS and
   * throughput) and is billed per TiB. Can be increased in place.
   * @default 1
   */
  baseSizeTiB?: number;
  /**
   * Additional capacity-only storage in TiB (cheaper than base capacity,
   * adds no performance).
   * @default 0
   */
  extendedCapacitySizeTiB?: number;
  /** Whether the SAN accepts traffic over public endpoints. */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /** Automatic capacity scale-up settings. */
  autoScaleProperties?: {
    /** Scale-up settings. */
    scaleUpProperties?: ElasticSanScaleUpProperties;
  };
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ElasticSan extends Resource<
  "Azure.ElasticSan.ElasticSan",
  ElasticSanProps,
  {
    /** Name of the SAN. */
    elasticSanName: string;
    /** ARM resource ID of the SAN. */
    elasticSanId: string;
    /** Resource group that holds the SAN. */
    resourceGroup: string;
    /** Location of the SAN. */
    location: string;
    /** Redundancy SKU. */
    sku: string;
    /** Availability zones of the SAN. */
    availabilityZones: string[];
    /** Base capacity in TiB. */
    baseSizeTiB: number;
    /** Extended capacity in TiB. */
    extendedCapacitySizeTiB: number;
    /** Total provisioned IOPS. */
    totalIops: number | undefined;
    /** Total provisioned throughput in MBps. */
    totalMBps: number | undefined;
    /** Total capacity in TiB. */
    totalSizeTiB: number | undefined;
    /** Total size of all provisioned volumes in GiB. */
    totalVolumeSizeGiB: number | undefined;
    /** Number of volume groups in the SAN. */
    volumeGroupCount: number | undefined;
    /** Public network access setting. */
    publicNetworkAccess: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Elastic SAN — a cloud-native storage area network that serves
 * block volumes over iSCSI. Capacity is provisioned on the SAN (base
 * capacity in 1 TiB units, billed hourly) and carved into volume groups and
 * volumes.
 *
 * @see https://learn.microsoft.com/azure/storage/elastic-san/elastic-san-introduction
 *
 * ### Creating an Elastic SAN
 * **Example:** Minimal SAN (1 TiB base capacity)
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("storage");
 * const san = yield* Azure.ElasticSan.ElasticSan("san", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Zone-redundant SAN with extra capacity
 * ```typescript
 * const san = yield* Azure.ElasticSan.ElasticSan("san", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Premium_ZRS",
 *   baseSizeTiB: 2,
 *   extendedCapacitySizeTiB: 4,
 *   publicNetworkAccess: "Disabled",
 * });
 * ```
 *
 * ### Auto Scaling
 * **Example:** Grow capacity automatically
 * ```typescript
 * const san = yield* Azure.ElasticSan.ElasticSan("san", {
 *   resourceGroup: group.resourceGroupName,
 *   autoScaleProperties: {
 *     scaleUpProperties: {
 *       autoScalePolicyEnforcement: "Enabled",
 *       unusedSizeTiB: 1,
 *       increaseCapacityUnitByTiB: 1,
 *       capacityUnitScaleUpLimitTiB: 10,
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ElasticSan = Resource<ElasticSan>("Azure.ElasticSan.ElasticSan");

type ObservedSan = elasticsan.GetElasticSanResponse;

const toAttrs = (
  resourceGroup: string,
  name: string,
  san: ObservedSan,
): ElasticSan["Attributes"] => {
  const p = san.properties;
  return {
    elasticSanName: name,
    elasticSanId: san.id ?? "",
    resourceGroup,
    location: san.location,
    sku: p?.sku?.name ?? "",
    availabilityZones: p?.availabilityZones ?? [],
    baseSizeTiB: p?.baseSizeTiB ?? 0,
    extendedCapacitySizeTiB: p?.extendedCapacitySizeTiB ?? 0,
    totalIops: p?.totalIops,
    totalMBps: p?.totalMBps,
    totalSizeTiB: p?.totalSizeTiB,
    totalVolumeSizeGiB: p?.totalVolumeSizeGiB,
    volumeGroupCount: p?.volumeGroupCount,
    publicNetworkAccess: p?.publicNetworkAccess,
    provisioningState: p?.provisioningState,
    tags: userTags(san.tags),
  };
};

const sameZones = (a: string[] | undefined, b: string[] | undefined) =>
  [...(a ?? [])].sort().join(",") === [...(b ?? [])].sort().join(",");

/** Whether every desired scale-up field matches the observed one. */
const scaleUpMatches = (
  observed: elasticsan.ScaleUpProperties | undefined,
  desired: ElasticSanScaleUpProperties | undefined,
) =>
  desired === undefined ||
  (Object.keys(desired) as (keyof ElasticSanScaleUpProperties)[]).every(
    (key) => desired[key] === undefined || observed?.[key] === desired[key],
  );

export const ElasticSanProvider = () =>
  Provider.succeed(ElasticSan, {
    stables: [
      "elasticSanName",
      "elasticSanId",
      "resourceGroup",
      "location",
      "sku",
      "availabilityZones",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* elasticsan
        .ListElasticSanBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListElasticSanBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((san) => {
        const group = resourceGroupOf(san.id);
        return hasAnyAlchemyTag(san.tags) &&
          group !== undefined &&
          san.name !== undefined
          ? [toAttrs(group, san.name, san)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.elasticSanName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        (news.sku ?? "Premium_LRS") !== output.sku ||
        (news.availabilityZones !== undefined &&
          !sameZones(news.availabilityZones, output.availabilityZones))
      ) {
        // An explicit, unchanged name cannot be held by two generations.
        return {
          action: "replace",
          deleteFirst:
            news.name !== undefined && news.name === output.elasticSanName,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.elasticSanName ?? olds?.name ?? (yield* createSanName(id, 24));
      const observed = yield* getElasticSan(
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
      yield* ensureRegistered(subscriptionId, "Microsoft.ElasticSan");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.elasticSanName ?? (yield* createSanName(id, 24));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const baseSizeTiB = news.baseSizeTiB ?? 1;
      const extendedCapacitySizeTiB = news.extendedCapacitySizeTiB ?? 0;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        elasticSanName: name,
      };
      const label = `elastic san ${name}`;
      const get = getElasticSan(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(
        label,
        get,
        (san) => san.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is an async ARM operation.
      if (observed === undefined) {
        yield* elasticsan.CreateElasticSan({
          ...where,
          location,
          tags,
          properties: {
            sku: { name: news.sku ?? "Premium_LRS", tier: "Premium" },
            availabilityZones: news.availabilityZones,
            baseSizeTiB,
            extendedCapacitySizeTiB,
            publicNetworkAccess: news.publicNetworkAccess,
            autoScaleProperties: news.autoScaleProperties,
          },
        });
      }
      observed = yield* waitReady;

      // Sync mutable properties and tags against observed state.
      const p = observed.properties;
      const changed: elasticsan.ElasticSanUpdateProperties = {};
      if (p?.baseSizeTiB !== baseSizeTiB) changed.baseSizeTiB = baseSizeTiB;
      if (p?.extendedCapacitySizeTiB !== extendedCapacitySizeTiB) {
        changed.extendedCapacitySizeTiB = extendedCapacitySizeTiB;
      }
      if (
        news.publicNetworkAccess !== undefined &&
        p?.publicNetworkAccess !== news.publicNetworkAccess
      ) {
        changed.publicNetworkAccess = news.publicNetworkAccess;
      }
      if (
        !scaleUpMatches(
          p?.autoScaleProperties?.scaleUpProperties,
          news.autoScaleProperties?.scaleUpProperties,
        )
      ) {
        changed.autoScaleProperties = news.autoScaleProperties;
      }
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const hasChanges = Object.keys(changed).length > 0;
      if (hasChanges || tagsChanged) {
        yield* elasticsan.UpdateElasticSan({
          ...where,
          properties: hasChanges ? changed : undefined,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        elasticsan.DeleteElasticSan({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          elasticSanName: output.elasticSanName,
        }),
      );
      yield* waitUntilGone(
        `elastic san ${output.elasticSanName}`,
        getElasticSan(
          subscriptionId,
          output.resourceGroup,
          output.elasticSanName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
