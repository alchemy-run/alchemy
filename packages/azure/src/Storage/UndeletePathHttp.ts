import * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Layer from "effect/Layer";
import { DataLakeAccess, makeFileSystemOperationBinding } from "./DataLakeBindingHttp.ts";
import { UndeletePath } from "./UndeletePath.ts";

/**
 * Implementation of {@link UndeletePath} over the distilled `storage-datalake`
 * data plane. Assigns a custom role with exactly `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write` on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.UndeletePath
 */
export const UndeletePathHttp = Layer.effect(
  UndeletePath,
  makeFileSystemOperationBinding({
    tag: "Azure.Storage.UndeletePath",
    operation: datalake.UndeletePath,
    access: DataLakeAccess.write,
    endpoint: "blob",
  }),
);
