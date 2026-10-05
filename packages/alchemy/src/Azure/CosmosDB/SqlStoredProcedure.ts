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

export interface SqlStoredProcedureProps {
  /** Resource group of the account. Changing it replaces the procedure. */
  resourceGroup: string;
  /** Name of the Cosmos DB account. Changing it replaces the procedure. */
  account: string;
  /** Name of the SQL database. Changing it replaces the procedure. */
  database: string;
  /** Name of the container, e.g. `container.containerName`. Changing it replaces the procedure. */
  container: string;
  /**
   * Stored procedure name (up to 255 characters, no `/`, `\`, `#`, or `?`).
   * If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the procedure.
   */
  name?: string;
  /**
   * JavaScript source of the procedure, a `function` declaration that
   * uses the server-side `getContext()` API. Updated in place.
   */
  body: string;
}

export interface SqlStoredProcedure extends Resource<
  "Azure.CosmosDB.SqlStoredProcedure",
  SqlStoredProcedureProps,
  {
    /** Name of the stored procedure. */
    storedProcedureName: string;
    /** Name of the container. */
    container: string;
    /** Name of the SQL database. */
    database: string;
    /** Name of the Cosmos DB account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the stored procedure. */
    storedProcedureId: string;
    /** System-generated resource ID (`_rid`). */
    rid: string | undefined;
    /** Entity tag of the current body (`_etag`). */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A JavaScript stored procedure in an Azure Cosmos DB for NoSQL container.
 * Stored procedures run transactionally inside one logical partition.
 *
 * Cosmos DB does not keep tags on stored procedures; Alchemy treats one it
 * created (or one under a generated name) as its own.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/nosql/stored-procedures-triggers-udfs
 *
 * ### Creating a Stored Procedure
 * **Example:** Hello-world procedure
 * ```typescript
 * const sproc = yield* Azure.CosmosDB.SqlStoredProcedure("hello", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   database: database.databaseName,
 *   container: container.containerName,
 *   body: `function hello() {
 *     getContext().getResponse().setBody("Hello, World");
 *   }`,
 * });
 * ```
 *
 * **Example:** Procedure with a fixed name
 * ```typescript
 * yield* Azure.CosmosDB.SqlStoredProcedure("bulk-delete", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   database: database.databaseName,
 *   container: container.containerName,
 *   name: "bulkDelete",
 *   body: bulkDeleteSource,
 * });
 * ```
 *
 * @resource
 */
export const SqlStoredProcedure = Resource<SqlStoredProcedure>(
  "Azure.CosmosDB.SqlStoredProcedure",
);

const createName = (id: string) => createPhysicalName({ id, maxLength: 255 });

const getProcedure = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  databaseName: string,
  containerName: string,
  storedProcedureName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetSqlResourceSqlStoredProcedure({
      subscriptionId,
      resourceGroupName,
      accountName,
      databaseName,
      containerName,
      storedProcedureName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  database: string,
  container: string,
  name: string,
  observed: cosmos.GetSqlResourceSqlStoredProcedureResponse,
): SqlStoredProcedure["Attributes"] => ({
  storedProcedureName: name,
  container,
  database,
  account,
  resourceGroup,
  storedProcedureId: observed.id ?? "",
  rid: observed.properties?.resource?._rid,
  etag: observed.properties?.resource?._etag,
});

export const SqlStoredProcedureProvider = () =>
  Provider.succeed(SqlStoredProcedure, {
    stables: [
      "storedProcedureName",
      "container",
      "database",
      "account",
      "resourceGroup",
      "storedProcedureId",
    ],

    // Stored procedures disappear with their container.
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
        (news.name !== undefined && news.name !== output.storedProcedureName)
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
        output?.storedProcedureName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getProcedure(
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
        news.name ?? output?.storedProcedureName ?? (yield* createName(id));
      const get = getProcedure(
        subscriptionId,
        resourceGroup,
        account,
        database,
        container,
        name,
      );
      const converged = (
        observed: cosmos.GetSqlResourceSqlStoredProcedureResponse,
      ) => observed.properties?.resource?.body === news.body;

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT replaces the whole procedure; skip it when
      // the observed body already matches.
      if (observed === undefined || !converged(observed)) {
        yield* cosmos
          .SqlResourcesCreateUpdateSqlStoredProcedure({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            databaseName: database,
            containerName: container,
            storedProcedureName: name,
            properties: { resource: { id: name, body: news.body } },
          })
          .pipe(Effect.retry(whileAccountBusy));
        observed = yield* waitForChild(
          `Cosmos DB stored procedure ${name}`,
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
          .DeleteSqlResourceSqlStoredProcedure({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            databaseName: output.database,
            containerName: output.container,
            storedProcedureName: output.storedProcedureName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB stored procedure ${output.storedProcedureName}`,
        getProcedure(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.database,
          output.container,
          output.storedProcedureName,
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
