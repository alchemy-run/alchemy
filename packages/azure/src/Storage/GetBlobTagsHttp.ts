import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { GetBlobTags } from "./GetBlobTags.ts";

/**
 * Implementation of {@link GetBlobTags} over the distilled `storage-blob`
 * data plane (`GetBlobTags`). Grants a custom role with only
 * `blobs/tags/read` on the container.
 *
 * @layer
 * @provides Azure.Storage.GetBlobTags
 */
export const GetBlobTagsHttp = Layer.effect(
  GetBlobTags,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.GetBlobTags",
    operation: blob.GetBlobTags,
    role: BlobRoles.TagReader,
  }),
);
