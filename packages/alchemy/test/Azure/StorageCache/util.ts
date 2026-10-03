import * as Azure from "@/Azure";
import * as Output from "@/Output";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:storagecache", "live"];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/**
 * Object ID of the "HPC Cache Resource Provider" service principal
 * (appId 4392ab71-2ce2-4b0d-8770-b352745c73f5) in the test tenant. Blob
 * integration needs it to hold Storage Account Contributor and Storage Blob
 * Data Contributor on the storage account. Look it up with
 * `az ad sp show --id 4392ab71-2ce2-4b0d-8770-b352745c73f5 --query id`.
 */
export const hpcCacheRpObjectId = process.env.AZURE_HPC_CACHE_RP_OBJECT_ID;

/** Built-in "Storage Account Contributor" role. */
export const StorageAccountContributor = "17d1049b-9a84-46fb-8f53-869881c3d3ab";

/** Poll an out-of-band GET until it reports a typed not-found (bounded). */
export const waitGone = <A, R>(
  get: Effect.Effect<A, AzureOpError, R>,
  times = 24,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times,
    }),
  );

/**
 * Network + blob integration dependencies shared by the file system and job
 * tests: a VNet with a dedicated /24 Lustre subnet, and (optionally) a
 * storage account with data + logging containers the HPC Cache resource
 * provider may use.
 */
export const lustreDependencies = (opts: { hsm: boolean }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.42.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Lustre", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.42.0.0/24",
    });
    if (!opts.hsm) return { group, subnet, hsm: undefined, grants: undefined };
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    yield* Azure.Storage.BlobServiceProperties("BlobService", {
      resourceGroup: group.resourceGroupName,
      storageAccount: account.storageAccountName,
      changeFeed: { enabled: true },
    });
    const data = yield* Azure.Storage.BlobContainer("Data", {
      resourceGroup: group.resourceGroupName,
      storageAccount: account.storageAccountName,
    });
    const logs = yield* Azure.Storage.BlobContainer("Logs", {
      resourceGroup: group.resourceGroupName,
      storageAccount: account.storageAccountName,
    });
    const accountGrant = yield* Azure.Authorization.RoleAssignment(
      "RpAccountContributor",
      {
        scope: account.storageAccountId,
        roleDefinitionId: StorageAccountContributor,
        principalId: hpcCacheRpObjectId ?? "",
        principalType: "ServicePrincipal",
      },
    );
    const blobGrant = yield* Azure.Authorization.RoleAssignment(
      "RpBlobContributor",
      {
        scope: account.storageAccountId,
        roleDefinitionId:
          Azure.Authorization.BuiltInRole.StorageBlobDataContributor,
        principalId: hpcCacheRpObjectId ?? "",
        principalType: "ServicePrincipal",
      },
    );
    return {
      group,
      subnet,
      hsm: { container: data.containerId, loggingContainer: logs.containerId },
      // Referenced from the file system's tags so it is created only after
      // the resource provider holds both roles.
      grants: Output.interpolate`${accountGrant.roleAssignmentName},${blobGrant.roleAssignmentName}`,
    };
  });
