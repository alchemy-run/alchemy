import * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Layer from "effect/Layer";
import { DataLakeAccess, makeAccountOperationBinding } from "./DataLakeBindingHttp.ts";
import { DeleteFileSystem } from "./DeleteFileSystem.ts";

/**
 * Implementation of {@link DeleteFileSystem} over the distilled `storage-datalake`
 * data plane. Assigns a custom role with exactly `Microsoft.Storage/storageAccounts/blobServices/containers/delete` on the storage account only.
 *
 * @layer
 * @provides Azure.Storage.DeleteFileSystem
 */
export const DeleteFileSystemHttp = Layer.effect(
  DeleteFileSystem,
  makeAccountOperationBinding({
    tag: "Azure.Storage.DeleteFileSystem",
    operation: datalake.DeleteFileSystem,
    access: DataLakeAccess.deleteFileSystem,
  }),
);
