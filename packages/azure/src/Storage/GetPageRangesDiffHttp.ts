import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { GetPageRangesDiff } from "./GetPageRangesDiff.ts";

/**
 * Implementation of {@link GetPageRangesDiff} over the distilled
 * `storage-blob` data plane (`GetPageBlobPageRangesDiff`). Grants **Storage
 * Blob Data Reader** (`blobs/read`) on the container.
 *
 * @layer
 * @provides Azure.Storage.GetPageRangesDiff
 */
export const GetPageRangesDiffHttp = Layer.effect(
  GetPageRangesDiff,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.GetPageRangesDiff",
    operation: blob.GetPageBlobPageRangesDiff,
    role: BlobRoles.Reader,
  }),
);
