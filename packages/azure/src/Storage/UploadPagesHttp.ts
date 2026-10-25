import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { UploadPages } from "./UploadPages.ts";

/**
 * Implementation of {@link UploadPages} over the distilled `storage-blob`
 * data plane (`UploadPageBlobPages`). Grants a custom role with only
 * `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.UploadPages
 */
export const UploadPagesHttp = Layer.effect(
  UploadPages,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.UploadPages",
    operation: blob.UploadPageBlobPages,
    role: BlobRoles.Writer,
  }),
);
