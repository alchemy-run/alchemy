import * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Layer from "effect/Layer";
import { DataLakeAccess, makeFileSystemOperationBinding } from "./DataLakeBindingHttp.ts";
import { SetPathAccessControlRecursive } from "./SetPathAccessControlRecursive.ts";

/**
 * Implementation of {@link SetPathAccessControlRecursive} over the distilled `storage-datalake`
 * data plane. Assigns a custom role with exactly `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/modifyPermissions/action` on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.SetPathAccessControlRecursive
 */
export const SetPathAccessControlRecursiveHttp = Layer.effect(
  SetPathAccessControlRecursive,
  makeFileSystemOperationBinding({
    tag: "Azure.Storage.SetPathAccessControlRecursive",
    operation: datalake.SetPathAccessControlRecursive,
    access: DataLakeAccess.accessControlRecursive,
  }),
);
