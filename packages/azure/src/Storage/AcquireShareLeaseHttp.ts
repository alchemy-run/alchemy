import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { AcquireShareLease } from "./AcquireShareLease.ts";

/**
 * Implementation of {@link AcquireShareLease} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareLeaser` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.AcquireShareLease
 */
export const AcquireShareLeaseHttp = Layer.effect(
  AcquireShareLease,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.AcquireShareLease",
    operation: files.ShareAcquireLease,
    access: "shareLease",
  }),
);
