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

const getCollection = (
  resourceGroupName: string,
  accountName: string,
  databaseName: string,
  collectionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetMongoDBResourceMongoDBCollection({
      subscriptionId,
      resourceGroupName,
      accountName,
      databaseName,
      collectionName,
    }),
  );

const indexKeys = (
  collection: cosmos.GetMongoDBResourceMongoDBCollectionResponse,
) =>
  (collection.properties?.resource?.indexes ?? [])
    .map((index) => (index.key?.keys ?? []).join(","))
    .sort();

const program = (props: {
  shardKey: string;
  indexes: Azure.CosmosDB.MongoCollectionIndex[];
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: COSMOS_LOCATION,
    });
    const account = yield* Azure.CosmosDB.DatabaseAccount("Account", {
      resourceGroup: group.resourceGroupName,
      location: COSMOS_LOCATION,
      kind: "MongoDB",
      capabilities: ["EnableServerless", "EnableMongo"],
      serverVersion: "4.2",
    });
    const database = yield* Azure.CosmosDB.MongoDatabase("Database", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
    });
    const collection = yield* Azure.CosmosDB.MongoCollection("Users", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      database: database.databaseName,
      shardKey: props.shardKey,
      indexes: props.indexes,
    });
    return { group, account, database, collection };
  });

// Serverless MongoDB account: no cost while idle; the account dominates the
// runtime (~5-15 min create + delete).
test.provider(
  "create, update, replace, and delete a Cosmos DB MongoDB collection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, database, collection } = yield* stack.deploy(
        program({
          shardKey: "tenantId",
          indexes: [{ keys: ["email"] }],
        }),
      );
      expect(collection.shardKey).toEqual("tenantId");
      const observed = yield* getCollection(
        group.resourceGroupName,
        account.accountName,
        database.databaseName,
        collection.collectionName,
      );
      expect(observed.properties?.resource?.shardKey).toEqual({
        tenantId: "Hash",
      });
      expect(indexKeys(observed)).toEqual(["_id", "email"]);

      // In-place update: indexes.
      const updated = yield* stack.deploy(
        program({
          shardKey: "tenantId",
          indexes: [{ keys: ["email"] }, { keys: ["createdAt"] }],
        }),
      );
      expect(updated.collection.collectionName).toEqual(
        collection.collectionName,
      );
      const reobserved = yield* getCollection(
        group.resourceGroupName,
        account.accountName,
        database.databaseName,
        collection.collectionName,
      );
      expect(indexKeys(reobserved)).toEqual(["_id", "createdAt", "email"]);

      // Replacement: a new shard key recreates the collection.
      const replaced = yield* stack.deploy(
        program({
          shardKey: "userId",
          indexes: [{ keys: ["email"] }],
        }),
      );
      expect(replaced.collection.shardKey).toEqual("userId");
      expect(replaced.collection.collectionName).not.toEqual(
        collection.collectionName,
      );
      expect(
        yield* waitGone(
          getCollection(
            group.resourceGroupName,
            account.accountName,
            database.databaseName,
            collection.collectionName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getCollection(
            group.resourceGroupName,
            account.accountName,
            database.databaseName,
            replaced.collection.collectionName,
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
