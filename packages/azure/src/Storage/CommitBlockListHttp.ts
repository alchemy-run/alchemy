import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { CommitBlockList } from "./CommitBlockList.ts";

/**
 * Implementation of {@link CommitBlockList} over the distilled
 * `storage-blob` data plane (`ListBlockBlobCommitBlock`). Grants a custom
 * role with only `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.CommitBlockList
 */
export const CommitBlockListHttp = Layer.effect(
  CommitBlockList,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.CommitBlockList",
    operation: blob.ListBlockBlobCommitBlock,
    role: BlobRoles.Writer,
  }),
);
