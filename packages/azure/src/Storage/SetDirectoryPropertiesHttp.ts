import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { SetDirectoryProperties } from "./SetDirectoryProperties.ts";

/**
 * Implementation of {@link SetDirectoryProperties} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.SetDirectoryProperties
 */
export const SetDirectoryPropertiesHttp = Layer.effect(
  SetDirectoryProperties,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.SetDirectoryProperties",
    operation: files.SetDirectoryProperties,
    access: "write",
  }),
);
