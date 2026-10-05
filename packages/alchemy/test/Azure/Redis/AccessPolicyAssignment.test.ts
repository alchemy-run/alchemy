import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as redisenterprise from "@distilled.cloud/azure/redisenterprise";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAssignment = (
  resourceGroupName: string,
  clusterName: string,
  accessPolicyAssignmentName: string,
) =>
  Effect.gen(function* () {
    return yield* redisenterprise.GetAccessPolicyAssignment({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      databaseName: "default",
      accessPolicyAssignmentName,
    });
  });

const program = (props: { principal: "Reader" | "Writer" }) =>
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
    const redis = yield* Azure.Redis.ManagedRedis("Cache", {
      resourceGroup: group.resourceGroupName,
      sku: "Balanced_B0",
      highAvailability: "Disabled",
    });
    const database = yield* Azure.Redis.ManagedRedisDatabase("Database", {
      resourceGroup: group.resourceGroupName,
      cluster: redis.clusterName,
    });
    const identity = props.principal === "Reader" ? reader : writer;
    const assignment = yield* Azure.Redis.AccessPolicyAssignment("Access", {
      resourceGroup: group.resourceGroupName,
      cluster: redis.clusterName,
      database: database.databaseName,
      objectId: identity.principalId,
    });
    return { group, redis, identity, assignment };
  });

// Balanced_B0 without HA (~$0.02/hour): a few cents per run. The cluster
// takes ~7 minutes to create; the whole lifecycle runs ~12 minutes.
test.provider(
  "create, replace, and delete a redis access policy assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, redis, identity, assignment } = yield* stack.deploy(
        program({ principal: "Reader" }),
      );
      const get = (name: string) =>
        getAssignment(group.resourceGroupName, redis.clusterName, name);
      expect(assignment.objectId).toEqual(identity.principalId);
      expect(assignment.accessPolicyName).toEqual("default");
      const observed = yield* get(assignment.accessPolicyAssignmentName);
      expect(observed.properties?.user.objectId).toEqual(identity.principalId);
      expect(observed.properties?.accessPolicyName).toEqual("default");

      // Replacement: the principal is immutable.
      const replaced = yield* stack.deploy(program({ principal: "Writer" }));
      expect(replaced.assignment.objectId).toEqual(
        replaced.identity.principalId,
      );
      expect(replaced.assignment.accessPolicyAssignmentName).not.toEqual(
        assignment.accessPolicyAssignmentName,
      );
      const replacedObserved = yield* get(
        replaced.assignment.accessPolicyAssignmentName,
      );
      expect(replacedObserved.properties?.user.objectId).toEqual(
        replaced.identity.principalId,
      );
      expect(
        yield* waitGone(get(assignment.accessPolicyAssignmentName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.assignment.accessPolicyAssignmentName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
