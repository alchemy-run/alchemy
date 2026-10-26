import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { CreateFileHardLink } from "./CreateFileHardLink.ts";

/**
 * Implementation of {@link CreateFileHardLink} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.CreateFileHardLink
 */
export const CreateFileHardLinkHttp = Layer.effect(
  CreateFileHardLink,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.CreateFileHardLink",
    operation: files.CreateFileHardLink,
    access: "write",
  }),
);
