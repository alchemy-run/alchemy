import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Effect from "effect/Effect";
import { location } from "./util.ts";

/** Resource group + storage account + blob container backing a schema registry. */
export const registryStorage = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", { location });
  const account = yield* Azure.Storage.StorageAccount("Schemas", {
    resourceGroup: group.resourceGroupName,
    location,
  });
  const container = yield* Azure.Storage.BlobContainer("SchemaContainer", {
    resourceGroup: group.resourceGroupName,
    storageAccount: account.storageAccountName,
  });
  const containerUrl = Output.interpolate`https://${account.storageAccountName}.blob.core.windows.net/${container.containerName}`;
  return { group, account, container, containerUrl };
});

/** Storage plus a schema registry for schema / schema-version tests. */
export const schemaRegistry = Effect.gen(function* () {
  const storage = yield* registryStorage;
  const registry = yield* Azure.DeviceRegistry.SchemaRegistry("Registry", {
    resourceGroup: storage.group.resourceGroupName,
    location,
    storageAccountContainerUrl: storage.containerUrl,
  });
  // The registry writes schema versions to the container as itself.
  const access = yield* Azure.Authorization.RoleAssignment("RegistryBlob", {
    scope: storage.container.containerId,
    roleDefinitionId:
      Azure.Authorization.BuiltInRole.StorageBlobDataContributor,
    principalId: registry.principalId,
    principalType: "ServicePrincipal",
  });
  /** Schema registry name that resolves only after the role assignment. */
  const registryName = Output.all(
    registry.schemaRegistryName,
    access.roleAssignmentId,
  ).pipe(Output.map(([name]) => name));
  return { ...storage, registry, access, registryName };
});
