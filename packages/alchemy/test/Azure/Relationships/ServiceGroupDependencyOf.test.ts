import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as relationships from "@distilled.cloud/azure/relationships";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (target: "Database" | "Cache") =>
  Effect.gen(function* () {
    const serviceGroup = yield* Azure.Management.ServiceGroup("Workload", {
      displayName: "Relationships test workload",
    });
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Both targets stay deployed across the replacement step.
    const database = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "Database",
      { resourceGroup: group.resourceGroupName },
    );
    const cache = yield* Azure.ManagedIdentity.UserAssignedIdentity("Cache", {
      resourceGroup: group.resourceGroupName,
    });
    const targetIdentity = target === "Database" ? database : cache;
    const dependency = yield* Azure.Relationships.ServiceGroupDependencyOf(
      "WorkloadNeeds",
      {
        serviceGroup: serviceGroup.serviceGroupName,
        targetId: targetIdentity.identityId,
      },
    );
    return { serviceGroup, database, cache, dependency };
  });

const sameId = (a: string | undefined, b: string) =>
  a?.toLowerCase() === b.toLowerCase();

// Free (service groups, relationships and identities cost nothing), a few
// minutes (service group writes are slow to propagate).
test.provider(
  "create, replace, and delete a service group dependencyOf relationship",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { serviceGroup, database, dependency } = yield* stack.deploy(
        program("Database"),
      );
      const get = (name: string) =>
        relationships.GetDependencyOfRelationshipsByServiceGroup({
          serviceGroupName: serviceGroup.serviceGroupName,
          name,
        });

      expect(dependency.serviceGroupName).toEqual(
        serviceGroup.serviceGroupName,
      );
      expect(sameId(dependency.targetId, database.identityId)).toBe(true);
      expect(dependency.provisioningState).toEqual("Succeeded");
      const observed = yield* get(dependency.relationshipName);
      expect(sameId(observed.properties?.targetId, database.identityId)).toBe(
        true,
      );

      // Replacement: the target is the relationship's identity.
      const replaced = yield* stack.deploy(program("Cache"));
      expect(replaced.dependency.relationshipName).not.toEqual(
        dependency.relationshipName,
      );
      const replacedObserved = yield* get(replaced.dependency.relationshipName);
      expect(
        sameId(replacedObserved.properties?.targetId, replaced.cache.identityId),
      ).toBe(true);
      expect(yield* waitGone(get(dependency.relationshipName))).toEqual("gone");

      const relationshipName = replaced.dependency.relationshipName;
      yield* stack.destroy();
      expect(yield* waitGone(get(relationshipName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
