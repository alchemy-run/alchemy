import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { UploadPagesFromUrl } from "./UploadPagesFromUrl.ts";

/**
 * Implementation of {@link UploadPagesFromUrl} over the distilled
 * `storage-blob` data plane (`UploadPageBlobPagesFromURL`). Grants a custom
 * role with only `blobs/write` (Azure reads the source with the URL's own
 * authorization: public, a SAS, or `xMsCopySourceAuthorization`) on the
 * container.
 *
 * @layer
 * @provides Azure.Storage.UploadPagesFromUrl
 */
export const UploadPagesFromUrlHttp = Layer.effect(
  UploadPagesFromUrl,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.UploadPagesFromUrl",
    operation: blob.UploadPageBlobPagesFromURL,
    role: BlobRoles.Writer,
  }),
);
