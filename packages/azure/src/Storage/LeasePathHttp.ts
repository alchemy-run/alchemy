import * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Layer from "effect/Layer";
import { DataLakeAccess, makeFileSystemOperationBinding } from "./DataLakeBindingHttp.ts";
import { LeasePath } from "./LeasePath.ts";

/**
 * Implementation of {@link LeasePath} over the distilled `storage-datalake`
 * data plane. Assigns a custom role with exactly `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write` on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.LeasePath
 */
export const LeasePathHttp = Layer.effect(
  LeasePath,
  makeFileSystemOperationBinding({
    tag: "Azure.Storage.LeasePath",
    operation: datalake.PathLease,
    access: DataLakeAccess.write,
  }),
);
