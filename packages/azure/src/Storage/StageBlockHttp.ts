import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { StageBlock } from "./StageBlock.ts";

/**
 * Implementation of {@link StageBlock} over the distilled `storage-blob`
 * data plane (`BlockBlobStageBlock`). Grants a custom role with only
 * `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.StageBlock
 */
export const StageBlockHttp = Layer.effect(
  StageBlock,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.StageBlock",
    operation: blob.BlockBlobStageBlock,
    role: BlobRoles.Writer,
  }),
);
