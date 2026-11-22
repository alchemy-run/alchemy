import * as synapse from "@distilled.cloud/azure/synapse";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createAlnumName, fieldsMatch, lower, workspaceLocation } from "./common.ts";

export type SparkNodeSize = "Small" | "Medium" | "Large" | "XLarge" | "XXLarge" | "XXXLarge";

export type SparkNodeSizeFamily =
  | "MemoryOptimized"
  | "HardwareAcceleratedFPGA"
  | "HardwareAcceleratedGPU";

/** A requirements file installed into every Spark session. */
export interface SparkRequirementsFile {
  /** File content, e.g. a `requirements.txt` or conda `environment.yml`. */
  content: string;
  /** File name, e.g. `requirements.txt`. */
  filename: string;
}

/** A Spark configuration file applied to every session. */
export interface SparkConfigFile {
  /** File content (`key value` lines). */
  content: string;
  /** File name, e.g. `spark.conf`. */
  filename: string;
  /**
   * Whether the content is a file or an artifact reference.
   * @default not set
   */
  configurationType?: "File" | "Artifact";
}

export interface BigDataPoolProps {
  /**
   * Resource group of the workspace. Changing it replaces the pool.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Name of the Synapse workspace. Changing it replaces the pool. */
  workspace: string;
  /**
   * Pool name: 1-15 letters and digits, starting with a letter. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the pool.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Location of the pool; must equal the workspace location. Changing it
   * replaces the pool.
   * @default the workspace's location
   */
  location?: string;
  /**
   * Node family. Changing it replaces the pool.
   * @default "MemoryOptimized"
   */
  nodeSizeFamily?: SparkNodeSizeFamily;
  /**
   * Node size (Small = 4 vCores / 32 GB).
   * @default "Small"
   */
  nodeSize?: SparkNodeSize;
  /**
   * Fixed node count (when autoscale is disabled).
   * @default 3
   */
  nodeCount?: number;
  /**
   * Autoscale between a minimum and maximum number of nodes.
   * @default not set
   */
  autoScale?: {
    /** Whether autoscale is enabled. */
    enabled: boolean;
    /**
     * Minimum number of nodes (≥ 3).
     * @default not set
     */
    minNodeCount?: number;
    /**
     * Maximum number of nodes.
     * @default not set
     */
    maxNodeCount?: number;
  };
  /**
   * Pause the cluster after a period of inactivity.
   * @default not set
   */
  autoPause?: {
    /** Whether auto-pause is enabled. */
    enabled: boolean;
    /**
     * Idle minutes before pausing.
     * @default not set
     */
    delayInMinutes?: number;
  };
  /**
   * Dynamically allocate executors within a session.
   * @default not set
   */
  dynamicExecutorAllocation?: {
    /** Whether dynamic executor allocation is enabled. */
    enabled: boolean;
    /**
     * Minimum number of executors.
     * @default not set
     */
    minExecutors?: number;
    /**
     * Maximum number of executors.
     * @default not set
     */
    maxExecutors?: number;
  };
  /**
   * Apache Spark version.
   * @default "3.4"
   */
  sparkVersion?: string;
  /**
   * Run on isolated compute (only some node sizes and regions).
   * @default not set
   */
  isComputeIsolationEnabled?: boolean;
  /**
   * Enable Spark autotune.
   * @default not set
   */
  isAutotuneEnabled?: boolean;
  /**
   * Allow session-level packages.
   * @default not set
   */
  sessionLevelPackagesEnabled?: boolean;
  /**
   * Cache size in percent.
   * @default not set
   */
  cacheSize?: number;
  /**
   * Library requirements installed into every session.
   * @default not set
   */
  libraryRequirements?: SparkRequirementsFile;
  /**
   * Spark configuration applied to every session.
   * @default not set
   */
  sparkConfigProperties?: SparkConfigFile;
  /**
   * Default folder for Spark logs.
   * @default not set
   */
  defaultSparkLogFolder?: string;
  /**
   * Folder for Spark events.
   * @default not set
   */
  sparkEventsFolder?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface BigDataPool extends Resource<
  "Azure.Synapse.BigDataPool",
  BigDataPoolProps,
  {
    /** Name of the pool. */
    bigDataPoolName: string;
    /** ARM resource ID of the pool. */
    bigDataPoolId: string;
    /** Name of the workspace. */
    workspaceName: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Location of the pool. */
    location: string;
    /** Node family. */
    nodeSizeFamily: string | undefined;
    /** Node size. */
    nodeSize: string | undefined;
    /** Apache Spark version. */
    sparkVersion: string | undefined;
    /** Creation time. */
    creationDate: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Apache Spark pool in a Synapse workspace
 * (`Microsoft.Synapse/workspaces/bigDataPools`). The pool is only a
 * definition: compute is allocated (and billed) only while a Spark session
 * runs, and auto-pause releases it after idle time.
 *
 * :::caution
 * Changing `workspace`, `name`, `location`, `nodeSizeFamily`, or
 * `resourceGroup` replaces the pool.
 * :::
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-pool-configurations
 *
 * ### Creating a Spark Pool
 * **Example:** Small autoscaling pool with auto-pause
 * ```typescript
 * const lake = yield* Azure.Storage.StorageAccount("lake", {
 *   isHnsEnabled: true,
 * });
 * const fs = yield* Azure.Storage.BlobContainer("fs", {
 *   storageAccount: lake.storageAccountName,
 * });
 * const workspace = yield* Azure.Synapse.Workspace("ws", {
 *   defaultDataLakeStorage: {
 *     accountUrl: lake.primaryEndpoints.dfs.as<string>(),
 *     filesystem: fs.containerName,
 *   },
 * });
 * const spark = yield* Azure.Synapse.BigDataPool("spark", {
 *   workspace: workspace.workspaceName,
 *   nodeSize: "Small",
 *   autoScale: { enabled: true, minNodeCount: 3, maxNodeCount: 10 },
 *   autoPause: { enabled: true, delayInMinutes: 15 },
 * });
 * ```
 *
 * ### Libraries
 * **Example:** Install Python packages into every session
 * ```typescript
 * yield* Azure.Synapse.BigDataPool("spark", {
 *   workspace: workspace.workspaceName,
 *   libraryRequirements: {
 *     filename: "requirements.txt",
 *     content: "great-expectations==0.18.0\n",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const BigDataPool = GroupedResource<BigDataPool>("Azure.Synapse.BigDataPool");

type ObservedPool = synapse.GetBigDataPoolResponse;

const createPoolName = (id: string) => createAlnumName(id, 15);

const getPool = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  bigDataPoolName: string,
) =>
  orUndefinedIfNotFound(
    synapse.GetBigDataPool({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      bigDataPoolName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspaceName: string,
  name: string,
  pool: ObservedPool,
): BigDataPool["Attributes"] => ({
  bigDataPoolName: name,
  bigDataPoolId: pool.id ?? "",
  workspaceName,
  resourceGroup,
  location: pool.location,
  nodeSizeFamily: pool.properties?.nodeSizeFamily,
  nodeSize: pool.properties?.nodeSize,
  sparkVersion: pool.properties?.sparkVersion,
  creationDate: pool.properties?.creationDate,
  tags: userTags(pool.tags),
});

const desiredProperties = (news: BigDataPoolProps) => ({
  nodeSizeFamily: news.nodeSizeFamily ?? "MemoryOptimized",
  nodeSize: news.nodeSize ?? "Small",
  nodeCount: news.autoScale?.enabled ? undefined : (news.nodeCount ?? 3),
  autoScale: news.autoScale,
  autoPause: news.autoPause,
  dynamicExecutorAllocation: news.dynamicExecutorAllocation,
  sparkVersion: news.sparkVersion ?? "3.4",
  isComputeIsolationEnabled: news.isComputeIsolationEnabled,
  isAutotuneEnabled: news.isAutotuneEnabled,
  sessionLevelPackagesEnabled: news.sessionLevelPackagesEnabled,
  cacheSize: news.cacheSize,
  libraryRequirements: news.libraryRequirements,
  sparkConfigProperties: news.sparkConfigProperties,
  defaultSparkLogFolder: news.defaultSparkLogFolder,
  sparkEventsFolder: news.sparkEventsFolder,
});

export const BigDataPoolProvider = () =>
  Provider.succeed(BigDataPool, {
    stables: ["bigDataPoolName", "bigDataPoolId", "workspaceName", "resourceGroup", "location"],

    // Pools live inside a workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.workspace) !== lower(output.workspaceName) ||
        (news.name !== undefined && news.name !== output.bigDataPoolName) ||
        (news.location !== undefined && lower(news.location) !== lower(output.location)) ||
        (output.nodeSizeFamily !== undefined &&
          lower(news.nodeSizeFamily ?? "MemoryOptimized") !== lower(output.nodeSizeFamily))
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
      const name = output?.bigDataPoolName ?? olds?.name ?? (yield* createPoolName(id));
      const observed = yield* getPool(subscriptionId, resourceGroup, workspace, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Synapse");
      const { resourceGroup, workspace } = news;
      const name = news.name ?? output?.bigDataPoolName ?? (yield* createPoolName(id));
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
      const properties = desiredProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: workspace,
        bigDataPoolName: name,
      };
      const get = getPool(subscriptionId, resourceGroup, workspace, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync the pool definition with one long-running PUT when it
      // is missing or any desired property drifted.
      const propsDrift = observed === undefined || !fieldsMatch(observed.properties, properties);
      if (propsDrift) {
        yield* synapse.BigDataPoolsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties,
        });
      } else if (tagsDiffer(observed.tags, tags)) {
        // Tags-only change: PATCH.
        yield* synapse.UpdateBigDataPool({ ...where, tags });
      }

      const fresh = yield* waitForProvisioned(
        `synapse spark pool ${name}`,
        get,
        (pool) =>
          !tagsDiffer(pool.tags, tags) && fieldsMatch(pool.properties, properties)
            ? pool.properties?.provisioningState
            : "Updating",
        { interval: "5 seconds", times: 72 },
      );
      return toAttrs(resourceGroup, workspace, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        synapse.DeleteBigDataPool({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspaceName,
          bigDataPoolName: output.bigDataPoolName,
        }),
      );
      yield* waitUntilGone(
        `synapse spark pool ${output.bigDataPoolName}`,
        getPool(subscriptionId, output.resourceGroup, output.workspaceName, output.bigDataPoolName),
        { interval: "5 seconds", times: 72 },
      );
    }),
  });
