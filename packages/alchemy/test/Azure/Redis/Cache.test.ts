import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as redis from "@distilled.cloud/azure/redis";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCache = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    return yield* redis.GetRedis({
      subscriptionId: yield* subscription,
      resourceGroupName,
      name,
    });
  });

const program = (props: {
  tags: Record<string, string>;
  maxmemoryPolicy: string;
  name?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const cache = yield* Azure.Redis.Cache("Cache", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      sku: "Basic",
      capacity: 0,
      redisConfiguration: { maxmemoryPolicy: props.maxmemoryPolicy },
      tags: props.tags,
    });
    return { group, cache };
  });

// Basic C0 (~$0.02/hour): cents per run, but 15-20 minutes to provision
// and ~5 more per configuration update.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a redis cache",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cache } = yield* stack.deploy(
        program({ tags: { env: "test" }, maxmemoryPolicy: "volatile-lru" }),
      );
      expect(cache.hostName).toEqual(`${cache.cacheName}.redis.cache.windows.net`);
      expect(cache.sslPort).toEqual(6380);
      expect(cache.sku).toEqual("Basic");
      expect(cache.primaryKey).toBeDefined();
      expect(Redacted.value(cache.primaryConnectionString!)).toContain(
        `${cache.hostName}:6380,password=`,
      );
      const observed = yield* getCache(group.resourceGroupName, cache.cacheName);
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.sku).toEqual({
        name: "Basic",
        family: "C",
        capacity: 0,
      });
      expect(observed.properties.redisConfiguration?.maxmemory_policy).toEqual(
        "volatile-lru",
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Cache");

      // In-place: tags and a Redis setting.
      const updated = yield* stack.deploy(
        program({
          tags: { env: "prod", team: "cache" },
          maxmemoryPolicy: "allkeys-lru",
        }),
      );
      expect(updated.cache.cacheId).toEqual(cache.cacheId);
      expect(updated.cache.tags).toEqual({ env: "prod", team: "cache" });
      const reobserved = yield* getCache(
        group.resourceGroupName,
        cache.cacheName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.tags?.team).toEqual("cache");
      expect(
        reobserved.properties.redisConfiguration?.maxmemory_policy,
      ).toEqual("allkeys-lru");

      yield* stack.destroy();
      expect(
        yield* waitGone(getCache(group.resourceGroupName, cache.cacheName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);

// Replacement provisions a second Basic C0 cache: cents, but each create
// takes 25-30 minutes, so 60-70 minutes end to end. It stays in eastus:
// this subscription is refused new Azure Cache for Redis caches in most
// regions (`RedisCacheRetiring`).
test.provider.skipIf(!runExpensive)(
  "replace a redis cache when its name changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cache } = yield* stack.deploy(
        program({ tags: {}, maxmemoryPolicy: "volatile-lru" }),
      );
      const renamed = `${cache.cacheName.slice(0, 50)}-renamed`;
      const replaced = yield* stack.deploy(
        program({ tags: {}, maxmemoryPolicy: "volatile-lru", name: renamed }),
      );
      expect(replaced.cache.cacheName).toEqual(renamed);
      expect(replaced.cache.cacheId).not.toEqual(cache.cacheId);
      expect(
        (yield* getCache(group.resourceGroupName, renamed)).properties
          .provisioningState,
      ).toEqual("Succeeded");
      expect(
        yield* waitGone(getCache(group.resourceGroupName, cache.cacheName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(getCache(group.resourceGroupName, renamed)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 7_200_000 },
);
