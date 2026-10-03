import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storagesync from "@distilled.cloud/azure/storagesync";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getCloudEndpoint = (
  resourceGroupName: string,
  storageSyncServiceName: string,
  syncGroupName: string,
  cloudEndpointName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storagesync.GetCloudEndpoint({
      subscriptionId,
      resourceGroupName,
      storageSyncServiceName,
      syncGroupName,
      cloudEndpointName,
    });
  });

const cloudEndpointGone = (
  rg: string,
  service: string,
  syncGroup: string,
  name: string,
) =>
  getCloudEndpoint(rg, service, syncGroup, name).pipe(
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

const program = (endpoint?: { changeEnumerationIntervalDays?: number }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Files", {
      resourceGroup: group.resourceGroupName,
    });
    const share = yield* Azure.Storage.FileShare("Docs", {
      resourceGroup: group.resourceGroupName,
      storageAccount: account.storageAccountName,
      shareQuota: 5,
    });
    const sync = yield* Azure.StorageSync.StorageSyncService("Sync", {
      resourceGroup: group.resourceGroupName,
    });
    const syncGroup = yield* Azure.StorageSync.SyncGroup("DocsGroup", {
      resourceGroup: group.resourceGroupName,
      storageSyncService: sync.storageSyncServiceName,
    });
    const cloudEndpoint = endpoint
      ? yield* Azure.StorageSync.CloudEndpoint("DocsCloud", {
          resourceGroup: group.resourceGroupName,
          storageSyncService: sync.storageSyncServiceName,
          syncGroup: syncGroup.syncGroupName,
          storageAccountResourceId: account.storageAccountId,
          azureFileShareName: share.shareName,
          ...endpoint,
        })
      : undefined;
    return { group, account, share, sync, syncGroup, cloudEndpoint };
  });

// Standard_LRS account + empty 5 GiB share + free sync service: ~$0.01,
// ~3-5 minutes.
test.provider(
  "create, update, and delete a cloud endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ changeEnumerationIntervalDays: 7 }),
      );
      const rg = created.group.resourceGroupName;
      const service = created.sync.storageSyncServiceName;
      const syncGroup = created.syncGroup.syncGroupName;
      const endpoint = created.cloudEndpoint!;
      expect(endpoint.azureFileShareName).toEqual(created.share.shareName);
      expect(endpoint.changeEnumerationIntervalDays).toEqual(7);
      const observed = yield* getCloudEndpoint(
        rg,
        service,
        syncGroup,
        endpoint.cloudEndpointName,
      );
      expect(observed.properties?.storageAccountResourceId?.toLowerCase()).toEqual(
        created.account.storageAccountId.toLowerCase(),
      );
      expect(observed.properties?.azureFileShareName).toEqual(
        created.share.shareName,
      );

      // In-place update of the change enumeration interval.
      const updated = yield* stack.deploy(
        program({ changeEnumerationIntervalDays: 3 }),
      );
      expect(updated.cloudEndpoint!.cloudEndpointId).toEqual(
        endpoint.cloudEndpointId,
      );
      expect(
        (yield* getCloudEndpoint(
          rg,
          service,
          syncGroup,
          endpoint.cloudEndpointName,
        )).properties?.changeEnumerationIntervalDays,
      ).toEqual(3);

      // Removing the resource deletes the cloud endpoint.
      yield* stack.deploy(program());
      expect(
        yield* cloudEndpointGone(
          rg,
          service,
          syncGroup,
          endpoint.cloudEndpointName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storagesync", "live"],
    timeout: 900_000,
  },
);
