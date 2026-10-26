import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { ChangeFileLease } from "./ChangeFileLease.ts";

/**
 * Implementation of {@link ChangeFileLease} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.ChangeFileLease
 */
export const ChangeFileLeaseHttp = Layer.effect(
  ChangeFileLease,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.ChangeFileLease",
    operation: files.FileChangeLease,
    access: "write",
  }),
);
