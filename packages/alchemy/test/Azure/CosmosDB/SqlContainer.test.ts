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

const getContainer = (
  resourceGroupName: string,
  accountName: string,
  databaseName: string,
  containerName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetSqlResourceSqlContainer({
      subscriptionId,
      resourceGroupName,
      accountName,
      databaseName,
      containerName,
    }),
  );

const program = (props: {
  partitionKeyPath: string;
  defaultTtl?: number;
  indexingPolicy?: Azure.CosmosDB.IndexingPolicy;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: COSMOS_LOCATION,
    });
    const account = yield* Azure.CosmosDB.DatabaseAccount("Account", {
      resourceGroup: group.resourceGroupName,
      location: COSMOS_LOCATION,
      capabilities: ["EnableServerless"],
    });
    const database = yield* Azure.CosmosDB.SqlDatabase("Database", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
    });
    const container = yield* Azure.CosmosDB.SqlContainer("Orders", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      database: database.databaseName,
      partitionKey: { paths: [props.partitionKeyPath] },
      defaultTtl: props.defaultTtl,
      indexingPolicy: props.indexingPolicy,
    });
    return { group, account, database, container };
  });

// Serverless account: no cost while idle; the account dominates the
// runtime (~5-15 min create + delete).
test.provider(
  "create, update, replace, and delete a Cosmos DB SQL container",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, database, container } = yield* stack.deploy(
        program({ partitionKeyPath: "/pk" }),
      );
      expect(container.partitionKeyPaths).toEqual(["/pk"]);
      expect(container.partitionKeyKind).toEqual("Hash");
      expect(container.defaultTtl).toBeUndefined();
      const observed = yield* getContainer(
        group.resourceGroupName,
        account.accountName,
        database.databaseName,
        container.containerName,
      );
      expect(observed.properties?.resource?.partitionKey?.paths).toEqual([
        "/pk",
      ]);
      expect(observed.properties?.resource?.partitionKey?.version).toEqual(2);

      // In-place update: TTL and indexing policy.
      const updated = yield* stack.deploy(
        program({
          partitionKeyPath: "/pk",
          defaultTtl: 3600,
          indexingPolicy: {
            indexingMode: "consistent",
            includedPaths: [{ path: "/pk/?" }],
            excludedPaths: [{ path: "/*" }],
          },
        }),
      );
      expect(updated.container.containerName).toEqual(container.containerName);
      expect(updated.container.defaultTtl).toEqual(3600);
      const reobserved = yield* getContainer(
        group.resourceGroupName,
        account.accountName,
        database.databaseName,
        container.containerName,
      );
      expect(reobserved.properties?.resource?.defaultTtl).toEqual(3600);
      expect(
        reobserved.properties?.resource?.indexingPolicy?.includedPaths?.map(
          (p) => p.path,
        ),
      ).toEqual(["/pk/?"]);

      // Replacement: a new partition key path recreates the container.
      const replaced = yield* stack.deploy(
        program({ partitionKeyPath: "/tenantId" }),
      );
      expect(replaced.container.partitionKeyPaths).toEqual(["/tenantId"]);
      expect(replaced.container.rid).not.toEqual(container.rid);
      const recreated = yield* getContainer(
        group.resourceGroupName,
        account.accountName,
        database.databaseName,
        replaced.container.containerName,
      );
      expect(recreated.properties?.resource?.partitionKey?.paths).toEqual([
        "/tenantId",
      ]);
      if (replaced.container.containerName !== container.containerName) {
        expect(
          yield* waitGone(
            getContainer(
              group.resourceGroupName,
              account.accountName,
              database.databaseName,
              container.containerName,
            ),
          ),
        ).toEqual("gone");
      }

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getContainer(
            group.resourceGroupName,
            account.accountName,
            database.databaseName,
            replaced.container.containerName,
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
