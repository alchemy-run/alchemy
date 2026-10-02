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
import { isOwnedChild, waitForChild, whileAccountBusy } from "./Shared.ts";

export interface SqlUserDefinedFunctionProps {
  /** Resource group of the account. Changing it replaces the function. */
  resourceGroup: string;
  /** Name of the Cosmos DB account. Changing it replaces the function. */
  account: string;
  /** Name of the SQL database. Changing it replaces the function. */
  database: string;
  /** Name of the container, e.g. `container.containerName`. Changing it replaces the function. */
  container: string;
  /**
   * Function name, used to call it as `udf.<name>(...)` in queries (up to 255 characters, no `/`, `\`, `#`, or `?`).
   * If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the function.
   */
  name?: string;
  /**
   * JavaScript source of the function, a `function` declaration that
   * returns a value computed from its arguments. Updated in place.
   */
  body: string;
}

export interface SqlUserDefinedFunction extends Resource<
  "Azure.CosmosDB.SqlUserDefinedFunction",
  SqlUserDefinedFunctionProps,
  {
    /** Name of the user-defined function. */
    userDefinedFunctionName: string;
    /** Name of the container. */
    container: string;
    /** Name of the SQL database. */
    database: string;
    /** Name of the Cosmos DB account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the user-defined function. */
    userDefinedFunctionId: string;
    /** System-generated resource ID (`_rid`). */
    rid: string | undefined;
    /** Entity tag of the current body (`_etag`). */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A JavaScript user-defined function (UDF) in an Azure Cosmos DB for NoSQL
 * container. Call it from queries as `udf.<name>(...)`.
 *
 * Cosmos DB does not keep tags on user-defined functions; Alchemy treats one it
 * created (or one under a generated name) as its own.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/nosql/stored-procedures-triggers-udfs
 *
 * ### Creating a Function
 * **Example:** Tax calculation usable as `udf.tax(c.income)`
 * ```typescript
 * yield* Azure.CosmosDB.SqlUserDefinedFunction("tax", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   database: database.databaseName,
 *   container: container.containerName,
 *   name: "tax",
 *   body: `function tax(income) {
 *     return income > 1000 ? income * 0.4 : income * 0.1;
 *   }`,
 * });
 * ```
 *
 * @resource
 */
export const SqlUserDefinedFunction = Resource<SqlUserDefinedFunction>(
  "Azure.CosmosDB.SqlUserDefinedFunction",
);

const createName = (id: string) => createPhysicalName({ id, maxLength: 255 });

const getFunction = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  databaseName: string,
  containerName: string,
  userDefinedFunctionName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetSqlResourceSqlUserDefinedFunction({
      subscriptionId,
      resourceGroupName,
      accountName,
      databaseName,
      containerName,
      userDefinedFunctionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  database: string,
  container: string,
  name: string,
  observed: cosmos.GetSqlResourceSqlUserDefinedFunctionResponse,
): SqlUserDefinedFunction["Attributes"] => ({
  userDefinedFunctionName: name,
  container,
  database,
  account,
  resourceGroup,
  userDefinedFunctionId: observed.id ?? "",
  rid: observed.properties?.resource?._rid,
  etag: observed.properties?.resource?._etag,
});

export const SqlUserDefinedFunctionProvider = () =>
  Provider.succeed(SqlUserDefinedFunction, {
    stables: [
      "userDefinedFunctionName",
      "container",
      "database",
      "account",
      "resourceGroup",
      "userDefinedFunctionId",
    ],

    // Functions disappear with their container.
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
        news.container !== output.container ||
        (news.name !== undefined &&
          news.name !== output.userDefinedFunctionName)
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
      const container = output?.container ?? olds?.container;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        database === undefined ||
        container === undefined
      ) {
        return undefined;
      }
      const name =
        output?.userDefinedFunctionName ??
        olds?.name ??
        (yield* createName(id));
      const observed = yield* getFunction(
        subscriptionId,
        resourceGroup,
        account,
        database,
        container,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        account,
        database,
        container,
        name,
        observed,
      );
      return isOwnedChild(output, olds?.name) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const { resourceGroup, account, database, container } = news;
      const name =
        news.name ?? output?.userDefinedFunctionName ?? (yield* createName(id));
      const get = getFunction(
        subscriptionId,
        resourceGroup,
        account,
        database,
        container,
        name,
      );
      const converged = (
        observed: cosmos.GetSqlResourceSqlUserDefinedFunctionResponse,
      ) => observed.properties?.resource?.body === news.body;

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT replaces the whole function; skip it when
      // the observed body already matches.
      if (observed === undefined || !converged(observed)) {
        yield* cosmos
          .SqlResourcesCreateUpdateSqlUserDefinedFunction({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            databaseName: database,
            containerName: container,
            userDefinedFunctionName: name,
            properties: { resource: { id: name, body: news.body } },
          })
          .pipe(Effect.retry(whileAccountBusy));
        observed = yield* waitForChild(
          `Cosmos DB user-defined function ${name}`,
          get,
          converged,
        );
      }

      return toAttrs(
        resourceGroup,
        account,
        database,
        container,
        name,
        observed,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cosmos
          .DeleteSqlResourceSqlUserDefinedFunction({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            databaseName: output.database,
            containerName: output.container,
            userDefinedFunctionName: output.userDefinedFunctionName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB user-defined function ${output.userDefinedFunctionName}`,
        getFunction(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.database,
          output.container,
          output.userDefinedFunctionName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.CosmosDB.SqlContainer",
        "Azure.CosmosDB.SqlDatabase",
        "Azure.CosmosDB.DatabaseAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
