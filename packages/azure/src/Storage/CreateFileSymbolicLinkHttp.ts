import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { CreateFileSymbolicLink } from "./CreateFileSymbolicLink.ts";

/**
 * Implementation of {@link CreateFileSymbolicLink} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileShareWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.CreateFileSymbolicLink
 */
export const CreateFileSymbolicLinkHttp = Layer.effect(
  CreateFileSymbolicLink,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.CreateFileSymbolicLink",
    operation: files.CreateFileSymbolicLink,
    access: "write",
  }),
);
