import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobServiceOpBinding } from "./BlobContainerHttp.ts";
import { DeleteBlobContainer } from "./DeleteBlobContainer.ts";

/**
 * Implementation of {@link DeleteBlobContainer} over the distilled
 * `storage-blob` data plane (`DeleteContainer`). Grants a custom role with
 * only `containers/delete` on the storage account.
 *
 * @layer
 * @provides Azure.Storage.DeleteBlobContainer
 */
export const DeleteBlobContainerHttp = Layer.effect(
  DeleteBlobContainer,
  makeBlobServiceOpBinding({
    tag: "Azure.Storage.DeleteBlobContainer",
    operation: blob.DeleteContainer,
    role: BlobRoles.ContainerDeleter,
  }),
);
