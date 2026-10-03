import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storagesync from "@distilled.cloud/azure/storagesync";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getService = (
  resourceGroupName: string,
  storageSyncServiceName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storagesync.GetStorageSyncService({
      subscriptionId,
      resourceGroupName,
      storageSyncServiceName,
    });
  });

const serviceGone = (resourceGroupName: string, name: string) =>
  getService(resourceGroupName, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (
  service?: Omit<Azure.StorageSync.StorageSyncServiceProps, "resourceGroup">,
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const sync = service
      ? yield* Azure.StorageSync.StorageSyncService("Sync", {
          ...service,
          resourceGroup: group.resourceGroupName,
        })
      : undefined;
    return { group, sync };
  });

// Storage Sync Services are free; ~1 minute.
test.provider(
  "create, update, and delete a storage sync service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ tags: { env: "test" } }));
      const rg = created.group.resourceGroupName;
      const sync = created.sync!;
      expect(sync.incomingTrafficPolicy).toEqual("AllowAllTraffic");
      expect(sync.tags).toEqual({ env: "test" });
      const observed = yield* getService(rg, sync.storageSyncServiceName);
      expect(observed.properties?.incomingTrafficPolicy).toEqual(
        "AllowAllTraffic",
      );
      expect(observed.tags?.["alchemy::id"]).toEqual("Sync");

      // In-place update: traffic policy and tags.
      const updated = yield* stack.deploy(
        program({
          incomingTrafficPolicy: "AllowVirtualNetworksOnly",
          tags: { env: "prod" },
        }),
      );
      expect(updated.sync!.storageSyncServiceId).toEqual(
        sync.storageSyncServiceId,
      );
      const reobserved = yield* getService(rg, sync.storageSyncServiceName);
      expect(reobserved.properties?.incomingTrafficPolicy).toEqual(
        "AllowVirtualNetworksOnly",
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Removing the resource deletes the service.
      yield* stack.deploy(program());
      expect(yield* serviceGone(rg, sync.storageSyncServiceName)).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storagesync", "live"],
    timeout: 600_000,
  },
);
