import * as Layer from "effect/Layer";
import { makeFileShareBinding } from "./FileShareHttp.ts";
import { FileShareReadWrite } from "./FileShareReadWrite.ts";

/**
 * Implementation of {@link FileShareReadWrite} over the distilled
 * `storage-file` data plane. Assigns **Storage File Data Privileged
 * Reader** and the `AzureStorageFileShareWriter` and
 * `AzureStorageFileShareDeleter` custom roles on the share.
 *
 * @layer
 * @provides Azure.Storage.FileShareReadWrite
 */
export const FileShareReadWriteHttp = Layer.effect(
  FileShareReadWrite,
  makeFileShareBinding({
    tag: "Azure.Storage.FileShareReadWrite",
    access: ["read", "write", "delete"],
    makeClient: (helpers, address) => ({
      ...helpers.makeRead(address),
      ...helpers.makeWrite(address),
    }),
  }),
);
