import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { DownloadBlob } from "./DownloadBlob.ts";

/**
 * Implementation of {@link DownloadBlob} over the distilled `storage-blob`
 * data plane (`DownloadBlob`). Grants **Storage Blob Data Reader**
 * (`blobs/read`) on the container.
 *
 * @layer
 * @provides Azure.Storage.DownloadBlob
 */
export const DownloadBlobHttp = Layer.effect(
  DownloadBlob,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.DownloadBlob",
    operation: blob.DownloadBlob,
    role: BlobRoles.Reader,
  }),
);
