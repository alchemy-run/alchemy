import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { AbortCopyBlob } from "./AbortCopyBlob.ts";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";

/**
 * Implementation of {@link AbortCopyBlob} over the distilled `storage-blob`
 * data plane (`BlobAbortCopyFromURL`). Grants a custom role with only
 * `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.AbortCopyBlob
 */
export const AbortCopyBlobHttp = Layer.effect(
  AbortCopyBlob,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.AbortCopyBlob",
    operation: blob.BlobAbortCopyFromURL,
    role: BlobRoles.Writer,
  }),
);
