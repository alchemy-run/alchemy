import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { BreakFileLease } from "./BreakFileLease.ts";

/**
 * Implementation of {@link BreakFileLease} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.BreakFileLease
 */
export const BreakFileLeaseHttp = Layer.effect(
  BreakFileLease,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.BreakFileLease",
    operation: files.FileBreakLease,
    access: "write",
  }),
);
