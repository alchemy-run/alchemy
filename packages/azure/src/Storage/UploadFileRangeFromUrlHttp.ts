import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { UploadFileRangeFromUrl } from "./UploadFileRangeFromUrl.ts";

/**
 * Implementation of {@link UploadFileRangeFromUrl} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.UploadFileRangeFromUrl
 */
export const UploadFileRangeFromUrlHttp = Layer.effect(
  UploadFileRangeFromUrl,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.UploadFileRangeFromUrl",
    operation: files.UploadFileRangeFromURL,
    access: "write",
  }),
);
