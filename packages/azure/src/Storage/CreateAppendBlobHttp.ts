import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { CreateAppendBlob } from "./CreateAppendBlob.ts";

/**
 * Implementation of {@link CreateAppendBlob} over the distilled
 * `storage-blob` data plane (`CreateAppendBlob`). Grants a custom role with
 * only `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.CreateAppendBlob
 */
export const CreateAppendBlobHttp = Layer.effect(
  CreateAppendBlob,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.CreateAppendBlob",
    operation: blob.CreateAppendBlob,
    role: BlobRoles.Writer,
  }),
);
