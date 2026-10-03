import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storagesync from "@distilled.cloud/azure/storagesync";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getSyncGroup = (
  resourceGroupName: string,
  storageSyncServiceName: string,
  syncGroupName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storagesync.GetSyncGroup({
      subscriptionId,
      resourceGroupName,
      storageSyncServiceName,
      syncGroupName,
    });
  });

const syncGroupGone = (rg: string, service: string, name: string) =>
  getSyncGroup(rg, service, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const program = (syncGroupName?: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const sync = yield* Azure.StorageSync.StorageSyncService("Sync", {
      resourceGroup: group.resourceGroupName,
    });
    const syncGroup =
      syncGroupName === undefined
        ? undefined
        : yield* Azure.StorageSync.SyncGroup("Docs", {
            resourceGroup: group.resourceGroupName,
            storageSyncService: sync.storageSyncServiceName,
            name: syncGroupName === "" ? undefined : syncGroupName,
          });
    return { group, sync, syncGroup };
  });

// Storage Sync Service + sync groups are free; ~1-2 minutes.
test.provider(
  "create, replace, and delete a sync group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program(""));
      const rg = created.group.resourceGroupName;
      const service = created.sync.storageSyncServiceName;
      const first = created.syncGroup!;
      const observed = yield* getSyncGroup(rg, service, first.syncGroupName);
      expect(observed.id?.toLowerCase()).toEqual(
        first.syncGroupId.toLowerCase(),
      );
      expect(first.uniqueId).toBeDefined();

      // Renaming replaces the sync group.
      const replaced = yield* stack.deploy(program("docs-renamed"));
      expect(replaced.syncGroup!.syncGroupName).toEqual("docs-renamed");
      expect(
        (yield* getSyncGroup(rg, service, "docs-renamed")).properties?.uniqueId,
      ).toEqual(replaced.syncGroup!.uniqueId);
      expect(yield* syncGroupGone(rg, service, first.syncGroupName)).toEqual(
        "gone",
      );

      // Removing the resource deletes the sync group.
      yield* stack.deploy(program());
      expect(yield* syncGroupGone(rg, service, "docs-renamed")).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storagesync", "live"],
    timeout: 600_000,
  },
);
