import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as storagesync from "@distilled.cloud/azure/storagesync";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";

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

// Built-in roles the service's managed identity needs on the storage account.
const READER_AND_DATA_ACCESS = "c12c1c16-33a1-487b-954d-41c89c60f349";
const STORAGE_ACCOUNT_CONTRIBUTOR = "17d1049b-9a84-46fb-8f53-869881c3d3ab";
const STORAGE_FILE_DATA_PRIVILEGED_CONTRIBUTOR =
  "69566ab7-960f-475b-8e7c-b3118f30c6bd";

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
    // Azure File Sync reaches the share with the service's managed identity.
    const sync = yield* Azure.StorageSync.StorageSyncService("Sync", {
      resourceGroup: group.resourceGroupName,
      identity: { type: "SystemAssigned" },
      useIdentity: true,
    });
    const grants = yield* Effect.forEach(
      [
        ["SyncReadData", READER_AND_DATA_ACCESS],
        ["SyncContributor", STORAGE_ACCOUNT_CONTRIBUTOR],
        ["SyncFileData", STORAGE_FILE_DATA_PRIVILEGED_CONTRIBUTOR],
      ] as const,
      ([id, role]) =>
        Azure.Authorization.RoleAssignment(id, {
          scope: account.storageAccountId,
          roleDefinitionId: role,
          principalId: sync.principalId.as<string>(),
          principalType: "ServicePrincipal",
        }),
    );
    const syncGroup = yield* Azure.StorageSync.SyncGroup("DocsGroup", {
      resourceGroup: group.resourceGroupName,
      storageSyncService: sync.storageSyncServiceName,
    });
    const cloudEndpoint = endpoint
      ? yield* Azure.StorageSync.CloudEndpoint("DocsCloud", {
          resourceGroup: group.resourceGroupName,
          storageSyncService: sync.storageSyncServiceName,
          syncGroup: syncGroup.syncGroupName,
          // Create the endpoint only after the grants exist.
          storageAccountResourceId: Output.all(
            account.storageAccountId,
            grants[0].roleAssignmentId,
            grants[1].roleAssignmentId,
            grants[2].roleAssignmentId,
          ).pipe(Output.map(([accountId]) => accountId)),
          azureFileShareName: share.shareName,
          ...endpoint,
        })
      : undefined;
    return { group, account, share, sync, syncGroup, cloudEndpoint };
  });

// Standard_LRS account + empty 5 GiB share + free sync service: ~$0.01.
// The endpoint lifecycle itself takes ~2 minutes, but once a cloud endpoint
// has existed Azure keeps the resource group in `Deleting` for ~30 minutes
// after every resource in it is gone, so the final teardown exceeds the
// 10-minute budget. Runs with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
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
      expect(
        observed.properties?.storageAccountResourceId?.toLowerCase(),
      ).toEqual(created.account.storageAccountId.toLowerCase());
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
