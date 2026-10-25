import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { StartCopyBlob } from "./StartCopyBlob.ts";

/**
 * Implementation of {@link StartCopyBlob} over the distilled `storage-blob`
 * data plane (`BlobStartCopyFromURL`). Grants a custom role with only
 * `blobs/read` and `blobs/write` (the source must be in the same container,
 * or be public or carry a SAS) on the container.
 *
 * @layer
 * @provides Azure.Storage.StartCopyBlob
 */
export const StartCopyBlobHttp = Layer.effect(
  StartCopyBlob,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.StartCopyBlob",
    operation: blob.BlobStartCopyFromURL,
    role: BlobRoles.Copier,
  }),
);
