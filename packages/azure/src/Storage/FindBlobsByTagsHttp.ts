import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { FindBlobsByTags } from "./FindBlobsByTags.ts";

/**
 * Implementation of {@link FindBlobsByTags} over the distilled
 * `storage-blob` data plane (`ContainerFilterBlobs`). Grants a custom role
 * with only `blobs/filter/action` on the container.
 *
 * @layer
 * @provides Azure.Storage.FindBlobsByTags
 */
export const FindBlobsByTagsHttp = Layer.effect(
  FindBlobsByTags,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.FindBlobsByTags",
    operation: blob.ContainerFilterBlobs,
    role: BlobRoles.TagFilter,
  }),
);
