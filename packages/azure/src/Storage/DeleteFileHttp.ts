import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { DeleteFile } from "./DeleteFile.ts";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";

/**
 * Implementation of {@link DeleteFile} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareDeleter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.DeleteFile
 */
export const DeleteFileHttp = Layer.effect(
  DeleteFile,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.DeleteFile",
    operation: files.DeleteFile,
    access: "delete",
  }),
);
