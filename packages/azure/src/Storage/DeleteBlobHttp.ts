import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { DeleteBlob } from "./DeleteBlob.ts";

/**
 * Implementation of {@link DeleteBlob} over the distilled `storage-blob`
 * data plane (`DeleteBlob`). Grants a custom role with only `blobs/delete`
 * on the container.
 *
 * @layer
 * @provides Azure.Storage.DeleteBlob
 */
export const DeleteBlobHttp = Layer.effect(
  DeleteBlob,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.DeleteBlob",
    operation: blob.DeleteBlob,
    role: BlobRoles.Deleter,
  }),
);
