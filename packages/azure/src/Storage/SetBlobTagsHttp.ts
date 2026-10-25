import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { SetBlobTags } from "./SetBlobTags.ts";

/**
 * Implementation of {@link SetBlobTags} over the distilled `storage-blob`
 * data plane (`SetBlobTags`). Grants a custom role with only
 * `blobs/tags/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.SetBlobTags
 */
export const SetBlobTagsHttp = Layer.effect(
  SetBlobTags,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.SetBlobTags",
    operation: blob.SetBlobTags,
    role: BlobRoles.TagWriter,
  }),
);
