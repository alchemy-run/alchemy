import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as resourcemover from "@distilled.cloud/azure/resourcemover";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCollection = (resourceGroupName: string, moveCollectionName: string) =>
  Effect.gen(function* () {
    return yield* resourcemover.GetMoveCollection({
      subscriptionId: yield* subscription,
      resourceGroupName,
      moveCollectionName,
    });
  });

const program = (props: {
  targetRegion: string;
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus2",
    });
    const collection = yield* Azure.ResourceMover.MoveCollection("Moves", {
      resourceGroup: group.resourceGroupName,
      location: "eastus2",
      sourceRegion: "eastus",
      targetRegion: props.targetRegion,
      tags: props.tags,
    });
    return { group, collection };
  });

// Move collections are free and provision in seconds.
test.provider(
  "create, update, replace, and delete a move collection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, collection } = yield* stack.deploy(
        program({ targetRegion: "westus2", tags: { env: "test" } }),
      );
      const get = (name: string) =>
        getCollection(group.resourceGroupName, name);
      expect(collection.moveType).toEqual("RegionToRegion");
      expect(collection.identityType).toEqual("SystemAssigned");
      expect(collection.principalId).not.toEqual("");
      const observed = yield* get(collection.moveCollectionName);
      expect(observed.properties?.sourceRegion).toEqual("eastus");
      expect(observed.properties?.targetRegion).toEqual("westus2");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Moves");

      // In-place: change the tags.
      const updated = yield* stack.deploy(
        program({ targetRegion: "westus2", tags: { env: "prod" } }),
      );
      expect(updated.collection.moveCollectionId).toEqual(
        collection.moveCollectionId,
      );
      expect(updated.collection.tags).toEqual({ env: "prod" });
      const reobserved = yield* get(collection.moveCollectionName);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the target region is immutable.
      const replaced = yield* stack.deploy(
        program({ targetRegion: "centralus", tags: { env: "prod" } }),
      );
      expect(replaced.collection.moveCollectionName).not.toEqual(
        collection.moveCollectionName,
      );
      const replacedObserved = yield* get(
        replaced.collection.moveCollectionName,
      );
      expect(replacedObserved.properties?.targetRegion).toEqual("centralus");
      expect(yield* waitGone(get(collection.moveCollectionName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.collection.moveCollectionName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
