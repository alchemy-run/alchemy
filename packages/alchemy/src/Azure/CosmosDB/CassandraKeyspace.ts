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

export interface CassandraKeyspaceProps extends ThroughputProps {
  /** Resource group of the account. Changing it replaces the keyspace. */
  resourceGroup: string;
  /**
   * Name of a Cosmos DB account with the `EnableCassandra` capability, e.g.
   * `account.accountName`. Changing it replaces the keyspace.
   */
  account: string;
  /**
   * Keyspace name: up to 48 letters, digits, and underscores, starting with
   * a letter. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the keyspace.
   */
  name?: string;
}

export interface CassandraKeyspace extends Resource<
  "Azure.CosmosDB.CassandraKeyspace",
  CassandraKeyspaceProps,
  {
    /** Name of the keyspace. */
    keyspaceName: string;
    /** Name of the Cosmos DB account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the keyspace. */
    keyspaceId: string;
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
 * A keyspace in an Azure Cosmos DB for Apache Cassandra account. Tables
 * live inside a keyspace; give the keyspace throughput to share it across
 * its tables.
 *
 * Cosmos DB does not keep tags on keyspaces; Alchemy treats one it created
 * (or one under a generated name) as its own.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/cassandra/introduction
 *
 * ### Creating a Keyspace
 * **Example:** Keyspace on a serverless Cassandra account
 * ```typescript
 * const account = yield* Azure.CosmosDB.DatabaseAccount("cassandra", {
 *   resourceGroup: group.resourceGroupName,
 *   capabilities: ["EnableServerless", "EnableCassandra"],
 * });
 * const keyspace = yield* Azure.CosmosDB.CassandraKeyspace("app", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 * });
 * ```
 *
 * ### Shared Throughput
 * **Example:** Manual throughput shared by every table
 * ```typescript
 * const keyspace = yield* Azure.CosmosDB.CassandraKeyspace("app", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   throughput: 400,
 * });
 * ```
 *
 * @resource
 */
export const CassandraKeyspace = Resource<CassandraKeyspace>(
  "Azure.CosmosDB.CassandraKeyspace",
);

const createKeyspaceName = Effect.fn(function* (id: string) {
  const name = (yield* createPhysicalName({
    id,
    maxLength: 48,
    delimiter: "_",
  })).replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z]/.test(name) ? name : `k${name}`.slice(0, 48);
});

const getKeyspace = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  keyspaceName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetCassandraResourceCassandraKeyspace({
      subscriptionId,
      resourceGroupName,
      accountName,
      keyspaceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  keyspace: cosmos.GetCassandraResourceCassandraKeyspaceResponse,
  throughput: ThroughputProps,
): CassandraKeyspace["Attributes"] => ({
  keyspaceName: name,
  account,
  resourceGroup,
  keyspaceId: keyspace.id ?? "",
  rid: keyspace.properties?.resource?._rid,
  throughput: throughput.throughput,
  autoscaleMaxThroughput: throughput.autoscaleMaxThroughput,
});

export const CassandraKeyspaceProvider = () =>
  Provider.succeed(CassandraKeyspace, {
    stables: ["keyspaceName", "account", "resourceGroup", "keyspaceId", "rid"],

    // Keyspaces disappear with their account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account !== output.account ||
        (news.name !== undefined && news.name !== output.keyspaceName) ||
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
        output?.keyspaceName ?? olds?.name ?? (yield* createKeyspaceName(id));
      const observed = yield* getKeyspace(
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
        news.name ?? output?.keyspaceName ?? (yield* createKeyspaceName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        keyspaceName: name,
      };
      const label = `Cosmos DB Cassandra keyspace ${name}`;
      const get = getKeyspace(subscriptionId, resourceGroup, account, name);

      // Observe.
      let observed = yield* get;

      // Ensure. Only throughput is mutable in place; `options` sets it only
      // at creation.
      if (observed === undefined) {
        yield* cosmos
          .CassandraResourcesCreateUpdateCassandraKeyspace({
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
        get: cosmos.GetCassandraResourceCassandraKeyspaceThroughput(where),
        update: (resource) =>
          cosmos.UpdateCassandraResourceCassandraKeyspaceThroughput({
            ...where,
            properties: { resource },
          }),
        toAutoscale:
          cosmos.MigrateCassandraResourceCassandraKeyspaceToAutoscale(where),
        toManual:
          cosmos.MigrateCassandraResourceCassandraKeyspaceToManualThroughput(
            where,
          ),
      });

      return toAttrs(resourceGroup, account, name, observed, throughput);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cosmos
          .DeleteCassandraResourceCassandraKeyspace({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            keyspaceName: output.keyspaceName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB Cassandra keyspace ${output.keyspaceName}`,
        getKeyspace(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.keyspaceName,
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
