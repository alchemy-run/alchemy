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
  tableName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetTableResourceTable({
      subscriptionId,
      resourceGroupName,
      accountName,
      tableName,
    }),
  );

const getThroughput = (
  resourceGroupName: string,
  accountName: string,
  tableName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetTableResourceTableThroughput({
      subscriptionId,
      resourceGroupName,
      accountName,
      tableName,
    }),
  );

const program = (props: { name?: string; throughput: number }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: COSMOS_LOCATION,
    });
    const account = yield* Azure.CosmosDB.DatabaseAccount("Account", {
      resourceGroup: group.resourceGroupName,
      location: COSMOS_LOCATION,
      capabilities: ["EnableTable"],
    });
    const table = yield* Azure.CosmosDB.Table("Sessions", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      name: props.name,
      throughput: props.throughput,
    });
    return { group, account, table };
  });

// Provisioned account with 400-500 RU/s on one resource for ~15 min
// (~$0.01); the account itself is free and dominates the runtime
// (~5-15 min create + delete).
test.provider(
  "create, update, replace, and delete a Cosmos DB table",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, table } = yield* stack.deploy(
        program({ throughput: 400 }),
      );
      expect(table.tableName).toMatch(/^[A-Za-z][A-Za-z0-9]{2,62}$/);
      expect(account.capabilities).toContain("EnableTable");
      const observed = yield* getTable(
        group.resourceGroupName,
        account.accountName,
        table.tableName,
      );
      expect(observed.properties?.resource?.id).toEqual(table.tableName);
      expect(table.throughput).toEqual(400);
      const throughput = yield* getThroughput(
        group.resourceGroupName,
        account.accountName,
        table.tableName,
      );
      expect(throughput.properties?.resource?.throughput).toEqual(400);

      // In-place update: dedicated throughput.
      const updated = yield* stack.deploy(program({ throughput: 500 }));
      expect(updated.table.tableName).toEqual(table.tableName);
      expect(updated.table.throughput).toEqual(500);
      const rethroughput = yield* getThroughput(
        group.resourceGroupName,
        account.accountName,
        table.tableName,
      );
      expect(rethroughput.properties?.resource?.throughput).toEqual(500);

      // Replacement: a new name creates a new table and deletes the old.
      const replaced = yield* stack.deploy(
        program({ name: "AlchemyRenamed", throughput: 500 }),
      );
      expect(replaced.table.tableName).toEqual("AlchemyRenamed");
      expect(
        yield* waitGone(
          getTable(group.resourceGroupName, account.accountName, table.tableName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getTable(
            group.resourceGroupName,
            account.accountName,
            "AlchemyRenamed",
          ),
          60,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:cosmosdb", "live"],
    timeout: 1_500_000,
  },
);
