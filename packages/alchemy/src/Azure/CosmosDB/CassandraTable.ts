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

export interface CassandraColumn {
  /** Column name. */
  name: string;
  /** CQL type, e.g. `text`, `int`, `uuid`, `timestamp`, `map<text, int>`. */
  type: string;
}

export interface CassandraClusterKey {
  /** Name of a column in `columns`. */
  name: string;
  /**
   * Clustering order.
   * @default "Asc"
   */
  orderBy?: "Asc" | "Desc";
}

export interface CassandraTableSchema {
  /**
   * Columns of the table. Adding columns is applied in place; removing or
   * retyping a column replaces the table.
   */
  columns: CassandraColumn[];
  /**
   * Names of the partition key columns, in order. Changing them replaces
   * the table.
   */
  partitionKeys: string[];
  /**
   * Clustering columns, in order. Changing them replaces the table.
   * @default []
   */
  clusterKeys?: CassandraClusterKey[];
}

export interface CassandraTableProps extends ThroughputProps {
  /** Resource group of the account. Changing it replaces the table. */
  resourceGroup: string;
  /** Name of the Cosmos DB account. Changing it replaces the table. */
  account: string;
  /** Name of the keyspace, e.g. `keyspace.keyspaceName`. Changing it replaces the table. */
  keyspace: string;
  /**
   * Table name: up to 48 lowercase letters, digits, and underscores,
   * starting with a letter. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the table.
   */
  name?: string;
  /** Table schema. */
  schema: CassandraTableSchema;
  /**
   * Default time to live for rows in seconds; `0` (or omitted) disables
   * expiry. Updated in place.
   */
  defaultTtl?: number;
  /** Analytical store TTL in seconds (`-1` keeps data forever). */
  analyticalStorageTtl?: number;
}

export interface CassandraTable extends Resource<
  "Azure.CosmosDB.CassandraTable",
  CassandraTableProps,
  {
    /** Name of the table. */
    tableName: string;
    /** Name of the keyspace. */
    keyspace: string;
    /** Name of the Cosmos DB account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the table. */
    tableId: string;
    /** System-generated resource ID (`_rid`). */
    rid: string | undefined;
    /** Observed columns. */
    columns: CassandraColumn[];
    /** Observed partition key columns. */
    partitionKeys: string[];
    /** Observed clustering columns. */
    clusterKeys: CassandraClusterKey[];
    /** Default row TTL in seconds, when set. */
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
 * A table in an Azure Cosmos DB for Apache Cassandra keyspace, with a CQL
 * schema of columns, partition keys, and clustering keys.
 *
 * Cosmos DB does not keep tags on tables; Alchemy treats one it created (or
 * one under a generated name) as its own.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/cassandra/introduction
 *
 * ### Creating a Table
 * **Example:** Table keyed by user with time-ordered rows
 * ```typescript
 * const events = yield* Azure.CosmosDB.CassandraTable("events", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   keyspace: keyspace.keyspaceName,
 *   schema: {
 *     columns: [
 *       { name: "user_id", type: "uuid" },
 *       { name: "ts", type: "timestamp" },
 *       { name: "payload", type: "text" },
 *     ],
 *     partitionKeys: ["user_id"],
 *     clusterKeys: [{ name: "ts", orderBy: "Desc" }],
 *   },
 * });
 * ```
 *
 * ### Expiring Rows
 * **Example:** Rows expire after a day
 * ```typescript
 * const sessions = yield* Azure.CosmosDB.CassandraTable("sessions", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   keyspace: keyspace.keyspaceName,
 *   defaultTtl: 86400,
 *   schema: {
 *     columns: [
 *       { name: "id", type: "text" },
 *       { name: "data", type: "text" },
 *     ],
 *     partitionKeys: ["id"],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const CassandraTable = Resource<CassandraTable>(
  "Azure.CosmosDB.CassandraTable",
);

type ObservedTable = cosmos.GetCassandraResourceCassandraTableResponse;

const createTableName = Effect.fn(function* (id: string) {
  const name = (yield* createPhysicalName({
    id,
    maxLength: 48,
    delimiter: "_",
    lowercase: true,
  })).replace(/[^a-z0-9_]/g, "_");
  return /^[a-z]/.test(name) ? name : `t${name}`.slice(0, 48);
});

const getTable = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  keyspaceName: string,
  tableName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetCassandraResourceCassandraTable({
      subscriptionId,
      resourceGroupName,
      accountName,
      keyspaceName,
      tableName,
    }),
  );

const columnKey = (c: { name?: string; type?: string }) =>
  `${c.name?.toLowerCase()}:${c.type?.toLowerCase().replace(/\s+/g, "")}`;

const clusterKeysOf = (keys: readonly CassandraClusterKey[] | undefined) =>
  (keys ?? []).map((k) => ({ name: k.name, orderBy: k.orderBy ?? "Asc" }));

const toWireSchema = (schema: CassandraTableSchema) => ({
  columns: schema.columns.map((c) => ({ name: c.name, type: c.type })),
  partitionKeys: schema.partitionKeys.map((name) => ({ name })),
  clusterKeys: clusterKeysOf(schema.clusterKeys),
});

/** Whether the desired schema can be reached in place from `current`. */
const schemaReplaces = (
  desired: CassandraTableSchema,
  current: {
    columns: readonly CassandraColumn[];
    partitionKeys: readonly string[];
    clusterKeys: readonly CassandraClusterKey[];
  },
) => {
  const wanted = new Set(desired.columns.map(columnKey));
  return (
    current.columns.some((c) => !wanted.has(columnKey(c))) ||
    canonical(desired.partitionKeys.map((k) => k.toLowerCase())) !==
      canonical(current.partitionKeys.map((k) => k.toLowerCase())) ||
    canonical(
      clusterKeysOf(desired.clusterKeys).map((k) => ({
        ...k,
        name: k.name.toLowerCase(),
      })),
    ) !==
      canonical(
        clusterKeysOf(current.clusterKeys).map((k) => ({
          ...k,
          name: k.name.toLowerCase(),
        })),
      )
  );
};

const observedSchema = (table: ObservedTable) => {
  const schema = table.properties?.resource?.schema;
  return {
    columns: (schema?.columns ?? []).map((c) => ({
      name: c.name ?? "",
      type: c.type ?? "",
    })),
    partitionKeys: (schema?.partitionKeys ?? []).map((k) => k.name ?? ""),
    clusterKeys: (schema?.clusterKeys ?? []).map((k) => ({
      name: k.name ?? "",
      orderBy: (k.orderBy === "Desc" ? "Desc" : "Asc") as "Asc" | "Desc",
    })),
  };
};

const mutableDrift = (props: CassandraTableProps, table: ObservedTable) => {
  const resource = table.properties?.resource;
  const have = new Set(observedSchema(table).columns.map(columnKey));
  return (
    (resource?.defaultTtl ?? 0) !== (props.defaultTtl ?? 0) ||
    (props.analyticalStorageTtl !== undefined &&
      resource?.analyticalStorageTtl !== props.analyticalStorageTtl) ||
    props.schema.columns.some((c) => !have.has(columnKey(c)))
  );
};

const toAttrs = (
  resourceGroup: string,
  account: string,
  keyspace: string,
  name: string,
  table: ObservedTable,
  throughput: ThroughputProps,
): CassandraTable["Attributes"] => ({
  tableName: name,
  keyspace,
  account,
  resourceGroup,
  tableId: table.id ?? "",
  rid: table.properties?.resource?._rid,
  ...observedSchema(table),
  defaultTtl: table.properties?.resource?.defaultTtl,
  throughput: throughput.throughput,
  autoscaleMaxThroughput: throughput.autoscaleMaxThroughput,
});

export const CassandraTableProvider = () =>
  Provider.succeed(CassandraTable, {
    stables: [
      "tableName",
      "keyspace",
      "account",
      "resourceGroup",
      "tableId",
      "rid",
      "partitionKeys",
      "clusterKeys",
    ],

    // Tables disappear with their keyspace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account !== output.account ||
        news.keyspace !== output.keyspace ||
        (news.name !== undefined && news.name !== output.tableName) ||
        schemaReplaces(news.schema, output) ||
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
      const keyspace = output?.keyspace ?? olds?.keyspace;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        keyspace === undefined
      ) {
        return undefined;
      }
      const name =
        output?.tableName ?? olds?.name ?? (yield* createTableName(id));
      const observed = yield* getTable(
        subscriptionId,
        resourceGroup,
        account,
        keyspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, keyspace, name, observed, {
        throughput: output?.throughput,
        autoscaleMaxThroughput: output?.autoscaleMaxThroughput,
      });
      return isOwnedChild(output, olds?.name) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const { resourceGroup, account, keyspace } = news;
      const name =
        news.name ?? output?.tableName ?? (yield* createTableName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        keyspaceName: keyspace,
        tableName: name,
      };
      const label = `Cosmos DB Cassandra table ${name}`;
      const get = getTable(
        subscriptionId,
        resourceGroup,
        account,
        keyspace,
        name,
      );
      const converged = (table: ObservedTable) => !mutableDrift(news, table);

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT carries the whole schema; on an existing
      // table the observed keys are kept and only new columns are added.
      if (observed === undefined || !converged(observed)) {
        const schema =
          observed === undefined
            ? toWireSchema(news.schema)
            : (() => {
                const current = observedSchema(observed);
                const have = new Set(current.columns.map(columnKey));
                return toWireSchema({
                  columns: [
                    ...current.columns,
                    ...news.schema.columns.filter(
                      (c) => !have.has(columnKey(c)),
                    ),
                  ],
                  partitionKeys: current.partitionKeys,
                  clusterKeys: current.clusterKeys,
                });
              })();
        yield* cosmos
          .CassandraResourcesCreateUpdateCassandraTable({
            ...where,
            properties: {
              resource: {
                id: name,
                schema,
                defaultTtl: news.defaultTtl,
                analyticalStorageTtl: news.analyticalStorageTtl,
              },
              options: observed === undefined ? createOptions(news) : undefined,
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
        observed = yield* waitForChild(label, get, converged);
      }

      // Sync dedicated throughput against observed throughput settings.
      const throughput = yield* syncThroughput(label, news, {
        get: cosmos.GetCassandraResourceCassandraTableThroughput(where),
        update: (resource) =>
          cosmos.UpdateCassandraResourceCassandraTableThroughput({
            ...where,
            properties: { resource },
          }),
        toAutoscale:
          cosmos.MigrateCassandraResourceCassandraTableToAutoscale(where),
        toManual:
          cosmos.MigrateCassandraResourceCassandraTableToManualThroughput(
            where,
          ),
      });

      return toAttrs(
        resourceGroup,
        account,
        keyspace,
        name,
        observed,
        throughput,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cosmos
          .DeleteCassandraResourceCassandraTable({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            keyspaceName: output.keyspace,
            tableName: output.tableName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB Cassandra table ${output.tableName}`,
        getTable(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.keyspace,
          output.tableName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.CosmosDB.CassandraKeyspace",
        "Azure.CosmosDB.DatabaseAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
