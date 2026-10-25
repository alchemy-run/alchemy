import * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Layer from "effect/Layer";
import { DataLakeAccess, makeFileSystemOperationBinding } from "./DataLakeBindingHttp.ts";
import { SetPathExpiry } from "./SetPathExpiry.ts";

/**
 * Implementation of {@link SetPathExpiry} over the distilled `storage-datalake`
 * data plane. Assigns a custom role with exactly `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write` on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.SetPathExpiry
 */
export const SetPathExpiryHttp = Layer.effect(
  SetPathExpiry,
  makeFileSystemOperationBinding({
    tag: "Azure.Storage.SetPathExpiry",
    operation: datalake.SetPathExpiry,
    access: DataLakeAccess.write,
    endpoint: "blob",
  }),
);
