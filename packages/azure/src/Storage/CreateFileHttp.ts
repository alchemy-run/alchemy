import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { CreateFile } from "./CreateFile.ts";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";

/**
 * Implementation of {@link CreateFile} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.CreateFile
 */
export const CreateFileHttp = Layer.effect(
  CreateFile,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.CreateFile",
    operation: files.CreateFile,
    access: "write",
  }),
);
