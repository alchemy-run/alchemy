import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { RenameFile } from "./RenameFile.ts";

/**
 * Implementation of {@link RenameFile} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.RenameFile
 */
export const RenameFileHttp = Layer.effect(
  RenameFile,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.RenameFile",
    operation: files.RenameFile,
    access: "write",
  }),
);
