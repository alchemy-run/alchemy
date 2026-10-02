import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as redisenterprise from "@distilled.cloud/azure/redisenterprise";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCluster = (resourceGroupName: string, clusterName: string) =>
  Effect.gen(function* () {
    return yield* redisenterprise.GetRedisEnterprise({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
    });
  });

const program = (props: { tags: Record<string, string>; location?: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const redis = yield* Azure.Redis.ManagedRedis("Cache", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      sku: "Balanced_B0",
      highAvailability: "Disabled",
      tags: props.tags,
    });
    return { group, redis };
  });

// Balanced_B0 without HA (~$0.02/hour): a few cents per run, 5-10 minutes
// to provision.
test.provider(
  "create, update, and delete a managed redis cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, redis } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(redis.hostName).toContain(redis.clusterName);
      expect(redis.resourceState).toEqual("Running");
      const observed = yield* getCluster(
        group.resourceGroupName,
        redis.clusterName,
      );
      expect(observed.sku.name).toEqual("Balanced_B0");
      expect(observed.properties?.highAvailability).toEqual("Disabled");
      expect(observed.properties?.resourceState).toEqual("Running");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Cache");

      // In-place: tags.
      const updated = yield* stack.deploy(
        program({ tags: { env: "prod", team: "cache" } }),
      );
      expect(updated.redis.clusterId).toEqual(redis.clusterId);
      expect(updated.redis.tags).toEqual({ env: "prod", team: "cache" });
      const reobserved = yield* getCluster(
        group.resourceGroupName,
        redis.clusterName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.tags?.team).toEqual("cache");

      yield* stack.destroy();
      expect(
        yield* waitGone(getCluster(group.resourceGroupName, redis.clusterName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Replacement provisions a second Balanced_B0 cluster: a few cents, but
// 15-20 minutes end to end.
test.provider.skipIf(!runExpensive)(
  "replace a managed redis cluster when its location changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, redis } = yield* stack.deploy(
        program({ tags: {}, location: "eastus" }),
      );
      const replaced = yield* stack.deploy(
        program({ tags: {}, location: "westus2" }),
      );
      expect(replaced.redis.location).toEqual("westus2");
      expect(redis.location).toEqual("eastus");
      expect(replaced.redis.clusterId).not.toEqual(redis.clusterId);
      expect(
        yield* waitGone(getCluster(group.resourceGroupName, redis.clusterName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getCluster(group.resourceGroupName, replaced.redis.clusterName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);
