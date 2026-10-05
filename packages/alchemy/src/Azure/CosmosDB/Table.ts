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

export interface TableProps extends ThroughputProps {
  /** Resource group of the account. Changing it replaces the table. */
  resourceGroup: string;
  /**
   * Name of a Cosmos DB account with the `EnableTable` capability, e.g.
   * `account.accountName`. Changing it replaces the table.
   */
  account: string;
  /**
   * Table name: 3-63 letters and digits, starting with a letter. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the table.
   */
  name?: string;
}

export interface Table extends Resource<
  "Azure.CosmosDB.Table",
  TableProps,
  {
    /** Name of the table. */
    tableName: string;
    /** Name of the Cosmos DB account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the table. */
    tableId: string;
    /** System-generated resource ID (`_rid`). */
    rid: string | undefined;
    /** Dedicated manual throughput in RU/s, when provisioned. */
    throughput: number | undefined;
    /** Dedicated autoscale maximum throughput in RU/s, when provisioned. */
    autoscaleMaxThroughput: number | undefined;
  },
  never,
  Providers
> {}

/**
 * A table in an Azure Cosmos DB for Table account — a key/value store
 * compatible with the Azure Table Storage API. The account needs the
 * `EnableTable` capability.
 *
 * Cosmos DB does not keep tags on tables; Alchemy treats one it created
 * (or one under a generated name) as its own.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/table/introduction
 *
 * ### Creating a Table
 * **Example:** Table on a serverless Table API account
 * ```typescript
 * const account = yield* Azure.CosmosDB.DatabaseAccount("tables", {
 *   resourceGroup: group.resourceGroupName,
 *   capabilities: ["EnableServerless", "EnableTable"],
 * });
 * const sessions = yield* Azure.CosmosDB.Table("sessions", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 * });
 * ```
 *
 * ### Dedicated Throughput
 * **Example:** Autoscale table on a provisioned account
 * ```typescript
 * const events = yield* Azure.CosmosDB.Table("events", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   autoscaleMaxThroughput: 1000,
 * });
 * ```
 *
 * @resource
 */
export const Table = Resource<Table>("Azure.CosmosDB.Table");

const createTableName = Effect.fn(function* (id: string) {
  const name = (yield* createPhysicalName({
    id,
    maxLength: 63,
    delimiter: "",
  })).replace(/[^A-Za-z0-9]/g, "");
  return /^[A-Za-z]/.test(name) ? name : `t${name}`.slice(0, 63);
});

const getTable = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  tableName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetTableResourceTable({
      subscriptionId,
      resourceGroupName,
      accountName,
      tableName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  table: cosmos.GetTableResourceTableResponse,
  throughput: ThroughputProps,
): Table["Attributes"] => ({
  tableName: name,
  account,
  resourceGroup,
  tableId: table.id ?? "",
  rid: table.properties?.resource?._rid,
  throughput: throughput.throughput,
  autoscaleMaxThroughput: throughput.autoscaleMaxThroughput,
});

export const TableProvider = () =>
  Provider.succeed(Table, {
    stables: ["tableName", "account", "resourceGroup", "tableId", "rid"],

    // Tables disappear with their account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account !== output.account ||
        (news.name !== undefined && news.name !== output.tableName) ||
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
        output?.tableName ?? olds?.name ?? (yield* createTableName(id));
      const observed = yield* getTable(
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
        news.name ?? output?.tableName ?? (yield* createTableName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        tableName: name,
      };
      const label = `Cosmos DB table ${name}`;
      const get = getTable(subscriptionId, resourceGroup, account, name);

      // Observe.
      let observed = yield* get;

      // Ensure. Nothing else is mutable in place except throughput, which
      // `options` sets only at creation.
      if (observed === undefined) {
        yield* cosmos
          .TableResourcesCreateUpdateTable({
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
        get: cosmos.GetTableResourceTableThroughput(where),
        update: (resource) =>
          cosmos.UpdateTableResourceTableThroughput({
            ...where,
            properties: { resource },
          }),
        toAutoscale: cosmos.MigrateTableResourceTableToAutoscale(where),
        toManual: cosmos.MigrateTableResourceTableToManualThroughput(where),
      });

      return toAttrs(resourceGroup, account, name, observed, throughput);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cosmos
          .DeleteTableResourceTable({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            tableName: output.tableName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB table ${output.tableName}`,
        getTable(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.tableName,
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
