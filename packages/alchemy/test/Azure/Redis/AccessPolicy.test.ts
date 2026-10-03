import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as redis from "@distilled.cloud/azure/redis";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (
  resourceGroupName: string,
  cacheName: string,
  accessPolicyName: string,
) =>
  Effect.gen(function* () {
    return yield* redis.GetAccessPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      cacheName,
      accessPolicyName,
    });
  });

const program = (props: { name?: string; permissions: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const cache = yield* Azure.Redis.Cache("Cache", {
      resourceGroup: group.resourceGroupName,
      sku: "Basic",
      capacity: 0,
      redisConfiguration: { aadEnabled: true },
    });
    const policy = yield* Azure.Redis.AccessPolicy("Policy", {
      resourceGroup: group.resourceGroupName,
      cache: cache.cacheName,
      name: props.name,
      permissions: props.permissions,
    });
    return { group, cache, policy };
  });

// Needs a Basic C0 cache (~$0.02/hour): cents per run, but 15-20 minutes
// to provision the cache.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a redis access policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cache, policy } = yield* stack.deploy(
        program({ permissions: "+@read +@connection ~*" }),
      );
      expect(policy.type).toEqual("Custom");
      const observed = yield* getPolicy(
        group.resourceGroupName,
        cache.cacheName,
        policy.accessPolicyName,
      );
      expect(observed.properties?.permissions).toEqual("+@read +@connection ~*");
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      // In-place: change the ACL rules.
      const updated = yield* stack.deploy(
        program({ permissions: "+@read +@write +@connection ~app:*" }),
      );
      expect(updated.policy.accessPolicyId).toEqual(policy.accessPolicyId);
      const reobserved = yield* getPolicy(
        group.resourceGroupName,
        cache.cacheName,
        policy.accessPolicyName,
      );
      expect(reobserved.properties?.permissions).toEqual(
        "+@read +@write +@connection ~app:*",
      );

      // Replace: rename the policy.
      const renamed = yield* stack.deploy(
        program({
          name: "appwriter",
          permissions: "+@read +@write +@connection ~app:*",
        }),
      );
      expect(renamed.policy.accessPolicyName).toEqual("appwriter");
      expect(
        yield* waitGone(
          getPolicy(
            group.resourceGroupName,
            cache.cacheName,
            policy.accessPolicyName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getPolicy(group.resourceGroupName, cache.cacheName, "appwriter"),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);
