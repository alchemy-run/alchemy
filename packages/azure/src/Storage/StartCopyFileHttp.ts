import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { StartCopyFile } from "./StartCopyFile.ts";

/**
 * Implementation of {@link StartCopyFile} over the distilled `storage-file`
 * data plane. Assigns Storage File Data Privileged Reader and the
 * `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.StartCopyFile
 */
export const StartCopyFileHttp = Layer.effect(
  StartCopyFile,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.StartCopyFile",
    operation: files.FileStartCopy,
    access: ["read", "write"],
  }),
);
