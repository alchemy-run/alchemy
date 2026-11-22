import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobServiceOpBinding } from "./BlobContainerHttp.ts";
import { RestoreBlobContainer } from "./RestoreBlobContainer.ts";

/**
 * Implementation of {@link RestoreBlobContainer} over the distilled
 * `storage-blob` data plane (`RestoreContainer`). Grants a custom role with
 * only `containers/write` on the storage account.
 *
 * @layer
 * @provides Azure.Storage.RestoreBlobContainer
 */
export const RestoreBlobContainerHttp = Layer.effect(
  RestoreBlobContainer,
  makeBlobServiceOpBinding({
    tag: "Azure.Storage.RestoreBlobContainer",
    operation: blob.RestoreContainer,
    role: BlobRoles.ContainerWriter,
  }),
);
