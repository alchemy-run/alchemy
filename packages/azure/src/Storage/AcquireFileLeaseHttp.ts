import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { AcquireFileLease } from "./AcquireFileLease.ts";

/**
 * Implementation of {@link AcquireFileLease} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.AcquireFileLease
 */
export const AcquireFileLeaseHttp = Layer.effect(
  AcquireFileLease,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.AcquireFileLease",
    operation: files.FileAcquireLease,
    access: "write",
  }),
);
