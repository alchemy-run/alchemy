import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as storagesync from "@distilled.cloud/azure/storagesync";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:storagesync", "live"];

const getServerEndpoint = (
  resourceGroupName: string,
  storageSyncServiceName: string,
  syncGroupName: string,
  serverEndpointName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storagesync.GetServerEndpoint({
      subscriptionId,
      resourceGroupName,
      storageSyncServiceName,
      syncGroupName,
      serverEndpointName,
    });
  });

const serverEndpointGone = (
  rg: string,
  service: string,
  syncGroup: string,
  name: string,
) =>
  getServerEndpoint(rg, service, syncGroup, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 36,
    }),
  );

// A server endpoint needs a Windows Server running the Azure File Sync agent,
// registered with an existing Storage Sync Service (registration happens on
// the server, not through ARM). The free trial cannot host one (a >=2 vCPU
// Windows VM plus manual agent setup), so the lifecycle runs only with
// AZURE_TEST_PAID=1 and these variables naming a pre-registered server:
//   AZURE_TEST_FILE_SYNC_RESOURCE_GROUP  resource group of the service
//   AZURE_TEST_FILE_SYNC_SERVICE         Storage Sync Service name
//   AZURE_TEST_FILE_SYNC_SERVER          registered server ID (GUID)
//   AZURE_TEST_FILE_SYNC_PATH            local path, e.g. D:\Shares\Alchemy
// The test creates its own sync group, storage account, share, and cloud
// endpoint under that service (~$0.01 + the VM's cost).
const fileSync = {
  resourceGroup: process.env.AZURE_TEST_FILE_SYNC_RESOURCE_GROUP ?? "",
  service: process.env.AZURE_TEST_FILE_SYNC_SERVICE ?? "",
  server: process.env.AZURE_TEST_FILE_SYNC_SERVER ?? "",
  path: process.env.AZURE_TEST_FILE_SYNC_PATH ?? "D:\\Shares\\Alchemy",
};

const lifecycleProgram = (endpoint?: { volumeFreeSpacePercent: number }) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const serviceId = `/subscriptions/${subscriptionId}/resourceGroups/${fileSync.resourceGroup}/providers/Microsoft.StorageSync/storageSyncServices/${fileSync.service}`;
    const account = yield* Azure.Storage.StorageAccount("Files", {
      resourceGroup: fileSync.resourceGroup,
    });
    const share = yield* Azure.Storage.FileShare("Docs", {
      resourceGroup: fileSync.resourceGroup,
      storageAccount: account.storageAccountName,
      shareQuota: 5,
    });
    const syncGroup = yield* Azure.StorageSync.SyncGroup("DocsGroup", {
      resourceGroup: fileSync.resourceGroup,
      storageSyncService: fileSync.service,
    });
    const cloud = yield* Azure.StorageSync.CloudEndpoint("DocsCloud", {
      resourceGroup: fileSync.resourceGroup,
      storageSyncService: fileSync.service,
      syncGroup: syncGroup.syncGroupName,
      storageAccountResourceId: account.storageAccountId,
      azureFileShareName: share.shareName,
    });
    const server = endpoint
      ? yield* Azure.StorageSync.ServerEndpoint("DocsServer", {
          resourceGroup: fileSync.resourceGroup,
          storageSyncService: fileSync.service,
          // Depends on the cloud endpoint: a sync group needs one first.
          syncGroup: cloud.syncGroupName,
          serverResourceId: `${serviceId}/registeredServers/${fileSync.server}`,
          serverLocalPath: fileSync.path,
          cloudTiering: "on",
          volumeFreeSpacePercent: endpoint.volumeFreeSpacePercent,
        })
      : undefined;
    return { syncGroup, cloud, server };
  });

test.provider.skipIf(!runPaidOnly || fileSync.server === "")(
  "create, update, and delete a server endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        lifecycleProgram({ volumeFreeSpacePercent: 20 }),
      );
      const syncGroup = created.syncGroup.syncGroupName;
      const server = created.server!;
      expect(server.cloudTiering).toEqual("on");
      const observed = yield* getServerEndpoint(
        fileSync.resourceGroup,
        fileSync.service,
        syncGroup,
        server.serverEndpointName,
      );
      expect(observed.properties?.volumeFreeSpacePercent).toEqual(20);

      // In-place update of the cloud tiering policy.
      const updated = yield* stack.deploy(
        lifecycleProgram({ volumeFreeSpacePercent: 40 }),
      );
      expect(updated.server!.serverEndpointId).toEqual(server.serverEndpointId);
      expect(
        (yield* getServerEndpoint(
          fileSync.resourceGroup,
          fileSync.service,
          syncGroup,
          server.serverEndpointName,
        )).properties?.volumeFreeSpacePercent,
      ).toEqual(40);

      // Removing the resource deletes the server endpoint.
      yield* stack.deploy(lifecycleProgram());
      expect(
        yield* serverEndpointGone(
          fileSync.resourceGroup,
          fileSync.service,
          syncGroup,
          server.serverEndpointName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }),
  { tags, timeout: 900_000 },
);

const probeProgram = (withEndpoint: boolean) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const sync = yield* Azure.StorageSync.StorageSyncService("Sync", {
      resourceGroup: group.resourceGroupName,
    });
    const syncGroup = yield* Azure.StorageSync.SyncGroup("DocsGroup", {
      resourceGroup: group.resourceGroupName,
      storageSyncService: sync.storageSyncServiceName,
    });
    if (withEndpoint) {
      yield* Azure.StorageSync.ServerEndpoint("DocsServer", {
        resourceGroup: group.resourceGroupName,
        storageSyncService: sync.storageSyncServiceName,
        syncGroup: syncGroup.syncGroupName,
        serverResourceId: Output.interpolate`${sync.storageSyncServiceId}/registeredServers/00000000-0000-0000-0000-000000000001`,
        serverLocalPath: "D:\\Shares\\Docs",
      });
    }
    return { group, sync, syncGroup };
  });

// Ungated probe (free service + sync group, ~1 minute): an endpoint for a
// server that is not registered fails fast with the typed error and creates
// nothing.
test.provider(
  "server endpoint for an unregistered server is rejected",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const base = yield* stack.deploy(probeProgram(false));
      const error = yield* stack.deploy(probeProgram(true)).pipe(Effect.flip);
      expect(JSON.stringify(error)).toContain(
        "Azure.StorageSync.RegisteredServerNotFound",
      );
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const listed = yield* storagesync.ListServerEndpointBySyncGroup({
        subscriptionId,
        resourceGroupName: base.group.resourceGroupName,
        storageSyncServiceName: base.sync.storageSyncServiceName,
        syncGroupName: base.syncGroup.syncGroupName,
      });
      expect(listed.value ?? []).toEqual([]);

      yield* stack.destroy();
    }),
  { tags, timeout: 600_000 },
);
