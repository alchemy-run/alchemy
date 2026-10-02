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
import type {
  ConflictResolutionPolicy,
  IndexingPolicy,
  SqlContainerPartitionKey,
  SqlContainerUniqueKey,
} from "./SqlContainer.ts";

export interface GremlinGraphProps extends ThroughputProps {
  /** Resource group of the account. Changing it replaces the graph. */
  resourceGroup: string;
  /** Name of the Cosmos DB account. Changing it replaces the graph. */
  account: string;
  /** Name of the Gremlin database, e.g. `database.databaseName`. Changing it replaces the graph. */
  database: string;
  /**
   * Graph name (up to 255 characters, no `/`, `\`, `#`, or `?`). If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the graph.
   */
  name?: string;
  /**
   * Partition key of vertices. Changing it replaces the graph (and deletes
   * its data).
   * @default { paths: ["/pk"] }
   */
  partitionKey?: SqlContainerPartitionKey;
  /**
   * Indexing policy. Updates are applied in place; Cosmos rebuilds the
   * index in the background.
   * @default Azure's default (consistent indexing of every path)
   */
  indexingPolicy?: IndexingPolicy;
  /**
   * Default time to live for vertices and edges in seconds; `-1` enables
   * TTL without a default expiry. Omit to disable TTL.
   */
  defaultTtl?: number;
  /** Analytical store TTL in seconds (`-1` keeps data forever). */
  analyticalStorageTtl?: number;
  /** Unique key constraints. Changing them replaces the graph. */
  uniqueKeys?: SqlContainerUniqueKey[];
  /** Conflict resolution for multi-region writes. Changing it replaces the graph. */
  conflictResolutionPolicy?: ConflictResolutionPolicy;
}

export interface GremlinGraph extends Resource<
  "Azure.CosmosDB.GremlinGraph",
  GremlinGraphProps,
  {
    /** Name of the graph. */
    graphName: string;
    /** Name of the Gremlin database. */
    database: string;
    /** Name of the Cosmos DB account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the graph. */
    graphId: string;
    /** System-generated resource ID (`_rid`). */
    rid: string | undefined;
    /** Partition key paths. */
    partitionKeyPaths: string[];
    /** Partitioning algorithm. */
    partitionKeyKind: string;
    /** Default TTL in seconds, when enabled. */
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
 * A graph in an Azure Cosmos DB for Apache Gremlin database. Vertices and
 * edges are stored in the graph and partitioned by its partition key.
 *
 * Cosmos DB does not keep tags on graphs; Alchemy treats one it created (or
 * one under a generated name) as its own.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/gremlin/introduction
 *
 * ### Creating a Graph
 * **Example:** Graph partitioned by tenant
 * ```typescript
 * const graph = yield* Azure.CosmosDB.GremlinGraph("social", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   database: database.databaseName,
 *   partitionKey: { paths: ["/tenantId"] },
 * });
 * ```
 *
 * **Example:** Graph with dedicated throughput and TTL
 * ```typescript
 * const graph = yield* Azure.CosmosDB.GremlinGraph("sessions", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   database: database.databaseName,
 *   partitionKey: { paths: ["/userId"] },
 *   defaultTtl: 3600,
 *   autoscaleMaxThroughput: 1000,
 * });
 * ```
 *
 * @resource
 */
export const GremlinGraph = Resource<GremlinGraph>(
  "Azure.CosmosDB.GremlinGraph",
);

type ObservedGraph = cosmos.GetGremlinResourceGremlinGraphResponse;

const createGraphName = (id: string) =>
  createPhysicalName({ id, maxLength: 255 });

const getGraph = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  databaseName: string,
  graphName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetGremlinResourceGremlinGraph({
      subscriptionId,
      resourceGroupName,
      accountName,
      databaseName,
      graphName,
    }),
  );

const desiredPartitionKey = (
  props: GremlinGraphProps,
): Required<SqlContainerPartitionKey> => {
  const paths = props.partitionKey?.paths ?? ["/pk"];
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
      value = (value as { path?: string }[]).filter(
        (p) => p.path !== ETAG_PATH,
      );
    }
    const want =
      key === "excludedPaths"
        ? (desired.excludedPaths ?? []).filter((p) => p.path !== ETAG_PATH)
        : desired[key];
    return canonical(want ?? []) === canonical(value ?? []);
  });
};

const mutableDrift = (props: GremlinGraphProps, observed: ObservedGraph) => {
  const resource = observed.properties?.resource;
  return (
    resource?.defaultTtl !== props.defaultTtl ||
    (props.analyticalStorageTtl !== undefined &&
      resource?.analyticalStorageTtl !== props.analyticalStorageTtl) ||
    !indexingMatches(props.indexingPolicy, resource?.indexingPolicy)
  );
};

const toAttrs = (
  resourceGroup: string,
  account: string,
  database: string,
  name: string,
  graph: ObservedGraph,
  throughput: ThroughputProps,
): GremlinGraph["Attributes"] => {
  const resource = graph.properties?.resource;
  return {
    graphName: name,
    database,
    account,
    resourceGroup,
    graphId: graph.id ?? "",
    rid: resource?._rid,
    partitionKeyPaths: [...(resource?.partitionKey?.paths ?? [])],
    partitionKeyKind: resource?.partitionKey?.kind ?? "Hash",
    defaultTtl: resource?.defaultTtl,
    throughput: throughput.throughput,
    autoscaleMaxThroughput: throughput.autoscaleMaxThroughput,
  };
};

export const GremlinGraphProvider = () =>
  Provider.succeed(GremlinGraph, {
    stables: [
      "graphName",
      "database",
      "account",
      "resourceGroup",
      "graphId",
      "rid",
      "partitionKeyPaths",
      "partitionKeyKind",
    ],

    // Graphs disappear with their database.
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
        (news.name !== undefined && news.name !== output.graphName) ||
        partitionKey.paths.join(",") !== output.partitionKeyPaths.join(",") ||
        partitionKey.kind !== output.partitionKeyKind ||
        canonical(news.uniqueKeys ?? []) !==
          canonical(olds?.uniqueKeys ?? []) ||
        canonical(news.conflictResolutionPolicy) !==
          canonical(olds?.conflictResolutionPolicy) ||
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
        output?.graphName ?? olds?.name ?? (yield* createGraphName(id));
      const observed = yield* getGraph(
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
        news.name ?? output?.graphName ?? (yield* createGraphName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        databaseName: database,
        graphName: name,
      };
      const label = `Cosmos DB Gremlin graph ${name}`;
      const get = getGraph(
        subscriptionId,
        resourceGroup,
        account,
        database,
        name,
      );
      const converged = (graph: ObservedGraph) => !mutableDrift(news, graph);

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT replaces the whole graph definition, so
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
          .GremlinResourcesCreateUpdateGremlinGraph({
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
              },
              options: observed === undefined ? createOptions(news) : undefined,
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
        observed = yield* waitForChild(label, get, converged);
      }

      // Sync dedicated throughput against observed throughput settings.
      const throughput = yield* syncThroughput(label, news, {
        get: cosmos.GetGremlinResourceGremlinGraphThroughput(where),
        update: (resource) =>
          cosmos.UpdateGremlinResourceGremlinGraphThroughput({
            ...where,
            properties: { resource },
          }),
        toAutoscale:
          cosmos.MigrateGremlinResourceGremlinGraphToAutoscale(where),
        toManual:
          cosmos.MigrateGremlinResourceGremlinGraphToManualThroughput(where),
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
      yield* ignoreNotFound(
        cosmos
          .DeleteGremlinResourceGremlinGraph({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            databaseName: output.database,
            graphName: output.graphName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB Gremlin graph ${output.graphName}`,
        getGraph(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.database,
          output.graphName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.CosmosDB.GremlinDatabase",
        "Azure.CosmosDB.DatabaseAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
