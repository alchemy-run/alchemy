import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { RenewShareLease } from "./RenewShareLease.ts";

/**
 * Implementation of {@link RenewShareLease} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareLeaser` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.RenewShareLease
 */
export const RenewShareLeaseHttp = Layer.effect(
  RenewShareLease,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.RenewShareLease",
    operation: files.RenewShareLease,
    access: "shareLease",
  }),
);
