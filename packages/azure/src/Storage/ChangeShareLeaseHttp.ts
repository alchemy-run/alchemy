import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { ChangeShareLease } from "./ChangeShareLease.ts";

/**
 * Implementation of {@link ChangeShareLease} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareLeaser` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.ChangeShareLease
 */
export const ChangeShareLeaseHttp = Layer.effect(
  ChangeShareLease,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.ChangeShareLease",
    operation: files.ShareChangeLease,
    access: "shareLease",
  }),
);
