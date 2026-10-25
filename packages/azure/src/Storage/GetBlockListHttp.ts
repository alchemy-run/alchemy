import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { GetBlockList } from "./GetBlockList.ts";

/**
 * Implementation of {@link GetBlockList} over the distilled `storage-blob`
 * data plane (`BlockBlobGetBlockList`). Grants **Storage Blob Data Reader**
 * (`blobs/read`) on the container.
 *
 * @layer
 * @provides Azure.Storage.GetBlockList
 */
export const GetBlockListHttp = Layer.effect(
  GetBlockList,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.GetBlockList",
    operation: blob.BlockBlobGetBlockList,
    role: BlobRoles.Reader,
  }),
);
