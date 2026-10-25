import * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Layer from "effect/Layer";
import { DataLakeAccess, makeFileSystemOperationBinding } from "./DataLakeBindingHttp.ts";
import { ReadPath } from "./ReadPath.ts";

/**
 * Implementation of {@link ReadPath} over the distilled `storage-datalake`
 * data plane. Assigns **Storage Blob Data Reader** on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.ReadPath
 */
export const ReadPathHttp = Layer.effect(
  ReadPath,
  makeFileSystemOperationBinding({
    tag: "Azure.Storage.ReadPath",
    operation: datalake.ReadPath,
    access: DataLakeAccess.read,
  }),
);
