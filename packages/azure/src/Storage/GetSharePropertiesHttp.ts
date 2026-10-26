import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { GetShareProperties } from "./GetShareProperties.ts";

/**
 * Implementation of {@link GetShareProperties} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileSharePropertiesReader` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.GetShareProperties
 */
export const GetSharePropertiesHttp = Layer.effect(
  GetShareProperties,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.GetShareProperties",
    operation: files.GetShareProperties,
    access: "shareRead",
  }),
);
