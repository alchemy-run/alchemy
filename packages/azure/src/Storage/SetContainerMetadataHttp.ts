import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { SetContainerMetadata } from "./SetContainerMetadata.ts";

/**
 * Implementation of {@link SetContainerMetadata} over the distilled
 * `storage-blob` data plane (`SetContainerMetadata`). Grants a custom role
 * with only `containers/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.SetContainerMetadata
 */
export const SetContainerMetadataHttp = Layer.effect(
  SetContainerMetadata,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.SetContainerMetadata",
    operation: blob.SetContainerMetadata,
    role: BlobRoles.ContainerWriter,
  }),
);
