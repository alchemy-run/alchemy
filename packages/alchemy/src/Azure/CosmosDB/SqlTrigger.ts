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

export interface SqlTriggerProps {
  /** Resource group of the account. Changing it replaces the trigger. */
  resourceGroup: string;
  /** Name of the Cosmos DB account. Changing it replaces the trigger. */
  account: string;
  /** Name of the SQL database. Changing it replaces the trigger. */
  database: string;
  /** Name of the container, e.g. `container.containerName`. Changing it replaces the trigger. */
  container: string;
  /**
   * Trigger name (up to 255 characters, no `/`, `\`, `#`, or `?`).
   * If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the trigger.
   */
  name?: string;
  /**
   * JavaScript source of the trigger, a `function` declaration that
   * uses the server-side `getContext()` API. Updated in place.
   */
  body: string;
  /** Run before (`Pre`) or after (`Post`) the operation. Updated in place. */
  triggerType: SqlTriggerType;
  /**
   * Operation the trigger applies to. Updated in place.
   * @default "All"
   */
  triggerOperation?: SqlTriggerOperation;
}

/** When a trigger runs relative to its operation. */
export type SqlTriggerType = "Pre" | "Post";

/** Item operation a trigger applies to. */
export type SqlTriggerOperation =
  | "All"
  | "Create"
  | "Update"
  | "Delete"
  | "Replace";

export interface SqlTrigger extends Resource<
  "Azure.CosmosDB.SqlTrigger",
  SqlTriggerProps,
  {
    /** Name of the trigger. */
    triggerName: string;
    /** Name of the container. */
    container: string;
    /** Name of the SQL database. */
    database: string;
    /** Name of the Cosmos DB account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the trigger. */
    triggerId: string;
    /** System-generated resource ID (`_rid`). */
    rid: string | undefined;
    /** Entity tag of the current body (`_etag`). */
    etag: string | undefined;
    /** When the trigger runs. */
    triggerType: string | undefined;
    /** Operation the trigger applies to. */
    triggerOperation: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A JavaScript pre- or post-trigger in an Azure Cosmos DB for NoSQL
 * container. Triggers run only when a request names them explicitly.
 *
 * Cosmos DB does not keep tags on triggers; Alchemy treats one it
 * created (or one under a generated name) as its own.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/nosql/stored-procedures-triggers-udfs
 *
 * ### Creating a Trigger
 * **Example:** Stamp a timestamp on every created item
 * ```typescript
 * yield* Azure.CosmosDB.SqlTrigger("stamp", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   database: database.databaseName,
 *   container: container.containerName,
 *   name: "stampCreated",
 *   triggerType: "Pre",
 *   triggerOperation: "Create",
 *   body: `function stampCreated() {
 *     const request = getContext().getRequest();
 *     const item = request.getBody();
 *     item.createdAt = new Date().toISOString();
 *     request.setBody(item);
 *   }`,
 * });
 * ```
 *
 * @resource
 */
export const SqlTrigger = Resource<SqlTrigger>("Azure.CosmosDB.SqlTrigger");

const createName = (id: string) => createPhysicalName({ id, maxLength: 255 });

const getTrigger = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  databaseName: string,
  containerName: string,
  triggerName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.SqlResourcesGetSqlTrigger({
      subscriptionId,
      resourceGroupName,
      accountName,
      databaseName,
      containerName,
      triggerName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  database: string,
  container: string,
  name: string,
  observed: cosmos.SqlResourcesGetSqlTriggerResponse,
): SqlTrigger["Attributes"] => ({
  triggerName: name,
  container,
  database,
  account,
  resourceGroup,
  triggerId: observed.id ?? "",
  rid: observed.properties?.resource?._rid,
  etag: observed.properties?.resource?._etag,
  triggerType: observed.properties?.resource?.triggerType,
  triggerOperation: observed.properties?.resource?.triggerOperation,
});

export const SqlTriggerProvider = () =>
  Provider.succeed(SqlTrigger, {
    stables: [
      "triggerName",
      "container",
      "database",
      "account",
      "resourceGroup",
      "triggerId",
    ],

    // Triggers disappear with their container.
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
        (news.name !== undefined && news.name !== output.triggerName)
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
      const name = output?.triggerName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getTrigger(
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
      const name = news.name ?? output?.triggerName ?? (yield* createName(id));
      const triggerOperation = news.triggerOperation ?? "All";
      const get = getTrigger(
        subscriptionId,
        resourceGroup,
        account,
        database,
        container,
        name,
      );
      const converged = (observed: cosmos.SqlResourcesGetSqlTriggerResponse) =>
        observed.properties?.resource?.body === news.body &&
        observed.properties?.resource?.triggerType === news.triggerType &&
        observed.properties?.resource?.triggerOperation === triggerOperation;

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT replaces the whole trigger; skip it when
      // the observed definition already matches.
      if (observed === undefined || !converged(observed)) {
        yield* cosmos
          .SqlResourcesCreateUpdateSqlTrigger({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            databaseName: database,
            containerName: container,
            triggerName: name,
            properties: {
              resource: {
                id: name,
                body: news.body,
                triggerType: news.triggerType,
                triggerOperation,
              },
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
        observed = yield* waitForChild(
          `Cosmos DB trigger ${name}`,
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
          .SqlResourcesDeleteSqlTrigger({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            databaseName: output.database,
            containerName: output.container,
            triggerName: output.triggerName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB trigger ${output.triggerName}`,
        getTrigger(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.database,
          output.container,
          output.triggerName,
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
