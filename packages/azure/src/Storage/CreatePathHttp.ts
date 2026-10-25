import * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Layer from "effect/Layer";
import { CreatePath } from "./CreatePath.ts";
import { DataLakeAccess, makeFileSystemOperationBinding } from "./DataLakeBindingHttp.ts";

/**
 * Implementation of {@link CreatePath} over the distilled `storage-datalake`
 * data plane. Assigns a custom role with exactly `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write` on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.CreatePath
 */
export const CreatePathHttp = Layer.effect(
  CreatePath,
  makeFileSystemOperationBinding({
    tag: "Azure.Storage.CreatePath",
    operation: datalake.CreatePath,
    access: DataLakeAccess.write,
  }),
);
