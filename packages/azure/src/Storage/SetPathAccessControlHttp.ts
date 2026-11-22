import * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Layer from "effect/Layer";
import { DataLakeAccess, makeFileSystemOperationBinding } from "./DataLakeBindingHttp.ts";
import { SetPathAccessControl } from "./SetPathAccessControl.ts";

/**
 * Implementation of {@link SetPathAccessControl} over the distilled `storage-datalake`
 * data plane. Assigns a custom role with exactly `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/modifyPermissions/action` and
 * `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/manageOwnership/action` on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.SetPathAccessControl
 */
export const SetPathAccessControlHttp = Layer.effect(
  SetPathAccessControl,
  makeFileSystemOperationBinding({
    tag: "Azure.Storage.SetPathAccessControl",
    operation: datalake.SetPathAccessControl,
    access: DataLakeAccess.accessControl,
  }),
);
