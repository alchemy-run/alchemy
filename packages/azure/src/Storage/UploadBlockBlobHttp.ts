import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { UploadBlockBlob } from "./UploadBlockBlob.ts";

/**
 * Implementation of {@link UploadBlockBlob} over the distilled
 * `storage-blob` data plane (`UploadBlockBlob`). Grants a custom role with
 * only `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.UploadBlockBlob
 */
export const UploadBlockBlobHttp = Layer.effect(
  UploadBlockBlob,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.UploadBlockBlob",
    operation: blob.UploadBlockBlob,
    role: BlobRoles.Writer,
  }),
);
