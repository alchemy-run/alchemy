import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { SetFileMetadata } from "./SetFileMetadata.ts";

/**
 * Implementation of {@link SetFileMetadata} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.SetFileMetadata
 */
export const SetFileMetadataHttp = Layer.effect(
  SetFileMetadata,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.SetFileMetadata",
    operation: files.SetFileMetadata,
    access: "write",
  }),
);
