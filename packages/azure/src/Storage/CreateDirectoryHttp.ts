import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { CreateDirectory } from "./CreateDirectory.ts";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";

/**
 * Implementation of {@link CreateDirectory} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.CreateDirectory
 */
export const CreateDirectoryHttp = Layer.effect(
  CreateDirectory,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.CreateDirectory",
    operation: files.CreateDirectory,
    access: "write",
  }),
);
