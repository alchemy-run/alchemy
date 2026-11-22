import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { ForceCloseDirectoryHandles } from "./ForceCloseDirectoryHandles.ts";

/**
 * Implementation of {@link ForceCloseDirectoryHandles} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.ForceCloseDirectoryHandles
 */
export const ForceCloseDirectoryHandlesHttp = Layer.effect(
  ForceCloseDirectoryHandles,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.ForceCloseDirectoryHandles",
    operation: files.DirectoryForceCloseHandles,
    access: "write",
  }),
);
