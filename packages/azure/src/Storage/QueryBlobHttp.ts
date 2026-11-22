import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { QueryBlob } from "./QueryBlob.ts";

/**
 * Implementation of {@link QueryBlob} over the distilled `storage-blob` data
 * plane (`BlobQuery`). Grants **Storage Blob Data Reader** (`blobs/read`) on
 * the container.
 *
 * @layer
 * @provides Azure.Storage.QueryBlob
 */
export const QueryBlobHttp = Layer.effect(
  QueryBlob,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.QueryBlob",
    operation: blob.BlobQuery,
    role: BlobRoles.Reader,
  }),
);
