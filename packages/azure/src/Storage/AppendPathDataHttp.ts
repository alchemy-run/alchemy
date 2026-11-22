import * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Layer from "effect/Layer";
import { AppendPathData } from "./AppendPathData.ts";
import { DataLakeAccess, makeFileSystemOperationBinding } from "./DataLakeBindingHttp.ts";

/**
 * Implementation of {@link AppendPathData} over the distilled `storage-datalake`
 * data plane. Assigns a custom role with exactly `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write` on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.AppendPathData
 */
export const AppendPathDataHttp = Layer.effect(
  AppendPathData,
  makeFileSystemOperationBinding({
    tag: "Azure.Storage.AppendPathData",
    operation: datalake.PathAppendData,
    access: DataLakeAccess.write,
  }),
);
