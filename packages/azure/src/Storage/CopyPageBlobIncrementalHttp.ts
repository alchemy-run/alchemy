import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { CopyPageBlobIncremental } from "./CopyPageBlobIncremental.ts";

/**
 * Implementation of {@link CopyPageBlobIncremental} over the distilled
 * `storage-blob` data plane (`CopyPageBlobIncremental`). Grants a custom
 * role with only `blobs/write` (Azure reads the source with the URL's own
 * authorization: public, a SAS, or `xMsCopySourceAuthorization`) on the
 * container.
 *
 * @layer
 * @provides Azure.Storage.CopyPageBlobIncremental
 */
export const CopyPageBlobIncrementalHttp = Layer.effect(
  CopyPageBlobIncremental,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.CopyPageBlobIncremental",
    operation: blob.CopyPageBlobIncremental,
    role: BlobRoles.Writer,
  }),
);
