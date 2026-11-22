import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { SetFileHTTPHeaders } from "./SetFileHTTPHeaders.ts";

/**
 * Implementation of {@link SetFileHTTPHeaders} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.SetFileHTTPHeaders
 */
export const SetFileHTTPHeadersHttp = Layer.effect(
  SetFileHTTPHeaders,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.SetFileHTTPHeaders",
    operation: files.SetFileHTTPHeaders,
    access: "write",
  }),
);
