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

const getKeyspace = (
  resourceGroupName: string,
  accountName: string,
  keyspaceName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetCassandraResourceCassandraKeyspace({
      subscriptionId,
      resourceGroupName,
      accountName,
      keyspaceName,
    }),
  );

const getThroughput = (
  resourceGroupName: string,
  accountName: string,
  keyspaceName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetCassandraResourceCassandraKeyspaceThroughput({
      subscriptionId,
      resourceGroupName,
      accountName,
      keyspaceName,
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
      capabilities: ["EnableCassandra"],
    });
    const keyspace = yield* Azure.CosmosDB.CassandraKeyspace("Keyspace", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      name: props.name,
      throughput: props.throughput,
    });
    return { group, account, keyspace };
  });

// Provisioned account with 400-500 RU/s on one resource for ~15 min
// (~$0.01); the account itself is free and dominates the runtime
// (~5-15 min create + delete).
test.provider(
  "create, update, replace, and delete a Cosmos DB Cassandra keyspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, keyspace } = yield* stack.deploy(
        program({ throughput: 400 }),
      );
      expect(keyspace.keyspaceName).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,47}$/);
      expect(keyspace.account).toEqual(account.accountName);
      expect(keyspace.throughput).toEqual(400);
      const observed = yield* getKeyspace(
        group.resourceGroupName,
        account.accountName,
        keyspace.keyspaceName,
      );
      expect(observed.properties?.resource?.id).toEqual(keyspace.keyspaceName);
      const throughput = yield* getThroughput(
        group.resourceGroupName,
        account.accountName,
        keyspace.keyspaceName,
      );
      expect(throughput.properties?.resource?.throughput).toEqual(400);

      // In-place update: shared throughput.
      const updated = yield* stack.deploy(program({ throughput: 500 }));
      expect(updated.keyspace.keyspaceName).toEqual(keyspace.keyspaceName);
      expect(updated.keyspace.throughput).toEqual(500);
      const rethroughput = yield* getThroughput(
        group.resourceGroupName,
        account.accountName,
        keyspace.keyspaceName,
      );
      expect(rethroughput.properties?.resource?.throughput).toEqual(500);

      // Replacement: a new name creates a new keyspace and deletes the old.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy_renamed", throughput: 500 }),
      );
      expect(replaced.keyspace.keyspaceName).toEqual("alchemy_renamed");
      const renamed = yield* getKeyspace(
        group.resourceGroupName,
        account.accountName,
        "alchemy_renamed",
      );
      expect(renamed.properties?.resource?.id).toEqual("alchemy_renamed");
      expect(
        yield* waitGone(
          getKeyspace(
            group.resourceGroupName,
            account.accountName,
            keyspace.keyspaceName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getKeyspace(
            group.resourceGroupName,
            account.accountName,
            "alchemy_renamed",
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
