import * as netapp from "@distilled.cloud/azure/netapp";
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
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  accountLocation,
  createNetAppName,
  getPool,
  listAllPools,
  LRO_BUDGET,
  parseNetAppId,
  whileBusy,
} from "./Common.ts";

export type NetAppServiceLevel =
  | "Standard"
  | "Premium"
  | "Ultra"
  | "StandardZRS"
  | "Flexible";

/** 1 TiB in bytes — the minimum (and increment) of a capacity pool. */
export const TiB = 1_099_511_627_776;

export interface CapacityPoolProps {
  /** Resource group of the NetApp account. Changing it replaces the pool. */
  resourceGroup: string;
  /** Name of the parent NetApp account. Changing it replaces the pool. */
  account: string;
  /**
   * Pool name: 1-64 letters, digits, `-` and `_`. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the pool.
   */
  name?: string;
  /**
   * Provisioned size in bytes: a multiple of 1 TiB (`1099511627776`), at
   * least 1 TiB. The pool is billed on its provisioned size. Cannot shrink
   * below the sum of its volume quotas.
   * @default 1 TiB
   */
  size?: number;
  /**
   * Service level (throughput per TiB). Changing it replaces the pool.
   * @default "Standard"
   */
  serviceLevel?: NetAppServiceLevel;
  /**
   * Quality of service: `Auto` assigns throughput by volume quota;
   * `Manual` lets each volume set `throughputMibps`. `Auto` → `Manual`
   * happens in place; `Manual` → `Auto` replaces the pool.
   * @default "Auto"
   */
  qosType?: "Auto" | "Manual";
  /** Custom throughput of a `Flexible` pool, in MiB/s. */
  customThroughputMibps?: number;
  /**
   * Enable cool access (tiering of cold data). Can be enabled in place but
   * not disabled; disabling replaces the pool.
   */
  coolAccess?: boolean;
  /**
   * Encryption at rest: `Single` or `Double`. Changing it replaces the pool.
   * @default "Single"
   */
  encryptionType?: "Single" | "Double";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface CapacityPool extends Resource<
  "Azure.NetApp.CapacityPool",
  CapacityPoolProps,
  {
    /** Name of the pool. */
    poolName: string;
    /** ARM resource ID of the pool. */
    capacityPoolId: string;
    /** UUID of the pool. */
    poolId: string | undefined;
    /** Parent NetApp account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Location of the pool (same as the account). */
    location: string;
    /** Provisioned size in bytes. */
    size: number;
    /** Service level. */
    serviceLevel: string;
    /** Quality of service type. */
    qosType: string | undefined;
    /** Whether cool access is enabled. */
    coolAccess: boolean;
    /** Encryption type. */
    encryptionType: string | undefined;
    /** Total throughput of the pool in MiB/s. */
    totalThroughputMibps: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure NetApp Files capacity pool — provisioned capacity (in 1 TiB
 * steps) at a service level from which volumes are carved. Billed hourly
 * on its provisioned size (Standard ≈ $0.20/hour per TiB).
 *
 * @see https://learn.microsoft.com/azure/azure-netapp-files/azure-netapp-files-set-up-capacity-pool
 *
 * ### Creating a Capacity Pool
 * **Example:** 1 TiB Standard pool
 * ```typescript
 * const account = yield* Azure.NetApp.Account("files", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const pool = yield* Azure.NetApp.CapacityPool("pool", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 * });
 * ```
 *
 * ### Performance
 * **Example:** Premium pool with manual QoS
 * ```typescript
 * const pool = yield* Azure.NetApp.CapacityPool("pool", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   size: 2 * Azure.NetApp.TiB,
 *   serviceLevel: "Premium",
 *   qosType: "Manual",
 * });
 * ```
 *
 * @resource
 */
export const CapacityPool = Resource<CapacityPool>("Azure.NetApp.CapacityPool");

type ObservedPool = netapp.GetPoolResponse | netapp.CapacityPool;

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  pool: ObservedPool,
): CapacityPool["Attributes"] => ({
  poolName: name,
  capacityPoolId: pool.id ?? "",
  poolId: pool.properties?.poolId,
  account,
  resourceGroup,
  location: pool.location ?? "",
  size: pool.properties?.size ?? 0,
  serviceLevel: pool.properties?.serviceLevel ?? "",
  qosType: pool.properties?.qosType,
  coolAccess: pool.properties?.coolAccess ?? false,
  encryptionType: pool.properties?.encryptionType ?? undefined,
  totalThroughputMibps: pool.properties?.totalThroughputMibps,
  tags: userTags(pool.tags),
});

export const CapacityPoolProvider = () =>
  Provider.succeed(CapacityPool, {
    stables: [
      "poolName",
      "capacityPoolId",
      "poolId",
      "account",
      "resourceGroup",
      "location",
      "serviceLevel",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const pools = yield* listAllPools(subscriptionId);
      return pools.flatMap((pool) => {
        const { resourceGroup, account, name } = parseNetAppId(pool.id);
        return hasAnyAlchemyTag(pool.tags) &&
          resourceGroup !== undefined &&
          account !== undefined &&
          name !== undefined
          ? [toAttrs(resourceGroup, account, name, pool)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account.toLowerCase() !== output.account.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.poolName.toLowerCase()) ||
        (news.serviceLevel ?? "Standard") !== output.serviceLevel ||
        (news.encryptionType ?? "Single") !==
          (output.encryptionType ?? "Single") ||
        ((news.qosType ?? "Auto") === "Auto" && output.qosType === "Manual") ||
        (news.coolAccess !== true && output.coolAccess)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.poolName ?? olds?.name ?? (yield* createNetAppName(id, 64));
      const observed = yield* getPool(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.NetApp");
      const { resourceGroup, account } = news;
      const name =
        news.name ?? output?.poolName ?? (yield* createNetAppName(id, 64));
      const tags = yield* desiredTags(id, news.tags);
      const desired = {
        size: news.size ?? TiB,
        qosType: news.qosType ?? "Auto",
        coolAccess: news.coolAccess,
        customThroughputMibps: news.customThroughputMibps,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        poolName: name,
      };
      const get = getPool(subscriptionId, resourceGroup, account, name);
      const waitReady = waitForProvisioned(
        `capacity pool ${name}`,
        get,
        (pool) => pool.properties?.provisioningState,
        LRO_BUDGET,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const location =
          output?.location ??
          (yield* accountLocation(subscriptionId, resourceGroup, account));
        yield* whileBusy(
          netapp.PoolsCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: {
              ...desired,
              serviceLevel: news.serviceLevel ?? "Standard",
              encryptionType: news.encryptionType,
            },
          }),
        );
      }
      observed = yield* waitReady;

      // Sync mutable properties and tags against observed state.
      const props = observed.properties;
      const changed: netapp.PoolPatchProperties = {};
      if (props?.size !== desired.size) changed.size = desired.size;
      if (props?.qosType !== desired.qosType) changed.qosType = desired.qosType;
      if (
        desired.coolAccess !== undefined &&
        (props?.coolAccess ?? false) !== desired.coolAccess
      ) {
        changed.coolAccess = desired.coolAccess;
      }
      if (
        desired.customThroughputMibps !== undefined &&
        props?.customThroughputMibps !== desired.customThroughputMibps
      ) {
        changed.customThroughputMibps = desired.customThroughputMibps;
      }
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || tagsChanged) {
        yield* whileBusy(
          netapp.UpdatePool({
            ...where,
            tags: tagsChanged ? tags : undefined,
            properties: Object.keys(changed).length > 0 ? changed : undefined,
          }),
        );
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, account, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* whileBusy(
        ignoreNotFound(
          netapp.DeletePool({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            poolName: output.poolName,
          }),
        ),
      );
      yield* waitUntilGone(
        `capacity pool ${output.poolName}`,
        getPool(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.poolName,
        ),
        LRO_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.NetApp.Account", "Azure.Resources.ResourceGroup"],
    },
  });
