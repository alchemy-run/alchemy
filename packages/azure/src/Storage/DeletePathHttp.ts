import * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Layer from "effect/Layer";
import { DataLakeAccess, makeFileSystemOperationBinding } from "./DataLakeBindingHttp.ts";
import { DeletePath } from "./DeletePath.ts";

/**
 * Implementation of {@link DeletePath} over the distilled `storage-datalake`
 * data plane. Assigns a custom role with exactly `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete` on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.DeletePath
 */
export const DeletePathHttp = Layer.effect(
  DeletePath,
  makeFileSystemOperationBinding({
    tag: "Azure.Storage.DeletePath",
    operation: datalake.DeletePath,
    access: DataLakeAccess.delete,
  }),
);
