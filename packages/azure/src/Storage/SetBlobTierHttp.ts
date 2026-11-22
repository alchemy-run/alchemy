import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { SetBlobTier } from "./SetBlobTier.ts";

/**
 * Implementation of {@link SetBlobTier} over the distilled `storage-blob`
 * data plane (`SetBlobTier`). Grants a custom role with only `blobs/write`
 * on the container.
 *
 * @layer
 * @provides Azure.Storage.SetBlobTier
 */
export const SetBlobTierHttp = Layer.effect(
  SetBlobTier,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.SetBlobTier",
    operation: blob.SetBlobTier,
    role: BlobRoles.Writer,
  }),
);
