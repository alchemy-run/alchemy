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
  createOptions,
  hasDedicatedThroughput,
  isOwnedChild,
  syncThroughput,
  type ThroughputProps,
  waitForChild,
  whileAccountBusy,
} from "./Shared.ts";

export interface MongoDatabaseProps extends ThroughputProps {
  /** Resource group of the account. Changing it replaces the database. */
  resourceGroup: string;
  /**
   * Name of a Cosmos DB account of kind `MongoDB`, e.g.
   * `account.accountName`. Changing it replaces the database.
   */
  account: string;
  /**
   * Database name (up to 63 characters; keep `database.collection` within
   * 120 bytes, no `/`, `\`, `.`, `"`, `$`, `*`,
   * `<`, `>`, `:`, `|`, `?`, or spaces). If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * database.
   */
  name?: string;
}

export interface MongoDatabase extends Resource<
  "Azure.CosmosDB.MongoDatabase",
  MongoDatabaseProps,
  {
    /** Name of the database. */
    databaseName: string;
    /** Name of the Cosmos DB account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the database. */
    databaseId: string;
    /** System-generated resource ID (`_rid`). */
    rid: string | undefined;
    /** Shared manual throughput in RU/s, when provisioned. */
    throughput: number | undefined;
    /** Shared autoscale maximum throughput in RU/s, when provisioned. */
    autoscaleMaxThroughput: number | undefined;
  },
  never,
  Providers
> {}

/**
 * A database in an Azure Cosmos DB for MongoDB (RU) account. Collections
 * live inside a database; give the database throughput to share it across
 * collections.
 *
 * Cosmos DB does not keep tags on databases; Alchemy treats one it created
 * (or one under a generated name) as its own.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/mongodb/introduction
 *
 * ### Creating a Database
 * **Example:** Database on a serverless MongoDB account
 * ```typescript
 * const account = yield* Azure.CosmosDB.DatabaseAccount("mongo", {
 *   resourceGroup: group.resourceGroupName,
 *   kind: "MongoDB",
 *   capabilities: ["EnableServerless", "EnableMongo"],
 *   serverVersion: "4.2",
 * });
 * const database = yield* Azure.CosmosDB.MongoDatabase("app", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 * });
 * ```
 *
 * ### Shared Throughput
 * **Example:** Manual throughput shared by every collection
 * ```typescript
 * const database = yield* Azure.CosmosDB.MongoDatabase("app", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   throughput: 400,
 * });
 * ```
 *
 * @resource
 */
export const MongoDatabase = Resource<MongoDatabase>(
  "Azure.CosmosDB.MongoDatabase",
);

const createDatabaseName = Effect.fn(function* (id: string) {
  return (yield* createPhysicalName({ id, maxLength: 40 })).replace(
    /[^A-Za-z0-9_-]/g,
    "-",
  );
});

const getDatabase = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  databaseName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetMongoDBResourceMongoDBDatabase({
      subscriptionId,
      resourceGroupName,
      accountName,
      databaseName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  database: cosmos.GetMongoDBResourceMongoDBDatabaseResponse,
  throughput: ThroughputProps,
): MongoDatabase["Attributes"] => ({
  databaseName: name,
  account,
  resourceGroup,
  databaseId: database.id ?? "",
  rid: database.properties?.resource?._rid,
  throughput: throughput.throughput,
  autoscaleMaxThroughput: throughput.autoscaleMaxThroughput,
});

export const MongoDatabaseProvider = () =>
  Provider.succeed(MongoDatabase, {
    stables: ["databaseName", "account", "resourceGroup", "databaseId", "rid"],

    // Databases disappear with their account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account !== output.account ||
        (news.name !== undefined && news.name !== output.databaseName) ||
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
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.databaseName ?? olds?.name ?? (yield* createDatabaseName(id));
      const observed = yield* getDatabase(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed, {
        throughput: output?.throughput,
        autoscaleMaxThroughput: output?.autoscaleMaxThroughput,
      });
      return isOwnedChild(output, olds?.name) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const { resourceGroup, account } = news;
      const name =
        news.name ?? output?.databaseName ?? (yield* createDatabaseName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        databaseName: name,
      };
      const label = `Cosmos DB MongoDB database ${name}`;
      const get = getDatabase(subscriptionId, resourceGroup, account, name);

      // Observe.
      let observed = yield* get;

      // Ensure. Nothing else is mutable in place except throughput, which
      // `options` sets only at creation.
      if (observed === undefined) {
        yield* cosmos
          .MongoDBResourcesCreateUpdateMongoDBDatabase({
            ...where,
            properties: {
              resource: { id: name },
              options: createOptions(news),
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
        observed = yield* waitForChild(label, get, () => true);
      }

      // Sync dedicated throughput against observed throughput settings.
      const throughput = yield* syncThroughput(label, news, {
        get: cosmos.GetMongoDBResourceMongoDBDatabaseThroughput(where),
        update: (resource) =>
          cosmos.UpdateMongoDBResourceMongoDBDatabaseThroughput({
            ...where,
            properties: { resource },
          }),
        toAutoscale: cosmos.MigrateMongoDBResourceMongoDBDatabaseToAutoscale(where),
        toManual: cosmos.MigrateMongoDBResourceMongoDBDatabaseToManualThroughput(where),
      });

      return toAttrs(resourceGroup, account, name, observed, throughput);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cosmos
          .DeleteMongoDBResourceMongoDBDatabase({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            databaseName: output.databaseName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB MongoDB database ${output.databaseName}`,
        getDatabase(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.databaseName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.CosmosDB.DatabaseAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
