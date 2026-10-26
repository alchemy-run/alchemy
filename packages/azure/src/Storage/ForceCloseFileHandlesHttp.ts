import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { ForceCloseFileHandles } from "./ForceCloseFileHandles.ts";

/**
 * Implementation of {@link ForceCloseFileHandles} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.ForceCloseFileHandles
 */
export const ForceCloseFileHandlesHttp = Layer.effect(
  ForceCloseFileHandles,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.ForceCloseFileHandles",
    operation: files.FileForceCloseHandles,
    access: "write",
  }),
);
