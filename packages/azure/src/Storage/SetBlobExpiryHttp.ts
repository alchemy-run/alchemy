import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { SetBlobExpiry } from "./SetBlobExpiry.ts";

/**
 * Implementation of {@link SetBlobExpiry} over the distilled `storage-blob`
 * data plane (`SetBlobExpiry`). Grants a custom role with only `blobs/write`
 * on the container.
 *
 * @layer
 * @provides Azure.Storage.SetBlobExpiry
 */
export const SetBlobExpiryHttp = Layer.effect(
  SetBlobExpiry,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.SetBlobExpiry",
    operation: blob.SetBlobExpiry,
    role: BlobRoles.Writer,
  }),
);
