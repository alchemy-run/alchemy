import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { UpdatePageBlobSequenceNumber } from "./UpdatePageBlobSequenceNumber.ts";

/**
 * Implementation of {@link UpdatePageBlobSequenceNumber} over the distilled
 * `storage-blob` data plane (`UpdatePageBlobSequenceNumber`). Grants a
 * custom role with only `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.UpdatePageBlobSequenceNumber
 */
export const UpdatePageBlobSequenceNumberHttp = Layer.effect(
  UpdatePageBlobSequenceNumber,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.UpdatePageBlobSequenceNumber",
    operation: blob.UpdatePageBlobSequenceNumber,
    role: BlobRoles.Writer,
  }),
);
