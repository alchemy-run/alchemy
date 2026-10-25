import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { AppendBlock } from "./AppendBlock.ts";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";

/**
 * Implementation of {@link AppendBlock} over the distilled `storage-blob`
 * data plane (`BlockAppendBlobAppend`). Grants a custom role with only
 * `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.AppendBlock
 */
export const AppendBlockHttp = Layer.effect(
  AppendBlock,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.AppendBlock",
    operation: blob.BlockAppendBlobAppend,
    role: BlobRoles.Writer,
  }),
);
