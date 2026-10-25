import * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Layer from "effect/Layer";
import { DataLakeAccess, makeFileSystemOperationBinding } from "./DataLakeBindingHttp.ts";
import { GetFileSystemProperties } from "./GetFileSystemProperties.ts";

/**
 * Implementation of {@link GetFileSystemProperties} over the distilled `storage-datalake`
 * data plane. Assigns a custom role with exactly `Microsoft.Storage/storageAccounts/blobServices/containers/read` on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.GetFileSystemProperties
 */
export const GetFileSystemPropertiesHttp = Layer.effect(
  GetFileSystemProperties,
  makeFileSystemOperationBinding({
    tag: "Azure.Storage.GetFileSystemProperties",
    operation: datalake.GetFileSystemProperties,
    access: DataLakeAccess.fileSystemRead,
  }),
);
