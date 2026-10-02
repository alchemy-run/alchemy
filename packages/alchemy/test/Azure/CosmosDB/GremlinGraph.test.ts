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

const getGraph = (
  resourceGroupName: string,
  accountName: string,
  databaseName: string,
  graphName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetGremlinResourceGremlinGraph({
      subscriptionId,
      resourceGroupName,
      accountName,
      databaseName,
      graphName,
    }),
  );

const program = (props: { partitionKeyPath: string; defaultTtl?: number }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: COSMOS_LOCATION,
    });
    const account = yield* Azure.CosmosDB.DatabaseAccount("Account", {
      resourceGroup: group.resourceGroupName,
      location: COSMOS_LOCATION,
      capabilities: ["EnableServerless", "EnableGremlin"],
    });
    const database = yield* Azure.CosmosDB.GremlinDatabase("Database", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
    });
    const graph = yield* Azure.CosmosDB.GremlinGraph("Social", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      database: database.databaseName,
      partitionKey: { paths: [props.partitionKeyPath] },
      defaultTtl: props.defaultTtl,
    });
    return { group, account, database, graph };
  });

// Serverless Gremlin account: no cost while idle; the account dominates
// the runtime (~2-15 min create + delete).
test.provider(
  "create, update, replace, and delete a Cosmos DB Gremlin graph",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, database, graph } = yield* stack.deploy(
        program({ partitionKeyPath: "/tenant" }),
      );
      const where = [
        group.resourceGroupName,
        account.accountName,
        database.databaseName,
      ] as const;
      expect(graph.partitionKeyPaths).toEqual(["/tenant"]);
      expect(graph.defaultTtl).toBeUndefined();
      const observed = yield* getGraph(...where, graph.graphName);
      expect(observed.properties?.resource?.partitionKey?.paths).toEqual([
        "/tenant",
      ]);

      // In-place update: default TTL.
      const updated = yield* stack.deploy(
        program({ partitionKeyPath: "/tenant", defaultTtl: 3600 }),
      );
      expect(updated.graph.graphId).toEqual(graph.graphId);
      expect(updated.graph.defaultTtl).toEqual(3600);
      const reobserved = yield* getGraph(...where, graph.graphName);
      expect(reobserved.properties?.resource?.defaultTtl).toEqual(3600);

      // Replacement: a new partition key creates a new graph and deletes
      // the old one.
      const replaced = yield* stack.deploy(
        program({ partitionKeyPath: "/region", defaultTtl: 3600 }),
      );
      expect(replaced.graph.partitionKeyPaths).toEqual(["/region"]);
      expect(replaced.graph.graphName).not.toEqual(graph.graphName);
      const rekeyed = yield* getGraph(...where, replaced.graph.graphName);
      expect(rekeyed.properties?.resource?.partitionKey?.paths).toEqual([
        "/region",
      ]);
      expect(yield* waitGone(getGraph(...where, graph.graphName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(getGraph(...where, replaced.graph.graphName), 60),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:cosmosdb", "live"],
    timeout: 900_000,
  },
);
