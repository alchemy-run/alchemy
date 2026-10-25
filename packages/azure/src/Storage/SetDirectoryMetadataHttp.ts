import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { SetDirectoryMetadata } from "./SetDirectoryMetadata.ts";

/**
 * Implementation of {@link SetDirectoryMetadata} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.SetDirectoryMetadata
 */
export const SetDirectoryMetadataHttp = Layer.effect(
  SetDirectoryMetadata,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.SetDirectoryMetadata",
    operation: files.SetDirectoryMetadata,
    access: "write",
  }),
);
