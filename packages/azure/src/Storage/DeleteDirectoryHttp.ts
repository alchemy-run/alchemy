import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { DeleteDirectory } from "./DeleteDirectory.ts";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";

/**
 * Implementation of {@link DeleteDirectory} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareDeleter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.DeleteDirectory
 */
export const DeleteDirectoryHttp = Layer.effect(
  DeleteDirectory,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.DeleteDirectory",
    operation: files.DeleteDirectory,
    access: "delete",
  }),
);
