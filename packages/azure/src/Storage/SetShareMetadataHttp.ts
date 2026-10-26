import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { SetShareMetadata } from "./SetShareMetadata.ts";

/**
 * Implementation of {@link SetShareMetadata} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileSharePropertiesWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.SetShareMetadata
 */
export const SetShareMetadataHttp = Layer.effect(
  SetShareMetadata,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.SetShareMetadata",
    operation: files.SetShareMetadata,
    access: "shareWrite",
  }),
);
