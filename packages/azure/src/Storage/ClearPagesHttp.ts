import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { ClearPages } from "./ClearPages.ts";

/**
 * Implementation of {@link ClearPages} over the distilled `storage-blob`
 * data plane (`ClearPageBlobPages`). Grants a custom role with only
 * `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.ClearPages
 */
export const ClearPagesHttp = Layer.effect(
  ClearPages,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.ClearPages",
    operation: blob.ClearPageBlobPages,
    role: BlobRoles.Writer,
  }),
);
