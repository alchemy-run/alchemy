import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { ReleaseShareLease } from "./ReleaseShareLease.ts";

/**
 * Implementation of {@link ReleaseShareLease} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareLeaser` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.ReleaseShareLease
 */
export const ReleaseShareLeaseHttp = Layer.effect(
  ReleaseShareLease,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.ReleaseShareLease",
    operation: files.ShareReleaseLease,
    access: "shareLease",
  }),
);
