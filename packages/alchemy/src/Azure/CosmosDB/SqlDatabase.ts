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

export interface SqlDatabaseProps extends ThroughputProps {
  /** Resource group of the account. Changing it replaces the database. */
  resourceGroup: string;
  /**
   * Name of the Cosmos DB account (kind `GlobalDocumentDB`), e.g.
   * `account.accountName`. Changing it replaces the database.
   */
  account: string;
  /**
   * Database name (up to 255 characters, no `/`, `\`, `#`, or `?`). If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the database.
   */
  name?: string;
}

export interface SqlDatabase extends Resource<
  "Azure.CosmosDB.SqlDatabase",
  SqlDatabaseProps,
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
 * A database in an Azure Cosmos DB for NoSQL account. Containers live inside
 * a database; give the database throughput to share it across containers.
 *
 * Cosmos DB does not keep tags on databases; Alchemy treats one it created
 * (or one under a generated name) as its own.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/nosql/
 *
 * ### Creating a Database
 * **Example:** Database on a serverless account
 * ```typescript
 * const account = yield* Azure.CosmosDB.DatabaseAccount("db", {
 *   resourceGroup: group.resourceGroupName,
 *   capabilities: ["EnableServerless"],
 * });
 * const database = yield* Azure.CosmosDB.SqlDatabase("app", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 * });
 * ```
 *
 * ### Shared Throughput
 * **Example:** Autoscale throughput shared by every container
 * ```typescript
 * const database = yield* Azure.CosmosDB.SqlDatabase("app", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   autoscaleMaxThroughput: 1000,
 * });
 * ```
 *
 * @resource
 */
export const SqlDatabase = Resource<SqlDatabase>("Azure.CosmosDB.SqlDatabase");

const createDatabaseName = (id: string) =>
  createPhysicalName({ id, maxLength: 255 });

const getDatabase = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  databaseName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetSqlResourceSqlDatabase({
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
  database: cosmos.GetSqlResourceSqlDatabaseResponse,
  throughput: ThroughputProps,
): SqlDatabase["Attributes"] => ({
  databaseName: name,
  account,
  resourceGroup,
  databaseId: database.id ?? "",
  rid: database.properties?.resource?._rid,
  throughput: throughput.throughput,
  autoscaleMaxThroughput: throughput.autoscaleMaxThroughput,
});

export const SqlDatabaseProvider = () =>
  Provider.succeed(SqlDatabase, {
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
      const label = `Cosmos DB SQL database ${name}`;
      const get = getDatabase(subscriptionId, resourceGroup, account, name);

      // Observe.
      let observed = yield* get;

      // Ensure. Nothing else is mutable in place except throughput, which
      // `options` sets only at creation.
      if (observed === undefined) {
        yield* cosmos
          .SqlResourcesCreateUpdateSqlDatabase({
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
        get: cosmos.GetSqlResourceSqlDatabaseThroughput(where),
        update: (resource) =>
          cosmos.UpdateSqlResourceSqlDatabaseThroughput({
            ...where,
            properties: { resource },
          }),
        toAutoscale: cosmos.MigrateSqlResourceSqlDatabaseToAutoscale(where),
        toManual: cosmos.MigrateSqlResourceSqlDatabaseToManualThroughput(where),
      });

      return toAttrs(resourceGroup, account, name, observed, throughput);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cosmos
          .DeleteSqlResourceSqlDatabase({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            databaseName: output.databaseName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB SQL database ${output.databaseName}`,
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
