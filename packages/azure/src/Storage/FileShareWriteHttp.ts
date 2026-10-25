import * as Layer from "effect/Layer";
import { makeFileShareBinding } from "./FileShareHttp.ts";
import { FileShareWrite } from "./FileShareWrite.ts";

/**
 * Implementation of {@link FileShareWrite} over the distilled
 * `storage-file` data plane. Assigns the `AzureStorageFileShareWriter` and
 * `AzureStorageFileShareDeleter` custom roles on the share.
 *
 * @layer
 * @provides Azure.Storage.FileShareWrite
 */
export const FileShareWriteHttp = Layer.effect(
  FileShareWrite,
  makeFileShareBinding({
    tag: "Azure.Storage.FileShareWrite",
    access: ["write", "delete"],
    makeClient: (helpers, address) => helpers.makeWrite(address),
  }),
);
