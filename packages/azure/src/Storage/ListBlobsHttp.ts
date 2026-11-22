import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { ListBlobs } from "./ListBlobs.ts";

/**
 * Implementation of {@link ListBlobs} over the distilled `storage-blob` data
 * plane (`ListContainerBlobFlatSegment`). Grants **Storage Blob Data
 * Reader** (`blobs/read`) on the container.
 *
 * @layer
 * @provides Azure.Storage.ListBlobs
 */
export const ListBlobsHttp = Layer.effect(
  ListBlobs,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.ListBlobs",
    operation: blob.ListContainerBlobFlatSegment,
    role: BlobRoles.Reader,
  }),
);
