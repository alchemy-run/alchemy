import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { UploadFileRange } from "./UploadFileRange.ts";

/**
 * Implementation of {@link UploadFileRange} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.UploadFileRange
 */
export const UploadFileRangeHttp = Layer.effect(
  UploadFileRange,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.UploadFileRange",
    operation: files.UploadFileRange,
    access: "write",
  }),
);
