import * as Azure from "@alchemy.run/azure";
import * as redis from "@distilled.cloud/azure/redis";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAssignment = (
  resourceGroupName: string,
  cacheName: string,
  accessPolicyAssignmentName: string,
) =>
  Effect.gen(function* () {
    return yield* redis.GetAccessPolicyAssignment({
      subscriptionId: yield* subscription,
      resourceGroupName,
      cacheName,
      accessPolicyAssignmentName,
    });
  });

const program = (props: { principal: "Reader" | "Writer"; accessPolicyName: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Both identities stay deployed across the replacement step.
    const reader = yield* Azure.ManagedIdentity.UserAssignedIdentity("Reader", {
      resourceGroup: group.resourceGroupName,
    });
    const writer = yield* Azure.ManagedIdentity.UserAssignedIdentity("Writer", {
      resourceGroup: group.resourceGroupName,
    });
    const cache = yield* Azure.Redis.Cache("Cache", {
      resourceGroup: group.resourceGroupName,
      sku: "Basic",
      capacity: 0,
      redisConfiguration: { aadEnabled: true },
    });
    const identity = props.principal === "Reader" ? reader : writer;
    const assignment = yield* Azure.Redis.CacheAccessPolicyAssignment("Access", {
      resourceGroup: group.resourceGroupName,
      cache: cache.cacheName,
      accessPolicyName: props.accessPolicyName,
      objectId: identity.principalId,
    });
    return { group, cache, identity, assignment };
  });

// ~$0.10/run, 25 min: a Basic C0 cache (~$0.02/hour) takes 15-20 minutes
// to provision, and each assignment change updates the cache.
test.provider.skipIf(!runExpensive)(
  "create, replace, and delete a redis cache access policy assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cache, identity, assignment } = yield* stack.deploy(
        program({ principal: "Reader", accessPolicyName: "Data Reader" }),
      );
      const get = (name: string) => getAssignment(group.resourceGroupName, cache.cacheName, name);
      expect(assignment.objectId).toEqual(identity.principalId);
      expect(assignment.objectIdAlias).toEqual(identity.principalId);
      expect(assignment.accessPolicyName).toEqual("Data Reader");
      const observed = yield* get(assignment.accessPolicyAssignmentName);
      expect(observed.properties?.objectId).toEqual(identity.principalId);
      expect(observed.properties?.accessPolicyName).toEqual("Data Reader");
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      // Replacement: the principal and policy are immutable.
      const replaced = yield* stack.deploy(
        program({ principal: "Writer", accessPolicyName: "Data Contributor" }),
      );
      expect(replaced.assignment.objectId).toEqual(replaced.identity.principalId);
      expect(replaced.assignment.accessPolicyAssignmentName).not.toEqual(
        assignment.accessPolicyAssignmentName,
      );
      const replacedObserved = yield* get(replaced.assignment.accessPolicyAssignmentName);
      expect(replacedObserved.properties?.objectId).toEqual(replaced.identity.principalId);
      expect(replacedObserved.properties?.accessPolicyName).toEqual("Data Contributor");
      expect(yield* waitGone(get(assignment.accessPolicyAssignmentName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.assignment.accessPolicyAssignmentName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);
