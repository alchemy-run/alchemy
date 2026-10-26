import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { AbortCopyFile } from "./AbortCopyFile.ts";

/**
 * Implementation of {@link AbortCopyFile} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.AbortCopyFile
 */
export const AbortCopyFileHttp = Layer.effect(
  AbortCopyFile,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.AbortCopyFile",
    operation: files.CopyFileAbort,
    access: "write",
  }),
);
