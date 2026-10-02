import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  COSMOS_LOCATION,
  logLevel,
  subscriptionId,
  waitGone,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getTable = (
  resourceGroupName: string,
  accountName: string,
  keyspaceName: string,
  tableName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetCassandraResourceCassandraTable({
      subscriptionId,
      resourceGroupName,
      accountName,
      keyspaceName,
      tableName,
    }),
  );

const BASE_COLUMNS = [
  { name: "user_id", type: "text" },
  { name: "ts", type: "timestamp" },
];

const program = (props: {
  partitionKey: string;
  extraColumn?: boolean;
  defaultTtl?: number;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: COSMOS_LOCATION,
    });
    const account = yield* Azure.CosmosDB.DatabaseAccount("Account", {
      resourceGroup: group.resourceGroupName,
      location: COSMOS_LOCATION,
      capabilities: ["EnableServerless", "EnableCassandra"],
    });
    const keyspace = yield* Azure.CosmosDB.CassandraKeyspace("App", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
    });
    const table = yield* Azure.CosmosDB.CassandraTable("Events", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      keyspace: keyspace.keyspaceName,
      defaultTtl: props.defaultTtl,
      schema: {
        columns: props.extraColumn
          ? [...BASE_COLUMNS, { name: "payload", type: "text" }]
          : BASE_COLUMNS,
        partitionKeys: [props.partitionKey],
        clusterKeys: props.partitionKey === "user_id" ? [{ name: "ts" }] : [],
      },
    });
    return { group, account, keyspace, table };
  });

// Serverless Cassandra account: no cost while idle; the account dominates
// the runtime (~2-15 min create + delete).
test.provider(
  "create, update, replace, and delete a Cosmos DB Cassandra table",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, keyspace, table } = yield* stack.deploy(
        program({ partitionKey: "user_id" }),
      );
      const where = [
        group.resourceGroupName,
        account.accountName,
        keyspace.keyspaceName,
      ] as const;
      expect(table.tableName).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(table.partitionKeys).toEqual(["user_id"]);
      expect(table.clusterKeys).toEqual([{ name: "ts", orderBy: "Asc" }]);
      const observed = yield* getTable(...where, table.tableName);
      expect(
        observed.properties?.resource?.schema?.columns?.map((c) => c.name),
      ).toEqual(["user_id", "ts"]);

      // In-place update: add a column and a default TTL.
      const updated = yield* stack.deploy(
        program({
          partitionKey: "user_id",
          extraColumn: true,
          defaultTtl: 600,
        }),
      );
      expect(updated.table.tableId).toEqual(table.tableId);
      expect(updated.table.defaultTtl).toEqual(600);
      const reobserved = yield* getTable(...where, table.tableName);
      expect(
        reobserved.properties?.resource?.schema?.columns
          ?.map((c) => c.name)
          .sort(),
      ).toEqual(["payload", "ts", "user_id"]);
      expect(reobserved.properties?.resource?.defaultTtl).toEqual(600);

      // Replacement: a new partition key creates a new table and deletes
      // the old one.
      const replaced = yield* stack.deploy(
        program({ partitionKey: "ts", extraColumn: true, defaultTtl: 600 }),
      );
      expect(replaced.table.tableName).not.toEqual(table.tableName);
      expect(replaced.table.partitionKeys).toEqual(["ts"]);
      const rekeyed = yield* getTable(...where, replaced.table.tableName);
      expect(
        rekeyed.properties?.resource?.schema?.partitionKeys?.map((k) => k.name),
      ).toEqual(["ts"]);
      expect(yield* waitGone(getTable(...where, table.tableName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(getTable(...where, replaced.table.tableName), 60),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:cosmosdb", "live"],
    timeout: 900_000,
  },
);
