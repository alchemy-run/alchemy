import * as synapse from "@distilled.cloud/azure/synapse";
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
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createAlnumName,
  getSqlPool,
  lower,
  workspaceLocation,
} from "./common.ts";

export interface SqlPoolProps {
  /** Resource group of the workspace. Changing it replaces the pool. */
  resourceGroup: string;
  /** Name of the Synapse workspace. Changing it replaces the pool. */
  workspace: string;
  /**
   * Pool name: up to 60 letters, digits, and underscores. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the pool.
   */
  name?: string;
  /**
   * Location of the pool; must equal the workspace location. Changing it
   * replaces the pool.
   * @default the workspace's location
   */
  location?: string;
  /**
   * Performance level (Data Warehouse Units), e.g. `DW100c` … `DW30000c`.
   * Scaling happens in place (the pool is resumed first if paused).
   * @default "DW100c"
   */
  sku?: string;
  /** Maximum size in bytes. */
  maxSizeBytes?: number;
  /**
   * Database collation. Changing it replaces the pool.
   * @default "SQL_Latin1_General_CP1_CI_AS"
   */
  collation?: string;
  /**
   * Backup storage redundancy. Changing it replaces the pool.
   * @default "GRS"
   */
  storageAccountType?: "GRS" | "LRS";
  /**
   * How the pool is created. Changing it replaces the pool.
   * @default "Default"
   */
  createMode?: "Default" | "PointInTimeRestore" | "Recovery" | "Restore";
  /** Source pool ID for `PointInTimeRestore`/`Restore`. */
  sourceDatabaseId?: string;
  /** Recoverable (geo-backup) pool ID for `Recovery`. */
  recoverableDatabaseId?: string;
  /** Restore point (ISO 8601) for `PointInTimeRestore`. */
  restorePointInTime?: string;
  /** Deletion time of a dropped source pool for `Restore`. */
  sourceDatabaseDeletionDate?: string;
  /**
   * Pause the pool to stop compute billing (storage is still billed).
   * @default false
   */
  paused?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SqlPool extends Resource<
  "Azure.Synapse.SqlPool",
  SqlPoolProps,
  {
    /** Name of the pool. */
    sqlPoolName: string;
    /** ARM resource ID of the pool. */
    sqlPoolId: string;
    /** Name of the workspace. */
    workspaceName: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Location of the pool. */
    location: string;
    /** Performance level, e.g. `DW100c`. */
    sku: string | undefined;
    /** Pool status, e.g. `Online`, `Paused`. */
    status: string | undefined;
    /** Database collation. */
    collation: string | undefined;
    /** Creation time. */
    creationDate: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A dedicated SQL pool (formerly SQL Data Warehouse) in a Synapse
 * workspace. Compute is billed per hour by performance level (DW100c is the
 * smallest) while the pool is online; pause it to stop compute charges.
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-overview-what-is
 *
 * ### Creating a Dedicated SQL Pool
 * **Example:** Smallest pool
 * ```typescript
 * const dw = yield* Azure.Synapse.SqlPool("dw", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   sku: "DW100c",
 * });
 * ```
 *
 * ### Controlling Cost
 * **Example:** Paused pool with locally redundant backups
 * ```typescript
 * const dw = yield* Azure.Synapse.SqlPool("dw", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   storageAccountType: "LRS",
 *   paused: true,
 * });
 * ```
 *
 * @resource
 */
export const SqlPool = Resource<SqlPool>("Azure.Synapse.SqlPool");

type ObservedPool = synapse.GetSqlPoolResponse;

const createPoolName = (id: string) => createAlnumName(id, 60);

const toAttrs = (
  resourceGroup: string,
  workspaceName: string,
  name: string,
  pool: ObservedPool,
): SqlPool["Attributes"] => ({
  sqlPoolName: name,
  sqlPoolId: pool.id ?? "",
  workspaceName,
  resourceGroup,
  location: pool.location,
  sku: pool.sku?.name,
  status: pool.properties?.status,
  collation: pool.properties?.collation,
  creationDate: pool.properties?.creationDate,
  tags: userTags(pool.tags),
});

/** Treat a pool as ready once provisioned and in a settled status. */
const settledState = (pool: ObservedPool, status?: "Online" | "Paused") => {
  const state = pool.properties?.provisioningState;
  if (state !== undefined && state !== "Succeeded") return state;
  const observed = pool.properties?.status;
  if (status !== undefined)
    return observed === status ? "Succeeded" : "Updating";
  return observed === "Online" || observed === "Paused"
    ? "Succeeded"
    : "Updating";
};

export const SqlPoolProvider = () =>
  Provider.succeed(SqlPool, {
    stables: [
      "sqlPoolName",
      "sqlPoolId",
      "workspaceName",
      "resourceGroup",
      "location",
      "collation",
    ],

    // Pools live inside a workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.workspace) !== lower(output.workspaceName) ||
        (news.name !== undefined && news.name !== output.sqlPoolName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        (news.collation !== undefined &&
          output.collation !== undefined &&
          lower(news.collation) !== lower(output.collation)) ||
        (olds !== undefined &&
          ((news.storageAccountType ?? "GRS") !==
            (olds.storageAccountType ?? "GRS") ||
            (news.createMode ?? "Default") !== (olds.createMode ?? "Default") ||
            news.sourceDatabaseId !== olds.sourceDatabaseId ||
            news.recoverableDatabaseId !== olds.recoverableDatabaseId ||
            news.restorePointInTime !== olds.restorePointInTime))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspaceName ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const name =
        output?.sqlPoolName ?? olds?.name ?? (yield* createPoolName(id));
      const observed = yield* getSqlPool(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Synapse");
      const { resourceGroup, workspace } = news;
      const name =
        news.name ?? output?.sqlPoolName ?? (yield* createPoolName(id));
      const location =
        output?.location ??
        (yield* workspaceLocation(
          subscriptionId,
          resourceGroup,
          workspace,
          news.location,
          env.location,
        ));
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? "DW100c";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: workspace,
        sqlPoolName: name,
      };
      const label = `synapse sql pool ${name}`;
      const get = getSqlPool(subscriptionId, resourceGroup, workspace, name);
      const waitFor = (status?: "Online" | "Paused") =>
        waitForProvisioned(label, get, (pool) => settledState(pool, status), {
          interval: "10 seconds",
          times: 90,
        });

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation (~5-10 minutes).
      if (observed === undefined) {
        yield* synapse.CreateSqlPool({
          ...where,
          location,
          tags,
          sku: { name: sku },
          properties: {
            maxSizeBytes: news.maxSizeBytes,
            collation: news.collation,
            storageAccountType: news.storageAccountType,
            createMode: news.createMode,
            sourceDatabaseId: news.sourceDatabaseId,
            recoverableDatabaseId: news.recoverableDatabaseId,
            restorePointInTime: news.restorePointInTime,
            sourceDatabaseDeletionDate: news.sourceDatabaseDeletionDate,
          },
        });
      }
      observed = yield* waitFor();

      // Sync sku, size, and tags. A paused pool cannot scale: resume first.
      const skuChanged = lower(observed.sku?.name) !== lower(sku);
      const sizeChanged =
        news.maxSizeBytes !== undefined &&
        observed.properties?.maxSizeBytes !== news.maxSizeBytes;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (
        (skuChanged || sizeChanged || !news.paused) &&
        observed.properties?.status === "Paused"
      ) {
        yield* synapse.ResumeSqlPool(where);
        observed = yield* waitFor("Online");
      }
      if (skuChanged || sizeChanged || tagsChanged) {
        yield* synapse.UpdateSqlPool({
          ...where,
          sku: skuChanged ? { name: sku } : undefined,
          tags: tagsChanged ? tags : undefined,
          properties: sizeChanged
            ? { maxSizeBytes: news.maxSizeBytes }
            : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (pool) =>
            lower(pool.sku?.name) === lower(sku) &&
            !tagsDiffer(pool.tags, tags) &&
            (!sizeChanged ||
              pool.properties?.maxSizeBytes === news.maxSizeBytes)
              ? settledState(pool)
              : "Updating",
          { interval: "10 seconds", times: 90 },
        );
      }

      // Sync the paused state.
      if (news.paused && observed.properties?.status === "Online") {
        yield* synapse.PauseSqlPool(where);
        observed = yield* waitFor("Paused");
      }

      return toAttrs(resourceGroup, workspace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        synapse.DeleteSqlPool({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspaceName,
          sqlPoolName: output.sqlPoolName,
        }),
      );
      yield* waitUntilGone(
        `synapse sql pool ${output.sqlPoolName}`,
        getSqlPool(
          subscriptionId,
          output.resourceGroup,
          output.workspaceName,
          output.sqlPoolName,
        ),
        { interval: "10 seconds", times: 90 },
      );
    }),
  });
