import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as relationships from "@distilled.cloud/azure/relationships";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (target: "Database" | "Cache") =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const app = yield* Azure.ManagedIdentity.UserAssignedIdentity("App", {
      resourceGroup: group.resourceGroupName,
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
    const dependency = yield* Azure.Relationships.DependencyOf("AppNeeds", {
      resourceId: app.identityId,
      targetId: targetIdentity.identityId,
    });
    return { app, database, cache, dependency };
  });

const sameId = (a: string | undefined, b: string) =>
  a?.toLowerCase() === b.toLowerCase();

// Free (relationships and user-assigned identities cost nothing), ~1 minute.
test.provider(
  "create, replace, and delete a dependencyOf relationship",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { app, database, dependency } = yield* stack.deploy(
        program("Database"),
      );
      const get = (name: string) =>
        relationships.GetDependencyOfRelationship({
          resourceUri: app.identityId,
          name,
        });

      expect(sameId(dependency.sourceId, app.identityId)).toBe(true);
      expect(sameId(dependency.targetId, database.identityId)).toBe(true);
      expect(dependency.provisioningState).toEqual("Succeeded");
      expect(dependency.originType).toEqual("UserExplicitlyCreated");
      expect(dependency.targetType).toEqual(
        "Microsoft.ManagedIdentity/userAssignedIdentities",
      );
      const observed = yield* get(dependency.relationshipName);
      expect(sameId(observed.properties?.targetId, database.identityId)).toBe(
        true,
      );

      // Re-deploying the same props is a no-op on the same relationship.
      const again = yield* stack.deploy(program("Database"));
      expect(again.dependency.relationshipId).toEqual(
        dependency.relationshipId,
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

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.dependency.relationshipName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
