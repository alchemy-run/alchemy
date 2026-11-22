import * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Layer from "effect/Layer";
import { DataLakeAccess, makeFileSystemOperationBinding } from "./DataLakeBindingHttp.ts";
import { FlushPathData } from "./FlushPathData.ts";

/**
 * Implementation of {@link FlushPathData} over the distilled `storage-datalake`
 * data plane. Assigns a custom role with exactly `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write` on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.FlushPathData
 */
export const FlushPathDataHttp = Layer.effect(
  FlushPathData,
  makeFileSystemOperationBinding({
    tag: "Azure.Storage.FlushPathData",
    operation: datalake.FlushPathData,
    access: DataLakeAccess.write,
  }),
);
