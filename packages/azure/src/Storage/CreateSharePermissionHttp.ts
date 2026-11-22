import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { CreateSharePermission } from "./CreateSharePermission.ts";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";

/**
 * Implementation of {@link CreateSharePermission} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileSharePermissionWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.CreateSharePermission
 */
export const CreateSharePermissionHttp = Layer.effect(
  CreateSharePermission,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.CreateSharePermission",
    operation: files.CreateSharePermission,
    access: "permissions",
  }),
);
