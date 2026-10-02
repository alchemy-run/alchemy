import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Data from "effect/Data";
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

export interface MongoCollectionIndex {
  /** Indexed fields, e.g. `["email"]`; several fields form a compound index. */
  keys: string[];
  /** Reject duplicate values. Only allowed while the collection is empty. */
  unique?: boolean;
  /** TTL index: expire documents this many seconds after `_ts`. Use `keys: ["_ts"]`. */
  expireAfterSeconds?: number;
}

export interface MongoCollectionProps extends ThroughputProps {
  /** Resource group of the account. Changing it replaces the collection. */
  resourceGroup: string;
  /** Name of the Cosmos DB account. Changing it replaces the collection. */
  account: string;
  /** Name of the MongoDB database, e.g. `database.databaseName`. Changing it replaces the collection. */
  database: string;
  /**
   * Collection name (no `$` or spaces; `database.collection` must fit in
   * 120 bytes). If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the collection.
   */
  name?: string;
  /**
   * Shard key field, e.g. `"tenantId"`. Omit for an unsharded collection.
   * Changing it replaces the collection (and deletes its data).
   */
  shardKey?: string;
  /**
   * Indexes. The mandatory `_id` index is always kept. Updates are applied
   * in place.
   */
  indexes?: MongoCollectionIndex[];
  /** Analytical store TTL in seconds (`-1` keeps data forever). */
  analyticalStorageTtl?: number;
}

export interface MongoCollection extends Resource<
  "Azure.CosmosDB.MongoCollection",
  MongoCollectionProps,
  {
    /** Name of the collection. */
    collectionName: string;
    /** Name of the MongoDB database. */
    database: string;
    /** Name of the Cosmos DB account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the collection. */
    collectionId: string;
    /** System-generated resource ID (`_rid`). */
    rid: string | undefined;
    /** Shard key field, when sharded. */
    shardKey: string | undefined;
    /** Dedicated manual throughput in RU/s, when provisioned. */
    throughput: number | undefined;
    /** Dedicated autoscale maximum throughput in RU/s, when provisioned. */
    autoscaleMaxThroughput: number | undefined;
  },
  never,
  Providers
> {}

/**
 * A collection in an Azure Cosmos DB for MongoDB (RU) database.
 *
 * Cosmos DB does not keep tags on collections; Alchemy treats one it created
 * (or one under a generated name) as its own.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/mongodb/introduction
 *
 * ### Creating a Collection
 * **Example:** Sharded collection with a unique index
 * ```typescript
 * const users = yield* Azure.CosmosDB.MongoCollection("users", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   database: database.databaseName,
 *   shardKey: "tenantId",
 *   indexes: [{ keys: ["email"], unique: true }],
 * });
 * ```
 *
 * ### Expiring Documents
 * **Example:** TTL index that expires documents after an hour
 * ```typescript
 * const sessions = yield* Azure.CosmosDB.MongoCollection("sessions", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   database: database.databaseName,
 *   indexes: [{ keys: ["_ts"], expireAfterSeconds: 3600 }],
 * });
 * ```
 *
 * @resource
 */
export const MongoCollection = Resource<MongoCollection>(
  "Azure.CosmosDB.MongoCollection",
);

type ObservedCollection = cosmos.GetMongoDBResourceMongoDBCollectionResponse;

export class MongoNamespaceTooLong extends Data.TaggedError(
  "Azure.CosmosDB.MongoNamespaceTooLong",
)<{
  readonly namespace: string;
  readonly message: string;
}> {}

/**
 * MongoDB limits the `database.collection` namespace to 120 bytes. Cosmos
 * accepts a longer one and then silently drops the collection, so the limit
 * is checked up front.
 */
const MAX_NAMESPACE_BYTES = 120;

const createCollectionName = Effect.fn(function* (id: string) {
  return (yield* createPhysicalName({ id, maxLength: 64 })).replace(
    /[^A-Za-z0-9_-]/g,
    "-",
  );
});

const getCollection = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  databaseName: string,
  collectionName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetMongoDBResourceMongoDBCollection({
      subscriptionId,
      resourceGroupName,
      accountName,
      databaseName,
      collectionName,
    }),
  );

const ID_INDEX: MongoCollectionIndex = { keys: ["_id"] };

/** Desired indexes, always including the mandatory `_id` index. */
const desiredIndexes = (props: MongoCollectionProps) => {
  const indexes = props.indexes ?? [];
  return indexes.some((i) => i.keys.length === 1 && i.keys[0] === "_id")
    ? indexes
    : [ID_INDEX, ...indexes];
};

const toWireIndexes = (indexes: readonly MongoCollectionIndex[]) =>
  indexes.map((index) => ({
    key: { keys: [...index.keys] },
    options:
      index.unique !== undefined || index.expireAfterSeconds !== undefined
        ? {
            unique: index.unique,
            expireAfterSeconds: index.expireAfterSeconds,
          }
        : undefined,
  }));

const indexesKey = (
  indexes: ReadonlyArray<{
    key?: { keys?: readonly string[] };
    options?: { unique?: boolean; expireAfterSeconds?: number };
  }>,
) =>
  indexes
    .map((index) =>
      canonical({
        keys: index.key?.keys ?? [],
        unique: index.options?.unique ? true : undefined,
        expireAfterSeconds: index.options?.expireAfterSeconds,
      }),
    )
    .sort()
    .join("|");

const shardKeyOf = (collection: ObservedCollection) =>
  Object.keys(collection.properties?.resource?.shardKey ?? {})[0];

const toAttrs = (
  resourceGroup: string,
  account: string,
  database: string,
  name: string,
  collection: ObservedCollection,
  throughput: ThroughputProps,
): MongoCollection["Attributes"] => ({
  collectionName: name,
  database,
  account,
  resourceGroup,
  collectionId: collection.id ?? "",
  rid: collection.properties?.resource?._rid,
  shardKey: shardKeyOf(collection),
  throughput: throughput.throughput,
  autoscaleMaxThroughput: throughput.autoscaleMaxThroughput,
});

export const MongoCollectionProvider = () =>
  Provider.succeed(MongoCollection, {
    stables: [
      "collectionName",
      "database",
      "account",
      "resourceGroup",
      "collectionId",
      "rid",
      "shardKey",
    ],

    // Collections disappear with their database.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account !== output.account ||
        news.database !== output.database ||
        (news.name !== undefined && news.name !== output.collectionName) ||
        news.shardKey !== output.shardKey ||
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
        output?.collectionName ??
        olds?.name ??
        (yield* createCollectionName(id));
      const observed = yield* getCollection(
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
        news.name ??
        output?.collectionName ??
        (yield* createCollectionName(id));
      const indexes = toWireIndexes(desiredIndexes(news));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        databaseName: database,
        collectionName: name,
      };
      const label = `Cosmos DB MongoDB collection ${name}`;
      const get = getCollection(
        subscriptionId,
        resourceGroup,
        account,
        database,
        name,
      );
      const converged = (collection: ObservedCollection) => {
        const resource = collection.properties?.resource;
        return (
          indexesKey(resource?.indexes ?? []) === indexesKey(indexes) &&
          (news.analyticalStorageTtl === undefined ||
            resource?.analyticalStorageTtl === news.analyticalStorageTtl)
        );
      };

      const namespace = `${database}.${name}`;
      const bytes = yield* Effect.sync(() => Buffer.byteLength(namespace));
      if (bytes > MAX_NAMESPACE_BYTES) {
        return yield* new MongoNamespaceTooLong({
          namespace,
          message: `MongoDB namespace '${namespace}' exceeds ${MAX_NAMESPACE_BYTES} bytes; shorten the database or collection name`,
        });
      }

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT replaces the whole collection definition; the
      // shard key is re-sent as observed, throughput only at creation.
      if (observed === undefined || !converged(observed)) {
        const shardKey = observed ? shardKeyOf(observed) : news.shardKey;
        yield* cosmos
          .MongoDBResourcesCreateUpdateMongoDBCollection({
            ...where,
            properties: {
              resource: {
                id: name,
                shardKey: shardKey ? { [shardKey]: "Hash" } : undefined,
                indexes,
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
        get: cosmos.GetMongoDBResourceMongoDBCollectionThroughput(where),
        update: (resource) =>
          cosmos.UpdateMongoDBResourceMongoDBCollectionThroughput({
            ...where,
            properties: { resource },
          }),
        toAutoscale:
          cosmos.MigrateMongoDBResourceMongoDBCollectionToAutoscale(where),
        toManual:
          cosmos.MigrateMongoDBResourceMongoDBCollectionToManualThroughput(
            where,
          ),
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
          .DeleteMongoDBResourceMongoDBCollection({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            databaseName: output.database,
            collectionName: output.collectionName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB MongoDB collection ${output.collectionName}`,
        getCollection(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.database,
          output.collectionName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.CosmosDB.MongoDatabase",
        "Azure.CosmosDB.DatabaseAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
