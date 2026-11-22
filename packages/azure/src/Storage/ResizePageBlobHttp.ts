import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { ResizePageBlob } from "./ResizePageBlob.ts";

/**
 * Implementation of {@link ResizePageBlob} over the distilled `storage-blob`
 * data plane (`ResizePageBlob`). Grants a custom role with only
 * `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.ResizePageBlob
 */
export const ResizePageBlobHttp = Layer.effect(
  ResizePageBlob,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.ResizePageBlob",
    operation: blob.ResizePageBlob,
    role: BlobRoles.Writer,
  }),
);
