import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { SealAppendBlob } from "./SealAppendBlob.ts";

/**
 * Implementation of {@link SealAppendBlob} over the distilled `storage-blob`
 * data plane (`SealAppendBlob`). Grants a custom role with only
 * `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.SealAppendBlob
 */
export const SealAppendBlobHttp = Layer.effect(
  SealAppendBlob,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.SealAppendBlob",
    operation: blob.SealAppendBlob,
    role: BlobRoles.Writer,
  }),
);
