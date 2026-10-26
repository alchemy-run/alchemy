import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { RenameDirectory } from "./RenameDirectory.ts";

/**
 * Implementation of {@link RenameDirectory} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.RenameDirectory
 */
export const RenameDirectoryHttp = Layer.effect(
  RenameDirectory,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.RenameDirectory",
    operation: files.RenameDirectory,
    access: "write",
  }),
);
