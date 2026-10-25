import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobServiceOpBinding } from "./BlobContainerHttp.ts";
import { CreateBlobContainer } from "./CreateBlobContainer.ts";

/**
 * Implementation of {@link CreateBlobContainer} over the distilled
 * `storage-blob` data plane (`CreateContainer`). Grants a custom role with
 * only `containers/write` on the storage account.
 *
 * @layer
 * @provides Azure.Storage.CreateBlobContainer
 */
export const CreateBlobContainerHttp = Layer.effect(
  CreateBlobContainer,
  makeBlobServiceOpBinding({
    tag: "Azure.Storage.CreateBlobContainer",
    operation: blob.CreateContainer,
    role: BlobRoles.ContainerWriter,
  }),
);
