import * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Layer from "effect/Layer";
import { CreateFileSystem } from "./CreateFileSystem.ts";
import { DataLakeAccess, makeAccountOperationBinding } from "./DataLakeBindingHttp.ts";

/**
 * Implementation of {@link CreateFileSystem} over the distilled `storage-datalake`
 * data plane. Assigns a custom role with exactly `Microsoft.Storage/storageAccounts/blobServices/containers/write` on the storage account only.
 *
 * @layer
 * @provides Azure.Storage.CreateFileSystem
 */
export const CreateFileSystemHttp = Layer.effect(
  CreateFileSystem,
  makeAccountOperationBinding({
    tag: "Azure.Storage.CreateFileSystem",
    operation: datalake.CreateFileSystem,
    access: DataLakeAccess.createFileSystem,
  }),
);
