import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as redisenterprise from "@distilled.cloud/azure/redisenterprise";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDatabase = (resourceGroupName: string, clusterName: string) =>
  Effect.gen(function* () {
    return yield* redisenterprise.GetDatabase({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      databaseName: "default",
    });
  });

const program = (props: {
  evictionPolicy: Azure.Redis.ManagedRedisEvictionPolicy;
  accessKeysAuthentication: "Enabled" | "Disabled";
  clusteringPolicy?: Azure.Redis.ManagedRedisClusteringPolicy;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const redis = yield* Azure.Redis.ManagedRedis("Cache", {
      resourceGroup: group.resourceGroupName,
      sku: "Balanced_B0",
      highAvailability: "Disabled",
    });
    const database = yield* Azure.Redis.ManagedRedisDatabase("Database", {
      resourceGroup: group.resourceGroupName,
      cluster: redis.clusterName,
      ...props,
    });
    return { group, redis, database };
  });

// Balanced_B0 without HA (~$0.02/hour): a few cents per run. The cluster
// takes ~7 minutes to create; the whole lifecycle runs ~12 minutes.
test.provider(
  "create, update, replace, and delete a managed redis database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, redis, database } = yield* stack.deploy(
        program({
          evictionPolicy: "NoEviction",
          accessKeysAuthentication: "Enabled",
        }),
      );
      const get = () => getDatabase(group.resourceGroupName, redis.clusterName);
      expect(database.databaseName).toEqual("default");
      expect(database.hostName).toEqual(redis.hostName);
      expect(database.port).toEqual(10000);
      expect(database.primaryKey).toBeDefined();
      expect(Redacted.value(database.primaryKey!).length).toBeGreaterThan(0);
      const observed = yield* get();
      expect(observed.properties?.evictionPolicy).toEqual("NoEviction");
      expect(observed.properties?.accessKeysAuthentication).toEqual("Enabled");
      expect(observed.properties?.clusteringPolicy).toEqual("OSSCluster");

      // In-place: eviction policy and access-key authentication.
      const updated = yield* stack.deploy(
        program({
          evictionPolicy: "AllKeysLRU",
          accessKeysAuthentication: "Disabled",
        }),
      );
      expect(updated.database.databaseId).toEqual(database.databaseId);
      expect(updated.database.primaryKey).toBeUndefined();
      const reobserved = yield* get();
      expect(reobserved.properties?.evictionPolicy).toEqual("AllKeysLRU");
      expect(reobserved.properties?.accessKeysAuthentication).toEqual(
        "Disabled",
      );

      // Replacement: the clustering policy is create-only.
      const replaced = yield* stack.deploy(
        program({
          evictionPolicy: "AllKeysLRU",
          accessKeysAuthentication: "Disabled",
          clusteringPolicy: "EnterpriseCluster",
        }),
      );
      expect(replaced.database.clusteringPolicy).toEqual("EnterpriseCluster");
      const replacedObserved = yield* get();
      expect(replacedObserved.properties?.clusteringPolicy).toEqual(
        "EnterpriseCluster",
      );

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
