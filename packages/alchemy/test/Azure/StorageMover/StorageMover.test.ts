import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storagemover from "@distilled.cloud/azure/storagemover";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getMover = (resourceGroupName: string, storageMoverName: string) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    storagemover.GetStorageMover({
      subscriptionId,
      resourceGroupName,
      storageMoverName,
    }),
  );

const program = (props: {
  location: string;
  description: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const mover = yield* Azure.StorageMover.StorageMover("Mover", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      description: props.description,
      tags: props.tags,
    });
    return { group, mover };
  });

// Storage Movers are free; the lifecycle takes about a minute.
test.provider(
  "create, update, replace, and delete a storage mover",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, mover } = yield* stack.deploy(
        program({
          location: "eastus",
          description: "first",
          tags: { env: "test" },
        }),
      );
      expect(mover.description).toEqual("first");
      const observed = yield* getMover(
        group.resourceGroupName,
        mover.storageMoverName,
      );
      expect(observed.properties?.description).toEqual("first");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Mover");

      // In-place: description and tags.
      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          description: "second",
          tags: { env: "prod" },
        }),
      );
      expect(updated.mover.storageMoverId).toEqual(mover.storageMoverId);
      const reobserved = yield* getMover(
        group.resourceGroupName,
        mover.storageMoverName,
      );
      expect(reobserved.properties?.description).toEqual("second");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the location is immutable.
      const replaced = yield* stack.deploy(
        program({
          location: "westus3",
          description: "second",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.mover.storageMoverName).not.toEqual(
        mover.storageMoverName,
      );
      expect(replaced.mover.location).toEqual("westus3");
      expect(
        yield* waitGone(
          getMover(group.resourceGroupName, mover.storageMoverName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getMover(group.resourceGroupName, replaced.mover.storageMoverName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
