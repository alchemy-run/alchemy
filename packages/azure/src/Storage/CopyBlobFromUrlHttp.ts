import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { CopyBlobFromUrl } from "./CopyBlobFromUrl.ts";

/**
 * Implementation of {@link CopyBlobFromUrl} over the distilled
 * `storage-blob` data plane (`CopyBlobFromURL`). Grants a custom role with
 * only `blobs/write` (Azure reads the source with the URL's own
 * authorization: public, a SAS, or `xMsCopySourceAuthorization`) on the
 * container.
 *
 * @layer
 * @provides Azure.Storage.CopyBlobFromUrl
 */
export const CopyBlobFromUrlHttp = Layer.effect(
  CopyBlobFromUrl,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.CopyBlobFromUrl",
    operation: blob.CopyBlobFromURL,
    role: BlobRoles.Writer,
  }),
);
