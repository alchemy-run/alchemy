import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { BreakShareLease } from "./BreakShareLease.ts";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";

/**
 * Implementation of {@link BreakShareLease} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareLeaser` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.BreakShareLease
 */
export const BreakShareLeaseHttp = Layer.effect(
  BreakShareLease,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.BreakShareLease",
    operation: files.ShareBreakLease,
    access: "shareLease",
  }),
);
