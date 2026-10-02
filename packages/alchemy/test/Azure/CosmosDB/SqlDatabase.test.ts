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

const getDatabase = (
  resourceGroupName: string,
  accountName: string,
  databaseName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetSqlResourceSqlDatabase({
      subscriptionId,
      resourceGroupName,
      accountName,
      databaseName,
    }),
  );

const getThroughput = (
  resourceGroupName: string,
  accountName: string,
  databaseName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetSqlResourceSqlDatabaseThroughput({
      subscriptionId,
      resourceGroupName,
      accountName,
      databaseName,
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
    });
    const database = yield* Azure.CosmosDB.SqlDatabase("Database", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      name: props.name,
      throughput: props.throughput,
    });
    return { group, account, database };
  });

// Provisioned account with 400-500 RU/s on one resource for ~15 min
// (~$0.01); the account itself is free and dominates the runtime
// (~5-15 min create + delete).
test.provider(
  "create, update, replace, and delete a Cosmos DB SQL database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, database } = yield* stack.deploy(
        program({ throughput: 400 }),
      );
      expect(database.account).toEqual(account.accountName);
      expect(database.throughput).toEqual(400);
      const observed = yield* getDatabase(
        group.resourceGroupName,
        account.accountName,
        database.databaseName,
      );
      expect(observed.properties?.resource?.id).toEqual(database.databaseName);
      const throughput = yield* getThroughput(
        group.resourceGroupName,
        account.accountName,
        database.databaseName,
      );
      expect(throughput.properties?.resource?.throughput).toEqual(400);

      // In-place update: shared throughput.
      const updated = yield* stack.deploy(program({ throughput: 500 }));
      expect(updated.database.databaseName).toEqual(database.databaseName);
      expect(updated.database.throughput).toEqual(500);
      const rethroughput = yield* getThroughput(
        group.resourceGroupName,
        account.accountName,
        database.databaseName,
      );
      expect(rethroughput.properties?.resource?.throughput).toEqual(500);

      // Replacement: a new name creates a new database and deletes the old.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-renamed", throughput: 500 }),
      );
      expect(replaced.database.databaseName).toEqual("alchemy-renamed");
      const renamed = yield* getDatabase(
        group.resourceGroupName,
        account.accountName,
        "alchemy-renamed",
      );
      expect(renamed.properties?.resource?.id).toEqual("alchemy-renamed");
      expect(
        yield* waitGone(
          getDatabase(
            group.resourceGroupName,
            account.accountName,
            database.databaseName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getDatabase(
            group.resourceGroupName,
            account.accountName,
            "alchemy-renamed",
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
