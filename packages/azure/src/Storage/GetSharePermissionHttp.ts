import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { GetSharePermission } from "./GetSharePermission.ts";

/**
 * Implementation of {@link GetSharePermission} over the distilled `storage-file`
 * data plane. Assigns Storage File Data Privileged Reader on the share.
 *
 * @layer
 * @provides Azure.Storage.GetSharePermission
 */
export const GetSharePermissionHttp = Layer.effect(
  GetSharePermission,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.GetSharePermission",
    operation: files.GetSharePermission,
    access: "read",
  }),
);
