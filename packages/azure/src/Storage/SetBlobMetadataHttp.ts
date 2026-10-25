import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { SetBlobMetadata } from "./SetBlobMetadata.ts";

/**
 * Implementation of {@link SetBlobMetadata} over the distilled
 * `storage-blob` data plane (`SetBlobMetadata`). Grants a custom role with
 * only `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.SetBlobMetadata
 */
export const SetBlobMetadataHttp = Layer.effect(
  SetBlobMetadata,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.SetBlobMetadata",
    operation: blob.SetBlobMetadata,
    role: BlobRoles.Writer,
  }),
);
