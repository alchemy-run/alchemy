import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { ReleaseFileLease } from "./ReleaseFileLease.ts";

/**
 * Implementation of {@link ReleaseFileLease} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.ReleaseFileLease
 */
export const ReleaseFileLeaseHttp = Layer.effect(
  ReleaseFileLease,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.ReleaseFileLease",
    operation: files.FileReleaseLease,
    access: "write",
  }),
);
