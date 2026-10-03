import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  canonical,
  createOptions,
  hasDedicatedThroughput,
  isOwnedChild,
  syncThroughput,
  type ThroughputProps,
  waitForChild,
  whileAccountBusy,
} from "./Shared.ts";

export type IndexingPolicy = cosmos.IndexingPolicy;
export type ConflictResolutionPolicy = cosmos.ConflictResolutionPolicy;
export type VectorEmbeddingPolicy = cosmos.VectorEmbeddingPolicy;
export type FullTextPolicy = cosmos.FullTextPolicy;

export interface SqlContainerPartitionKey {
  /**
   * Partition key paths, e.g. `["/tenantId"]`. Up to three paths with
   * `kind: "MultiHash"` (hierarchical partition keys).
   */
  paths: string[];
  /**
   * Partitioning algorithm.
   * @default "Hash" for one path, "MultiHash" for several
   */
  kind?: "Hash" | "MultiHash";
  /**
   * Partition key definition version; `2` supports keys longer than 100 bytes.
   * @default 2
   */
  version?: 1 | 2;
}

export interface SqlContainerUniqueKey {
  /** Paths whose combined value must be unique within a logical partition. */
  paths: string[];
}

export interface SqlContainerComputedProperty {
  /** Name of the computed property, e.g. `cp_lowerName`. */
  name: string;
  /** Query that computes the value, e.g. `SELECT VALUE LOWER(c.name) FROM c`. */
  query: string;
}

export interface SqlContainerProps extends ThroughputProps {
  /** Resource group of the account. Changing it replaces the container. */
  resourceGroup: string;
  /** Name of the Cosmos DB account. Changing it replaces the container. */
  account: string;
  /** Name of the SQL database, e.g. `database.databaseName`. Changing it replaces the container. */
  database: string;
  /**
   * Container name (up to 255 characters, no `/`, `\`, `#`, or `?`). If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the container.
   */
  name?: string;
  /**
   * Partition key. Changing it replaces the container (and deletes its data).
   * @default { paths: ["/id"] }
   */
  partitionKey?: SqlContainerPartitionKey;
  /**
   * Indexing policy. Updates are applied in place; Cosmos rebuilds the
   * index in the background.
   * @default Azure's default (consistent indexing of every path)
   */
  indexingPolicy?: IndexingPolicy;
  /**
   * Default time to live for items in seconds; `-1` enables TTL without a
   * default expiry. Omit to disable TTL.
   */
  defaultTtl?: number;
  /** Analytical store TTL in seconds (`-1` keeps data forever). */
  analyticalStorageTtl?: number;
  /** Unique key constraints. Changing them replaces the container. */
  uniqueKeys?: SqlContainerUniqueKey[];
  /** Conflict resolution for multi-region writes. Changing it replaces the container. */
  conflictResolutionPolicy?: ConflictResolutionPolicy;
  /** Computed properties. */
  computedProperties?: SqlContainerComputedProperty[];
  /** Vector embedding policy for vector search. Changing it replaces the container. */
  vectorEmbeddingPolicy?: VectorEmbeddingPolicy;
  /** Full-text search policy. */
  fullTextPolicy?: FullTextPolicy;
}

export interface SqlContainer extends Resource<
  "Azure.CosmosDB.SqlContainer",
  SqlContainerProps,
  {
    /** Name of the container. */
    containerName: string;
    /** Name of the SQL database. */
    database: string;
    /** Name of the Cosmos DB account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the container. */
    containerId: string;
    /** System-generated resource ID (`_rid`). */
    rid: string | undefined;
    /** Partition key paths. */
    partitionKeyPaths: string[];
    /** Partitioning algorithm. */
    partitionKeyKind: string;
    /** Default item TTL in seconds, when enabled. */
    defaultTtl: number | undefined;
    /** Dedicated manual throughput in RU/s, when provisioned. */
    throughput: number | undefined;
    /** Dedicated autoscale maximum throughput in RU/s, when provisioned. */
    autoscaleMaxThroughput: number | undefined;
  },
  never,
  Providers
> {}

/**
 * A container in an Azure Cosmos DB for NoSQL database — the unit that holds
 * JSON items, is partitioned by a partition key, and is indexed by an
 * indexing policy.
 *
 * Cosmos DB does not keep tags on containers; Alchemy treats one it created
 * (or one under a generated name) as its own.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/nosql/
 *
 * ### Creating a Container
 * **Example:** Container partitioned by tenant
 * ```typescript
 * const orders = yield* Azure.CosmosDB.SqlContainer("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   database: database.databaseName,
 *   partitionKey: { paths: ["/tenantId"] },
 * });
 * ```
 *
 * **Example:** Hierarchical partition key
 * ```typescript
 * const events = yield* Azure.CosmosDB.SqlContainer("events", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   database: database.databaseName,
 *   partitionKey: { paths: ["/tenantId", "/userId"], kind: "MultiHash" },
 * });
 * ```
 *
 * ### Expiry and Indexing
 * **Example:** Expire items after a day and index only one path
 * ```typescript
 * const sessions = yield* Azure.CosmosDB.SqlContainer("sessions", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   database: database.databaseName,
 *   partitionKey: { paths: ["/userId"] },
 *   defaultTtl: 86400,
 *   indexingPolicy: {
 *     indexingMode: "consistent",
 *     includedPaths: [{ path: "/userId/?" }],
 *     excludedPaths: [{ path: "/*" }],
 *   },
 * });
 * ```
 *
 * ### Dedicated Throughput
 * **Example:** Autoscale container on a provisioned account
 * ```typescript
 * const hot = yield* Azure.CosmosDB.SqlContainer("hot", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   database: database.databaseName,
 *   partitionKey: { paths: ["/id"] },
 *   autoscaleMaxThroughput: 4000,
 * });
 * ```
 *
 * @resource
 */
export const SqlContainer = Resource<SqlContainer>(
  "Azure.CosmosDB.SqlContainer",
);

type ObservedContainer = cosmos.GetSqlResourceSqlContainerResponse;

const createContainerName = (id: string) =>
  createPhysicalName({ id, maxLength: 255 });

const getContainer = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  databaseName: string,
  containerName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetSqlResourceSqlContainer({
      subscriptionId,
      resourceGroupName,
      accountName,
      databaseName,
      containerName,
    }),
  );

const desiredPartitionKey = (
  props: SqlContainerProps,
): Required<SqlContainerPartitionKey> => {
  const paths = props.partitionKey?.paths ?? ["/id"];
  return {
    paths,
    kind: props.partitionKey?.kind ?? (paths.length > 1 ? "MultiHash" : "Hash"),
    version: props.partitionKey?.version ?? 2,
  };
};

/** Cosmos always excludes the system `_etag` path; ignore it when comparing. */
const ETAG_PATH = '/"_etag"/?';

/** Whether the observed indexing policy matches every key the user set. */
const indexingMatches = (
  desired: IndexingPolicy | undefined,
  observed: IndexingPolicy | undefined,
) => {
  if (desired === undefined) return true;
  return (Object.keys(desired) as (keyof IndexingPolicy)[]).every((key) => {
    let value: unknown = observed?.[key];
    if (key === "excludedPaths" && Array.isArray(value)) {
      value = (value as { path?: string }[]).filter((p) => p.path !== ETAG_PATH);
    }
    const want =
      key === "excludedPaths"
        ? (desired.excludedPaths ?? []).filter((p) => p.path !== ETAG_PATH)
        : desired[key];
    return canonical(want ?? []) === canonical(value ?? []);
  });
};

/** True when the observed container differs from the mutable desired state. */
const mutableDrift = (
  props: SqlContainerProps,
  observed: ObservedContainer,
) => {
  const resource = observed.properties?.resource;
  return (
    resource?.defaultTtl !== props.defaultTtl ||
    (props.analyticalStorageTtl !== undefined &&
      resource?.analyticalStorageTtl !== props.analyticalStorageTtl) ||
    !indexingMatches(props.indexingPolicy, resource?.indexingPolicy) ||
    canonical(props.computedProperties ?? []) !==
      canonical(resource?.computedProperties ?? []) ||
    (props.fullTextPolicy !== undefined &&
      canonical(props.fullTextPolicy) !== canonical(resource?.fullTextPolicy))
  );
};

const toAttrs = (
  resourceGroup: string,
  account: string,
  database: string,
  name: string,
  container: ObservedContainer,
  throughput: ThroughputProps,
): SqlContainer["Attributes"] => {
  const resource = container.properties?.resource;
  return {
    containerName: name,
    database,
    account,
    resourceGroup,
    containerId: container.id ?? "",
    rid: resource?._rid,
    partitionKeyPaths: [...(resource?.partitionKey?.paths ?? [])],
    partitionKeyKind: resource?.partitionKey?.kind ?? "Hash",
    defaultTtl: resource?.defaultTtl,
    throughput: throughput.throughput,
    autoscaleMaxThroughput: throughput.autoscaleMaxThroughput,
  };
};

export const SqlContainerProvider = () =>
  Provider.succeed(SqlContainer, {
    stables: [
      "containerName",
      "database",
      "account",
      "resourceGroup",
      "containerId",
      "rid",
      "partitionKeyPaths",
      "partitionKeyKind",
    ],

    // Containers disappear with their database.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const partitionKey = desiredPartitionKey(news);
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account !== output.account ||
        news.database !== output.database ||
        (news.name !== undefined && news.name !== output.containerName) ||
        partitionKey.paths.join(",") !== output.partitionKeyPaths.join(",") ||
        partitionKey.kind !== output.partitionKeyKind ||
        canonical(news.uniqueKeys ?? []) !==
          canonical(olds?.uniqueKeys ?? []) ||
        canonical(news.conflictResolutionPolicy) !==
          canonical(olds?.conflictResolutionPolicy) ||
        canonical(news.vectorEmbeddingPolicy) !==
          canonical(olds?.vectorEmbeddingPolicy) ||
        hasDedicatedThroughput(news) !== hasDedicatedThroughput(output)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      const database = output?.database ?? olds?.database;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        database === undefined
      ) {
        return undefined;
      }
      const name =
        output?.containerName ??
        olds?.name ??
        (yield* createContainerName(id));
      const observed = yield* getContainer(
        subscriptionId,
        resourceGroup,
        account,
        database,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, database, name, observed, {
        throughput: output?.throughput,
        autoscaleMaxThroughput: output?.autoscaleMaxThroughput,
      });
      return isOwnedChild(output, olds?.name) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const { resourceGroup, account, database } = news;
      const name =
        news.name ?? output?.containerName ?? (yield* createContainerName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        databaseName: database,
        containerName: name,
      };
      const label = `Cosmos DB container ${name}`;
      const get = getContainer(
        subscriptionId,
        resourceGroup,
        account,
        database,
        name,
      );
      const converged = (container: ObservedContainer) =>
        !mutableDrift(news, container);

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT replaces the whole container definition, so
      // immutable aspects are re-sent as observed; throughput in `options`
      // only applies at creation.
      if (observed === undefined || !converged(observed)) {
        const current = observed?.properties?.resource;
        const partitionKey = current?.partitionKey
          ? {
              paths: current.partitionKey.paths,
              kind: current.partitionKey.kind,
              version: current.partitionKey.version,
            }
          : desiredPartitionKey(news);
        yield* cosmos
          .SqlResourcesCreateUpdateSqlContainer({
            ...where,
            properties: {
              resource: {
                id: name,
                partitionKey,
                indexingPolicy: news.indexingPolicy,
                defaultTtl: news.defaultTtl,
                analyticalStorageTtl: news.analyticalStorageTtl,
                uniqueKeyPolicy: current
                  ? current.uniqueKeyPolicy
                  : news.uniqueKeys
                    ? { uniqueKeys: news.uniqueKeys }
                    : undefined,
                conflictResolutionPolicy: current
                  ? current.conflictResolutionPolicy
                  : news.conflictResolutionPolicy,
                vectorEmbeddingPolicy: current
                  ? current.vectorEmbeddingPolicy
                  : news.vectorEmbeddingPolicy,
                computedProperties: news.computedProperties,
                fullTextPolicy: news.fullTextPolicy,
              },
              options: observed === undefined ? createOptions(news) : undefined,
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
        observed = yield* waitForChild(label, get, converged);
      }

      // Sync dedicated throughput against observed throughput settings.
      const throughput = yield* syncThroughput(label, news, {
        get: cosmos.GetSqlResourceSqlContainerThroughput(where),
        update: (resource) =>
          cosmos.UpdateSqlResourceSqlContainerThroughput({
            ...where,
            properties: { resource },
          }),
        toAutoscale: cosmos.MigrateSqlResourceSqlContainerToAutoscale(where),
        toManual: cosmos.MigrateSqlResourceSqlContainerToManualThroughput(where),
      });

      return toAttrs(
        resourceGroup,
        account,
        database,
        name,
        observed,
        throughput,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        accountName: output.account,
        databaseName: output.database,
        containerName: output.containerName,
      };
      yield* ignoreNotFound(
        cosmos
          .DeleteSqlResourceSqlContainer(where)
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB container ${output.containerName}`,
        getContainer(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.database,
          output.containerName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.CosmosDB.SqlDatabase",
        "Azure.CosmosDB.DatabaseAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
