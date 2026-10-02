import * as sql from "@distilled.cloud/azure/sql";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createDnsName,
  lower,
  sameId,
  skuMatches,
  type SqlSku,
} from "./common.ts";

export interface InstancePoolProps {
  /** Resource group the pool is created in. Changing it replaces the pool. */
  resourceGroup: string;
  /**
   * Pool name: 1-63 lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the pool.
   */
  name?: string;
  /**
   * Azure location of the pool. Changing it replaces the pool.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of a subnet delegated to `Microsoft.Sql/managedInstances`.
   * Changing it replaces the pool.
   */
  subnetId: string;
  /** Number of vCores in the pool (8, 16, 24, 32, 40, 64, or 80). */
  vCores: number;
  /**
   * License model (`LicenseIncluded` or Azure Hybrid Benefit `BasePrice`).
   * @default "LicenseIncluded"
   */
  licenseType?: "LicenseIncluded" | "BasePrice";
  /**
   * Pool SKU. Only General Purpose is supported.
   * @default { name: "GP_Gen5", tier: "GeneralPurpose", family: "Gen5" }
   */
  sku?: SqlSku;
  /** Maintenance configuration ARM ID. */
  maintenanceConfigurationId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface InstancePool extends Resource<
  "Azure.Sql.InstancePool",
  InstancePoolProps,
  {
    /** Name of the instance pool. */
    instancePoolName: string;
    /** ARM resource ID of the pool. */
    instancePoolId: string;
    /** Resource group that holds the pool. */
    resourceGroup: string;
    /** Location of the pool. */
    location: string;
    /** ARM ID of the subnet. */
    subnetId: string | undefined;
    /** Number of vCores in the pool. */
    vCores: number | undefined;
    /** License model. */
    licenseType: string | undefined;
    /** DNS zone shared by instances in the pool. */
    dnsZone: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure SQL Managed Instance pool — pre-provisioned vCores in a
 * delegated subnet that small managed instances can be packed into.
 *
 * Provisioning builds a virtual cluster and can take several hours; the
 * smallest pool has 8 vCores.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/managed-instance/instance-pools-overview
 *
 * ### Creating an Instance Pool
 * **Example:** 8 vCore General Purpose pool
 * ```typescript
 * const pool = yield* Azure.Sql.InstancePool("pool", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: miSubnetId,
 *   vCores: 8,
 * });
 * ```
 *
 * **Example:** Pool with Azure Hybrid Benefit and tags
 * ```typescript
 * const pool = yield* Azure.Sql.InstancePool("pool", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: miSubnetId,
 *   vCores: 16,
 *   licenseType: "BasePrice",
 *   tags: { team: "data" },
 * });
 * ```
 *
 * @resource
 */
export const InstancePool = Resource<InstancePool>("Azure.Sql.InstancePool");

type ObservedPool = sql.GetInstancePoolResponse;

const DEFAULT_SKU: SqlSku = {
  name: "GP_Gen5",
  tier: "GeneralPurpose",
  family: "Gen5",
};

const getPool = (
  subscriptionId: string,
  resourceGroupName: string,
  instancePoolName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetInstancePool({
      subscriptionId,
      resourceGroupName,
      instancePoolName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  pool: ObservedPool,
): InstancePool["Attributes"] => ({
  instancePoolName: name,
  instancePoolId: pool.id ?? "",
  resourceGroup,
  location: pool.location,
  subnetId: pool.properties?.subnetId,
  vCores: pool.properties?.vCores,
  licenseType: pool.properties?.licenseType,
  dnsZone: pool.properties?.dnsZone,
  tags: userTags(pool.tags),
});

/** Instance pool operations run for hours: poll every minute for up to 6 h. */
const SLOW = { interval: "60 seconds", times: 360 } as const;

export const InstancePoolProvider = () =>
  Provider.succeed(InstancePool, {
    stables: [
      "instancePoolName",
      "instancePoolId",
      "resourceGroup",
      "location",
      "subnetId",
      "dnsZone",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* sql
        .ListInstancePools({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListInstancePools", page),
          ),
        );
      return (page.value ?? []).flatMap((pool) => {
        const group = resourceGroupOf(pool.id);
        return hasAnyAlchemyTag(pool.tags) &&
          group !== undefined &&
          pool.name !== undefined
          ? [toAttrs(group, pool.name, pool)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.instancePoolName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        (output.subnetId !== undefined &&
          !sameId(news.subnetId, output.subnetId))
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
        output?.instancePoolName ?? olds?.name ?? (yield* createDnsName(id));
      const observed = yield* getPool(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.instancePoolName ?? (yield* createDnsName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? DEFAULT_SKU;
      const properties: sql.InstancePoolPropertiesInput = {
        subnetId: news.subnetId,
        vCores: news.vCores,
        licenseType: news.licenseType ?? "LicenseIncluded",
        maintenanceConfigurationId: news.maintenanceConfigurationId,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        instancePoolName: name,
      };
      const get = getPool(subscriptionId, resourceGroup, name);
      const propsMatch = (pool: ObservedPool) =>
        pool.properties?.vCores === properties.vCores &&
        lower(pool.properties?.licenseType) === lower(properties.licenseType) &&
        (properties.maintenanceConfigurationId === undefined ||
          sameId(
            pool.properties?.maintenanceConfigurationId,
            properties.maintenanceConfigurationId,
          ));

      // Observe.
      let observed = yield* get;

      // Ensure. Creation builds a virtual cluster (hours).
      if (observed === undefined) {
        yield* sql.InstancePoolsCreateOrUpdate({
          ...where,
          location,
          tags,
          sku,
          properties,
        });
      }
      observed = yield* waitForProvisioned(
        `sql instance pool ${name}`,
        get,
        () => undefined,
        SLOW,
      );

      // Sync mutable aspects against the observed pool.
      const propsChanged = !propsMatch(observed);
      const skuChanged = !skuMatches(observed.sku, sku);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propsChanged || skuChanged || tagsChanged) {
        yield* sql.UpdateInstancePool({
          ...where,
          // PATCH requires the full properties block (subnet, vCores, license).
          properties: propsChanged ? properties : undefined,
          sku: skuChanged ? sku : undefined,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitForProvisioned(
          `sql instance pool ${name}`,
          get,
          (pool) =>
            propsMatch(pool) &&
            skuMatches(pool.sku, sku) &&
            !tagsDiffer(pool.tags, tags)
              ? "Succeeded"
              : "Updating",
          SLOW,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteInstancePool({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          instancePoolName: output.instancePoolName,
        }),
      );
      yield* waitUntilGone(
        `sql instance pool ${output.instancePoolName}`,
        getPool(subscriptionId, output.resourceGroup, output.instancePoolName),
        SLOW,
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Network.Subnet"],
    },
  });
