import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { PutBlobFromUrl } from "./PutBlobFromUrl.ts";

/**
 * Implementation of {@link PutBlobFromUrl} over the distilled `storage-blob`
 * data plane (`PutBlockBlobBlobFromUrl`). Grants a custom role with only
 * `blobs/write` (Azure reads the source with the URL's own authorization:
 * public, a SAS, or `xMsCopySourceAuthorization`) on the container.
 *
 * @layer
 * @provides Azure.Storage.PutBlobFromUrl
 */
export const PutBlobFromUrlHttp = Layer.effect(
  PutBlobFromUrl,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.PutBlobFromUrl",
    operation: blob.PutBlockBlobBlobFromUrl,
    role: BlobRoles.Writer,
  }),
);
