import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { GetPageRanges } from "./GetPageRanges.ts";

/**
 * Implementation of {@link GetPageRanges} over the distilled `storage-blob`
 * data plane (`GetPageBlobPageRanges`). Grants **Storage Blob Data Reader**
 * (`blobs/read`) on the container.
 *
 * @layer
 * @provides Azure.Storage.GetPageRanges
 */
export const GetPageRangesHttp = Layer.effect(
  GetPageRanges,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.GetPageRanges",
    operation: blob.GetPageBlobPageRanges,
    role: BlobRoles.Reader,
  }),
);
