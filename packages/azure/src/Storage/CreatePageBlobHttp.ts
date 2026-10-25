import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { CreatePageBlob } from "./CreatePageBlob.ts";

/**
 * Implementation of {@link CreatePageBlob} over the distilled `storage-blob`
 * data plane (`CreatePageBlob`). Grants a custom role with only
 * `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.CreatePageBlob
 */
export const CreatePageBlobHttp = Layer.effect(
  CreatePageBlob,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.CreatePageBlob",
    operation: blob.CreatePageBlob,
    role: BlobRoles.Writer,
  }),
);
