import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { SetShareProperties } from "./SetShareProperties.ts";

/**
 * Implementation of {@link SetShareProperties} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileSharePropertiesWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.SetShareProperties
 */
export const SetSharePropertiesHttp = Layer.effect(
  SetShareProperties,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.SetShareProperties",
    operation: files.SetShareProperties,
    access: "shareWrite",
  }),
);
